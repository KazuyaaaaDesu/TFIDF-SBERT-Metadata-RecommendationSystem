import threading
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.database import SessionLocal
from app.models.models import Paper

from app.services.bib_extraction import extract_metadata_from_bib
from app.services.classification import classify_paper
from app.services.enrichment_queue import enqueue_paper_enrichment
from app.services.extraction import extract_metadata_from_pdf
from app.services.latex_extraction import extract_metadata_from_tex
from app.services.ris_enw_extraction import (
    extract_metadata_from_enw,
    extract_metadata_from_ris,
)
from app.services.text_preparation import refresh_prepared_text
from app.services.validation import validate_paper
from app.services.storage import save_paper_file
from app.services.pdf_finder import (
    find_pdf_candidates,
    download_and_attach_pdf,
    MIN_CONFIDENCE,
    PdfCandidate,
)
from app.services.metadata_enrichment import (
    enrich_paper_metadata,
    is_title_corrupted,
)
from app.services.duplicate_detection import (
    DuplicatePaperError,
    find_duplicate_paper,
)


def _refresh_recommendation_fields(paper: Paper) -> None:
    """Prepare the text used by the recommendation pipeline."""
    try:
        refresh_prepared_text(paper)
    except Exception as exc:
        print(
            f"WARNING: Could not prepare recommendation text: {exc}"
        )


def _needs_enrichment(paper: Paper) -> bool:
    """
    True when at least one of the four recommendation-required fields
    is missing/unusable, or the title looks corrupted -- i.e. there's
    actually something for enrichment to fix. Used to skip the network
    round-trip entirely for papers that already extracted cleanly.
    """
    if is_title_corrupted(paper.title):
        return True

    if not paper.abstract or len(paper.abstract.strip()) < 40:
        return True

    if paper.publication_year is None:
        return True

    if not paper.author:
        return True

    return False


def _try_enrich_from_pdf_discovery(
    paper: Paper,
    force_search: bool = False,
) -> list[PdfCandidate]:
    """
    Best-effort automatic metadata enrichment: runs the same PDF-
    discovery lookup used by "Find PDF Online" (Unpaywall, Crossref,
    Semantic Scholar, arXiv, OpenAlex) on every upload, right after
    validation, instead of only when a user manually clicks Find PDF.

    Returns the candidate list it found (possibly empty), so callers
    -- specifically _try_auto_attach_pdf() below -- can reuse it
    instead of searching again from scratch.

    Deliberately conservative:
        - Skipped entirely if the paper already looks complete
          (_needs_enrichment), so a clean upload costs nothing extra
          -- unless force_search=True, which the background worker
          uses for papers with no stored file at all (identifier
          imports): those need discovery purely to find a PDF, even
          when every field is already filled.
        - Skipped if there's no title to search with.
        - Never raises. A network hiccup here must never fail the
          upload itself.

    validate_paper() and refresh_prepared_text() are re-run afterward
    only if enrich_paper_metadata() actually changed something.
    """
    if not force_search and not _needs_enrichment(paper):
        return []

    if not paper.title:
        return []

    try:
        candidates = find_pdf_candidates(paper)
        changed_fields = enrich_paper_metadata(paper, candidates)

        if changed_fields:
            print(
                f"INFO: Metadata enrichment filled {changed_fields} "
                f"for {paper.source_filename!r}"
            )

            # Re-classify with the recovered text (fill-only): a bib
            # import classified on title alone may improve once the
            # abstract/author arrive from discovery.
            classify_paper(paper)

            validate_paper(paper)
            refresh_prepared_text(paper)

        return candidates

    except Exception as exc:
        print(f"WARNING: Metadata enrichment failed: {exc}")
        return []


def _try_auto_attach_pdf(
    paper: Paper,
    candidates: list[PdfCandidate],
) -> bool:
    """
    Best-effort automatic PDF attachment for papers that were imported
    from a citation only (BibTeX / Google Scholar URL) and therefore
    have no real PDF file -- only the original .bib text is stored.

    Reuses the candidate list PDF discovery already found during
    enrichment (_try_enrich_from_pdf_discovery), rather than searching
    again, since every source in pdf_finder.py was already queried
    once for this paper.

    Only attaches when:
        - the paper doesn't already have a stored PDF
        - at least one candidate exists
        - the best candidate meets the same confidence bar the manual
          "Find PDF Online" flow already trusts (MIN_CONFIDENCE)

    Requires paper.id to already exist (i.e. must run after the first
    commit), since download_and_attach_pdf() names the file
    "{paper_id}.pdf". Never raises -- same conservative contract as
    enrichment: a failed download must not break the upload, since the
    paper is already safely stored with its original .bib file.

    Returns True if a PDF was attached (caller should re-commit).
    """
    if paper.stored_path and paper.stored_path.lower().endswith(".pdf"):
        return False  # already has a real PDF

    if not candidates:
        return False

    # candidates is already sorted by confidence, descending
    # (see find_pdf_candidates() in pdf_finder.py)
    best = candidates[0]

    if best.confidence < MIN_CONFIDENCE:
        return False

    try:
        stored_path = download_and_attach_pdf(
            paper_id=paper.id,
            url=best.url,
            expected_title=paper.title,
            expected_doi=paper.doi,
        )

        paper.stored_path = stored_path

        print(
            f"INFO: Auto-attached PDF for paper id={paper.id} "
            f"from {best.source} (confidence {best.confidence:.2f})"
        )

        return True

    except Exception as exc:
        print(
            f"WARNING: Automatic PDF attachment failed for "
            f"paper id={paper.id}: {exc}"
        )
        return False


# Imports that run at the same moment (Approve all, two tabs) must not
# both pass the duplicate check before either has committed.
IMPORT_LOCK = threading.Lock()

EXTRACTION_METHODS = {
    ".pdf": "pdf",
    ".bib": "bibtex",
    ".tex": "latex",
    ".ris": "ris",
    ".enw": "endnote",
}

# The years the review form accepts for a publication year.
MIN_PUBLICATION_YEAR = 1400
MAX_PUBLICATION_YEAR = datetime.now().year + 1

# Fields a reviewer may correct before saving (the Upload form's fields).
REVIEWED_FIELDS = (
    "title",
    "author",
    "abstract",
    "keywords",
    "publication_year",
    "doi",
    "subject_category",
    "document_type",
    "citation_count",
)


def extract_metadata(source_path: str, extension: str) -> dict:
    """Run the extractor that matches the file type."""

    extractors = {
        ".pdf": extract_metadata_from_pdf,
        ".tex": extract_metadata_from_tex,
        ".ris": extract_metadata_from_ris,
        ".enw": extract_metadata_from_enw,
        ".bib": extract_metadata_from_bib,
    }

    return extractors[extension](source_path) or {}


def build_paper(
    metadata: dict,
    filename: str | None,
    extension: str,
    reviewed: dict | None = None,
) -> Paper:
    """
    An unsaved Paper from extracted metadata, with the reviewer's
    corrections laid over it. A reviewed value of None means "not
    provided" (the extracted value stands); an empty string means the
    reviewer cleared the field. Used by the preview and the real import so
    the two can never drift apart.
    """

    merged = dict(metadata)

    for field, value in (reviewed or {}).items():
        if field in REVIEWED_FIELDS and value is not None:
            merged[field] = value.strip() or None if isinstance(value, str) else value

    return Paper(
        title=merged.get("title"),
        author=merged.get("author"),
        abstract=merged.get("abstract"),
        keywords=merged.get("keywords"),
        keywords_source=merged.get("keywords_source"),
        keywords_generated=merged.get("keywords_generated", False),
        publication_year=merged.get("publication_year"),
        doi=merged.get("doi"),
        citation_count=merged.get("citation_count"),
        subject_category=merged.get("subject_category"),
        document_type=merged.get("document_type"),
        source_filename=filename,
        extraction_method=EXTRACTION_METHODS[extension],
    )


def upload_paper(
    db: Session,
    source_path: str,
    original_filename: str | None = None,
    reviewed: dict | None = None,
) -> Paper:
    """
    Import a PDF, BibTeX, or LaTeX (.tex) file into the repository.

    PDF:
        Uses the existing PDF extraction pipeline. extraction.py also
        reads a DOI directly off the PDF's own text.

    BibTeX:
        Uses the BibTeX parser, followed by best-effort metadata
        enrichment AND automatic PDF attachment when a confident
        open-access match exists -- so a citation-only import ends up
        with a real PDF file instead of just the original .bib text,
        whenever one can be found.

    LaTeX (.tex):
        Uses latex_extraction.py, which reads Title/Abstract/
        Keywords/Year directly from LaTeX source commands -- more
        reliable than PDF layout guessing when a .tex source exists.

    RIS (.ris) and EndNote (.enw):
        The tagged-line formats exported by Google Scholar's Cite
        dialog (RefMan / RefWorks and EndNote) and by reference
        managers. ris_enw_extraction.py reads the first record with
        the same contract as the BibTeX parser; enrichment and PDF
        attachment then apply exactly as for BibTeX imports.

    All:
        Metadata enrichment and automatic PDF attachment (the old
        Steps 5b/8b) no longer run inline -- they are the only
        network-bound steps in this flow and now run on the
        background enrichment queue after this function commits and
        returns (see enrichment_queue.py and enrich_saved_paper()
        below). The record is complete without them; they only fill
        what's missing.
    """

    source = Path(source_path)

    if not source.exists():
        raise FileNotFoundError(
            f"Source file does not exist: {source}"
        )

    if not source.is_file():
        raise ValueError(
            f"Source path is not a file: {source}"
        )

    extension = source.suffix.lower()

    if extension not in {".pdf", ".bib", ".tex", ".ris", ".enw"}:
        raise ValueError(
            "Only PDF, BibTeX (.bib), RIS (.ris), EndNote (.enw), "
            "and LaTeX (.tex) files are supported."
        )

    filename = original_filename or source.name

    # ---------------------------------------------------------
    # STEP 1 — Extract metadata, then lay the reviewer's corrections
    #          over it (so a save is one atomic step, not an upload
    #          followed by a separate edit)
    # ---------------------------------------------------------

    metadata = extract_metadata(str(source), extension)
    paper = build_paper(metadata, filename, extension, reviewed)

    with IMPORT_LOCK:
        # -----------------------------------------------------
        # STEP 2 — Reject an existing paper before creating a new row
        #          (checked on what will actually be saved)
        # -----------------------------------------------------
        duplicate = find_duplicate_paper(
            db,
            title=paper.title,
            doi=paper.doi,
        )

        if duplicate is not None:
            raise DuplicatePaperError(duplicate)

        return _finish_import(db, paper, source)


def _finish_import(db: Session, paper: Paper, source: Path) -> Paper:
    """Classify, validate, store, and hand off to enrichment. Holds the import lock."""

    # ---------------------------------------------------------
    # STEP 4 — Classification
    # ---------------------------------------------------------

    try:
        classify_paper(paper)
    except Exception as exc:
        print(
            f"WARNING: Paper classification failed: {exc}"
        )

    # ---------------------------------------------------------
    # STEP 5 — Validation
    # ---------------------------------------------------------

    try:
        validate_paper(paper)
    except Exception as exc:
        print(
            f"WARNING: Paper validation failed: {exc}"
        )

    # ---------------------------------------------------------
    # STEP 5b — DEFERRED
    #
    # Metadata enrichment (the old "thorough" path) used to run here,
    # before the first commit. It is the first of two network-bound
    # steps in this flow -- up to six HTTP sources with retries -- so
    # it now runs on the background enrichment queue after this
    # function returns. enrich_saved_paper() below performs the same
    # enrichment on its own session once the paper is committed.
    # ---------------------------------------------------------

    # ---------------------------------------------------------
    # STEP 6 — Prepare recommendation text
    # ---------------------------------------------------------

    _refresh_recommendation_fields(paper)

    # ---------------------------------------------------------
    # STEP 7 — Save database record
    #
    # paper.id is assigned here. Automatic PDF attachment (Step 8b)
    # must run after this, because download_and_attach_pdf() needs
    # paper.id to name the stored file.
    # ---------------------------------------------------------

    try:
        db.add(paper)
        db.commit()
        db.refresh(paper)

    except Exception:
        db.rollback()
        raise

    # ---------------------------------------------------------
    # STEP 8 — Save physical file (original source: PDF or .bib)
    # ---------------------------------------------------------

    try:
        stored_path = save_paper_file(
            paper_id=paper.id,
            source_path=str(source),
        )

        paper.stored_path = stored_path

        db.commit()
        db.refresh(paper)

    except Exception:
        db.rollback()

        try:
            db.delete(paper)
            db.commit()
        except Exception:
            db.rollback()

        raise

    # ---------------------------------------------------------
    # STEP 8b — DEFERRED
    #
    # Automatic PDF attachment for citation-only imports (.bib /
    # Google Scholar / .tex) used to run here, blocking the request
    # on a download. It now runs in the background worker together
    # with enrichment, guarded by the per-paper attachment lock so it
    # can never race an explicit attach-pdf request on the same file
    # (see attachment_lock.py).
    # ---------------------------------------------------------

    # ---------------------------------------------------------
    # STEP 9 — Hand off to the background enrichment queue
    #
    # At this point the paper record and its source file are both
    # committed -- the import itself is finished and durable. What
    # remains is best-effort network work.
    # ---------------------------------------------------------

    enqueue_paper_enrichment(paper.id)

    return paper


def enrich_saved_paper(paper_id: int) -> bool:
    """
    Background half of upload_paper() -- runs after the record is
    committed, on its own session and worker thread (the caller's
    Session must never be shared across threads).

    Performs the same two steps the old inline Steps 5b and 8b did:

        1. Metadata enrichment from PDF-discovery results. By design
           enrich_paper_metadata() only fills missing/corrupt fields
           and never overwrites good data, so it is safe if the user
           has already edited the paper in the meantime.
        2. Automatic open-access PDF attachment for citation-only
           imports (extraction_method bibtex/latex), serialized with
           any explicit attach-pdf request via attachment_lock().

    Returns True when something on the paper actually changed.
    """
    from app.services.attachment_lock import attachment_lock

    db = SessionLocal()

    try:
        paper = (
            db.query(Paper)
            .filter(Paper.id == paper_id)
            .first()
        )

        if paper is None:
            return False

        # ------------------------------------------------------
        # 1. Enrichment (network-bound, best-effort, never raises
        #    out of _try_enrich_from_pdf_discovery). The candidate
        #    list it searched for is reused below for auto-attach.
        #
        #    force_search for papers with NO stored file (identifier
        #    imports): even a fully complete record needs discovery
        #    to get an openable PDF.
        # ------------------------------------------------------

        candidates = _try_enrich_from_pdf_discovery(
            paper,
            force_search=not paper.stored_path,
        )

        changed = bool(db.dirty)

        if changed:
            db.commit()

        # ------------------------------------------------------
        # 2. Auto-attach for citation-only imports (no real PDF of
        #    their own: .bib / .tex / metadata-only). The check
        #    inside _try_auto_attach_pdf() makes this a no-op for
        #    papers that already store a PDF.
        # ------------------------------------------------------

        if paper.extraction_method in {
            "bibtex",
            "latex",
            "ris",
            "endnote",
            "metadata",
        }:
            with attachment_lock(paper_id):
                # Re-read after acquiring: the user's explicit
                # attach-pdf request may have won the race while
                # we waited -- _try_auto_attach_pdf() then sees the
                # stored .pdf and no-ops.
                try:
                    db.refresh(paper)

                except Exception:
                    # The paper was deleted while enrichment was
                    # running, so there is nothing left to attach to.
                    print(
                        f"INFO: Paper id={paper_id} no longer exists; "
                        "skipping automatic PDF attachment."
                    )
                    return False

                if _try_auto_attach_pdf(paper, candidates):
                    db.commit()
                    changed = True

        return changed

    except StaleDataError:
        # The paper was deleted while this background job was writing to
        # it (concurrent DELETE from the UI). Nothing left to enrich --
        # swallow it instead of logging a scary traceback.
        db.rollback()
        print(
            f"INFO: Paper id={paper_id} was deleted during enrichment; "
            "discarding background changes."
        )
        return False

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


def upload_paper_from_pdf(
    db: Session,
    source_path: str,
    original_filename: str | None = None,
    reviewed: dict | None = None,
) -> Paper:
    """
    Backward-compatible wrapper for the existing API.

    The API historically called this function for PDF uploads.
    The underlying upload_paper() function now handles both
    PDF and BibTeX files.
    """

    return upload_paper(
        db=db,
        source_path=source_path,
        original_filename=original_filename,
        reviewed=reviewed,
    )


def complete_paper_manually(
    db: Session,
    paper: Paper,
    **updates,
) -> Paper:
    """
    Backward-compatible helper for manually completing
    paper metadata.

    Only supported Paper metadata fields are updated.
    Classification, validation, and recommendation text
    are refreshed after the update.
    """

    allowed_fields = {
        "title",
        "author",
        "abstract",
        "keywords",
        "publication_year",
        "doi",
        "subject_category",
        "document_type",
        "citation_count",
    }

    for field, value in updates.items():
        if field in allowed_fields:
            setattr(paper, field, value)

    # A structured author edit (given / middle / family). The model's
    # flush hook rebuilds the display string from these parts, and they
    # win over a plain ``author`` sent in the same request.
    if updates.get("authors") is not None:
        from app.models.models import _author_rows
        from app.services.author_names import AuthorName

        names = [
            AuthorName(
                (part.get("given") if isinstance(part, dict) else part.given) or "",
                (part.get("middle") if isinstance(part, dict) else part.middle) or "",
                (part.get("family") if isinstance(part, dict) else part.family) or "",
                (part.get("suffix") if isinstance(part, dict) else part.suffix) or "",
            )
            for part in updates["authors"]
        ]
        names = [
            AuthorName(*(piece.strip() for piece in (n.given, n.middle, n.family, n.suffix)))
            for n in names
            if (n.given or n.middle or n.family).strip()
        ]
        paper.authors = _author_rows(names)

    # ---------------------------------------------------------
    # Re-run classification after metadata changes
    # ---------------------------------------------------------

    try:
        classify_paper(paper)
    except Exception as exc:
        print(
            f"WARNING: Paper classification failed: {exc}"
        )

    # ---------------------------------------------------------
    # Re-run validation after metadata changes
    # ---------------------------------------------------------

    try:
        validate_paper(paper)
    except Exception as exc:
        print(
            f"WARNING: Paper validation failed: {exc}"
        )

    # ---------------------------------------------------------
    # Rebuild recommendation text
    # ---------------------------------------------------------

    _refresh_recommendation_fields(paper)

    # ---------------------------------------------------------
    # Save changes
    # ---------------------------------------------------------

    try:
        db.add(paper)
        db.commit()
        db.refresh(paper)

    except Exception:
        db.rollback()
        raise

    return paper

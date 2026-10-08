import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit
from pathlib import Path

import requests
from fastapi import FastAPI, Depends, Form, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError

from app.database import engine, init_db, get_session, SessionLocal
from app.models.models import Paper, PersonalLibrary, BattleRun, Announcement, User
from app.services.catalog import (
    DEFAULT_CATEGORIES,
    DEFAULT_DOCUMENT_TYPES,
    DEFAULT_SUBJECTS,
    merge_defaults,
)
from app.repositories.queries import filter_papers

from app.services.fts_search import ensure_fts_index

from app.services.upload_paper import (
    IMPORT_LOCK,
    MAX_PUBLICATION_YEAR,
    REVIEWED_FIELDS,
    MIN_PUBLICATION_YEAR,
    build_paper,
    extract_metadata,
    upload_paper_from_pdf,
    complete_paper_manually,
)
from app.services.bib_extraction import extract_metadata_from_bib
from app.services.ris_enw_extraction import (
    extract_metadata_from_enw,
    extract_metadata_from_ris,
)
from app.services.extraction import extract_metadata_from_pdf
from app.services.latex_extraction import extract_metadata_from_tex
from app.services.classification import classify_paper
from app.services.validation import validate_paper
from app.services.duplicate_detection import (
    DuplicatePaperError,
    find_duplicate_paper,
)
from app.services.citations import (
    clustered_works,
    refresh_paper_citations,
)
from app.services.web_connections import (
    fetch_web_neighborhood,
    resolve_work_titles,
)
from app.services.attachment_lock import attachment_lock
from app.services.enrichment_queue import (
    get_enrichment_status,
    enqueue_paper_enrichment,
)
from app.services.identifier_resolver import (
    resolve_identifier,
    IdentifierLookupError,
)
from app.services.metadata_enrichment import generate_keywords_if_missing
from app.services.web_search import (
    search_web,
    VALID_SORTS as WEB_SEARCH_SORTS,
    WebSearchError,
)
from app.services.connected_graph import build_connected_graph
from app.services.text_preparation import refresh_prepared_text

from app.services.storage import (
    delete_paper_file,
    get_paper_file_path,
)

from app.services.local_user import get_or_create_default_user

from app.services.recommendation.search_service import (
    search_papers as run_search,
)
from app.services.recommendation.pipeline_config import build_custom_weights

from app.services.recommendation.trace_service import (
    RecommendationTraceRequest,
    RecommendationTraceResponse,
    run_traced_search,
)

from app.services.recommendation.compare_service import (
    CompareRequest,
    CompareResponse,
    compare_pipelines,
    compare_web_results,
    rank_web_results,
)

from app.services.url_safety import UnsafeUrlError, assert_public_http_url, safe_get
from app.services.pdf_finder import (
    find_pdf_candidates,
    download_and_attach_pdf,
)

from app.schemas import (
    PaperOut,
    PaperUpdate,
    RepositoryStats,
    LibraryEntryOut,
    SearchResultOut as SearchResultOutBase,
    PdfCandidateOut,
    AttachPdfRequest,
    IdentifierLookupRequest,
    MetadataImportRequest,
    AdminLoginIn,
    AdminTokenOut,
    AdminMeOut,
    AdminPasswordChange,
    AnnouncementIn,
    AnnouncementUpdate,
    AnnouncementOut,
    LibraryFeaturesOut,
    LibraryFeaturesIn,
    PaperIdsIn,
    RenameFilesIn,
    MarkPapersIn,
)

from app.services.merge_duplicates import merge_group

from app.services.admin_auth import (
    create_admin_token,
    ensure_admin_user,
    hash_password,
    verify_admin_token,
    verify_password,
)
from app.services.site_config import (
    get_library_features,
    set_library_features,
)

from app.services.research_chat import (
    ResearchChatRequest,
    ResearchChatResponse,
    answer_research_question,
)
from app.services.chat_suggestions import (
    SuggestionRequest,
    SuggestionResponse,
    suggest_followups,
)

app = FastAPI(title="Re:Search API")


# ============================================================
# RECOMMENDATION INDEX STATUS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

RECOMMENDATION_STATUS_PATH = (
    PROJECT_ROOT
    / "storage"
    / "recommendation_index_status.json"
)


def get_recommendation_index_status() -> bool:
    """
    Returns True when the recommendation index needs to be rebuilt.
    """

    if not RECOMMENDATION_STATUS_PATH.exists():
        return False

    try:
        with open(
            RECOMMENDATION_STATUS_PATH,
            "r",
            encoding="utf-8",
        ) as file:
            data = json.load(file)

        return bool(data.get("stale", False))

    except Exception:
        return False


def set_recommendation_index_stale(stale: bool):
    """
    Persist whether the recommendation index is stale.
    """

    RECOMMENDATION_STATUS_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        RECOMMENDATION_STATUS_PATH,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            {"stale": stale},
            file,
            indent=2,
        )


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://hybridresearch.netlify.app"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# STARTUP
# ============================================================

@app.on_event("startup")
def startup():
    init_db()

    # Library Mode: make sure the site-editor account and the default
    # feature states exist before the first request.
    _seed_library_site()

    # P1-A: ranked repository search uses an FTS5 index. It is purely
    # an optimization, so a failure here must never stop the app from
    # booting -- search falls back to the legacy ILIKE path instead.
    try:
        if not ensure_fts_index(engine):
            logging.getLogger(__name__).warning(
                "SQLite build has no FTS5 support; repository search "
                "will use the ILIKE fallback."
            )
    except Exception as error:
        logging.getLogger(__name__).warning(
            "FTS5 index setup failed; repository search will use the "
            "ILIKE fallback: %s",
            error,
        )

    # Pre-load the S-BERT model on a background thread so the first
    # recommendation request doesn't pay the load cost (and so the load
    # itself happens outside any request's DB session).
    def _warm_up():
        try:
            from app.services.recommendation.sbert_pipeline import (
                warm_up_model,
            )

            warm_up_model()
        except Exception as error:
            print(f"S-BERT model warm-up failed: {error}")

    threading.Thread(
        target=_warm_up,
        name="sbert-warmup",
        daemon=True,
    ).start()


# ============================================================
# FILE HELPERS
# ============================================================

def resolve_stored_file(stored_path: str | None) -> Path:
    """
    Convert the database stored path such as:

        papers/60.pdf

    into the actual storage path:

        storage/papers/60.pdf
    """

    if not stored_path:
        raise HTTPException(
            status_code=404,
            detail="Paper file not found.",
        )

    path = Path(get_paper_file_path(stored_path))

    if not path.exists() or not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Paper file not found.",
        )

    return path


# ============================================================
# RECOMMENDATION REBUILD
# ============================================================

def rebuild_recommendation_data():
    """
    Rebuild classification, validation, TF-IDF and S-BERT
    recommendation data after repository changes.
    """

    script_path = (
        Path(__file__).resolve().parent.parent
        / "scripts"
        / "rebuild_recommendation.py"
    )

    if not script_path.exists():
        raise FileNotFoundError(
            "Recommendation rebuild script not found."
        )

    # stdout streams live to the server log (progress output stays
    # visible); stderr goes to a temp file so a non-zero exit -- what
    # used to surface as a featureless 500 -- carries the script's own
    # traceback.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as err_file:
        result = subprocess.run(
            [
                sys.executable,
                str(script_path),
            ],
            check=False,
            stderr=err_file,
            cwd=str(script_path.parent.parent),
        )

        if result.returncode != 0:
            err_file.seek(0)
            stderr_tail = err_file.read()[-2000:]
            print(stderr_tail)

            raise RuntimeError(
                f"rebuild_recommendation.py exited with code "
                f"{result.returncode}: {stderr_tail.strip()}"
            )


# ============================================================
# RECOMMENDATION INDEX STATUS
# ============================================================

@app.get("/api/recommendations/status")
def recommendation_status():
    return {
        "stale": get_recommendation_index_status(),
    }


# ============================================================
# PAPERS
# ============================================================

class PaperListOut(PaperOut):
    """
    PaperOut plus the optional FTS relevance snippet and the count
    of near-duplicate records collapsed out of a relevance result
    list.

    Only the repository list endpoint returns this model; the extra
    fields are additive, so existing clients can ignore them.
    """

    snippet: str | None = Field(
        default=None,
        validation_alias="search_snippet",
    )

    duplicate_count: int = 0


@app.get(
    "/api/papers",
    response_model=list[PaperListOut],
)
def list_papers(
    search: str | None = None,
    subject: str | None = None,
    category: str | None = None,
    document_type: str | None = None,
    min_year: int | None = None,
    max_year: int | None = None,
    sort_by: str | None = None,
    limit: int | None = None,
    db: Session = Depends(get_session),
):
    papers = filter_papers(
        db,
        search=search,
        subject=subject,
        category=category,
        document_type=document_type,
        min_year=min_year,
        max_year=max_year,
        sort_by=sort_by,
    )

    if limit is not None:
        papers = papers[:limit]

    return papers


# ============================================================
# REPOSITORY STATS
# ============================================================

@app.get(
    "/api/papers/stats",
    response_model=RepositoryStats,
)
def get_repository_stats(
    db: Session = Depends(get_session),
):
    subject_expr = func.coalesce(
        func.nullif(Paper.subject_category, ""),
        "Uncategorized",
    )
    rows = (
        db.query(subject_expr, func.count(Paper.id))
        .group_by(subject_expr)
        .order_by(func.min(Paper.id))
        .all()
    )

    by_subject: dict[str, int] = {subject: count for subject, count in rows}

    return RepositoryStats(
        total_papers=sum(by_subject.values()),
        by_subject=by_subject,
        category_count=len(by_subject),
    )


# ============================================================
# PDF VIEWER
# ============================================================

@app.get("/api/papers/{paper_id}/pdf")
def get_paper_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    stored_path = paper.stored_path

    if not stored_path:
        raise HTTPException(
            status_code=404,
            detail="Paper does not have a stored file.",
        )

    if not stored_path.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=404,
            detail="This paper does not have a PDF file.",
        )

    path = resolve_stored_file(stored_path)

    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
        },
    )


# ============================================================
# FIND PDF ONLINE
# ============================================================

@app.get(
    "/api/papers/{paper_id}/find-pdf",
    response_model=list[PdfCandidateOut],
)
def find_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Search-only step: looks for a legal open-access PDF matching this
    paper (Unpaywall, Crossref, Semantic Scholar, arXiv, OpenAlex)
    and returns candidates for the user to review.

    Metadata enrichment is also attempted using the same candidates.
    Nothing is downloaded here.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    if paper.stored_path and paper.stored_path.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="This paper already has a stored PDF.",
        )

    # --------------------------------------------------------
    # Find PDF candidates
    # --------------------------------------------------------

    try:
        candidates = find_pdf_candidates(paper)

    except Exception as error:
        print()
        print("FIND PDF FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="Could not search for a PDF right now.",
        ) from error

    # --------------------------------------------------------
    # Best-effort metadata enrichment
    # --------------------------------------------------------

    try:
        from app.services.metadata_enrichment import enrich_paper_metadata

        changed = enrich_paper_metadata(
            paper,
            candidates,
        )

        if changed:
            validate_paper(paper)
            refresh_prepared_text(paper)
            set_recommendation_index_stale(True)

    except Exception as error:
        print("WARNING: Metadata enrichment failed:")
        print(error)

    # --------------------------------------------------------
    # Persist changes made by find_pdf_candidates() or enrichment
    # --------------------------------------------------------

    if db.is_modified(paper):
        db.commit()
        db.refresh(paper)

    return [
        PdfCandidateOut(**candidate.to_dict())
        for candidate in candidates
    ]

@app.post(
    "/api/papers/{paper_id}/attach-pdf",
    response_model=PaperOut,
)
def attach_pdf(
    paper_id: int,
    payload: AttachPdfRequest,
    db: Session = Depends(get_session),
):
    """
    Confirm step: downloads the PDF at the given URL (a candidate the
    user picked from /find-pdf), verifies it, and stores it the same
    way an uploaded PDF is stored. Then runs the same metadata
    extraction the normal PDF-upload path uses on the newly downloaded
    file, backfilling whatever the paper is still missing
    (title/abstract/keywords/publication_year). A field the paper
    already has -- e.g. a title from its original BibTeX import -- is
    never overwritten.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    # --------------------------------------------------------
    # Attachment race guard
    #
    # The background enrichment queue may auto-attach a PDF for this
    # paper concurrently with this request (both start right after
    # upload). The per-paper lock serializes check + download so the
    # two can never write {paper_id}.pdf at the same time; whoever
    # gets there second re-reads stored_path and no-ops instead of
    # downloading again.
    # --------------------------------------------------------

    with attachment_lock(paper_id):
        db.refresh(paper)

        if (
            paper.stored_path
            and paper.stored_path.lower().endswith(".pdf")
        ):
            return paper

        try:
            stored_path = download_and_attach_pdf(
                paper_id,
                payload.url,
                paper.title,
                paper.doi,
            )

        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            )

        except Exception as error:

            print()
            print("ATTACH PDF FAILED")
            print(error)

            raise HTTPException(
                status_code=502,
                detail="Could not download the PDF from that link.",
            )

    paper.stored_path = stored_path

    # --------------------------------------------------------
    # Extract metadata from the file we just downloaded and use
    # it to backfill whatever the paper is still missing -- the
    # same fields a normal PDF upload extracts. A field already
    # on the paper is left alone.
    # --------------------------------------------------------

    changed_recommendation_fields = False

    try:
        full_path = get_paper_file_path(stored_path)
        extracted = extract_metadata_from_pdf(full_path)

    except Exception as error:

        print()
        print("METADATA EXTRACTION FAILED FOR ATTACHED PDF")
        print(error)

        extracted = {}

    backfill_fields = (
        "title",
        "abstract",
        "keywords",
        "publication_year",
    )

    for field in backfill_fields:
        current_value = getattr(paper, field, None)

        is_blank = (
            current_value is None
            or (
                isinstance(current_value, str)
                and not current_value.strip()
            )
        )

        extracted_value = extracted.get(field)

        if is_blank and extracted_value:
            setattr(paper, field, extracted_value)
            changed_recommendation_fields = True

            if field == "keywords":
                paper.keywords_source = extracted.get(
                    "keywords_source"
                )
                paper.keywords_generated = extracted.get(
                    "keywords_generated",
                    False,
                )

    if not paper.subject_category:
        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: classification failed after attach-pdf")
            print(error)

    try:
        validate_paper(paper)
        refresh_prepared_text(paper)
    except Exception as error:
        print("WARNING: validation/prepared-text refresh failed after attach-pdf")
        print(error)

    db.commit()
    db.refresh(paper)

    if changed_recommendation_fields:
        set_recommendation_index_stale(True)

        print(
            f"Recommendation index is stale for paper {paper.id}. "
            "Rebuild required."
        )

    return paper


# ============================================================
# BACKGROUND ENRICHMENT STATUS
# ============================================================

@app.get("/api/papers/{paper_id}/enrichment-status")
def enrichment_status(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Status of the background enrichment job enqueued when this paper
    was imported ("queued" | "running" | "done" | "failed", or "idle"
    if nothing was ever enqueued for it). Lets the frontend refresh
    the paper once enrichment has filled in its missing fields.
    """
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return {
        "paper_id": paper_id,
        "status": get_enrichment_status(paper_id) or "idle",
    }


# ============================================================
# GET SINGLE PAPER
# ============================================================

@app.get(
    "/api/papers/{paper_id}",
    response_model=PaperOut,
)
def get_paper(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return paper


# ============================================================
# UPDATE PAPER
# ============================================================

@app.patch(
    "/api/papers/{paper_id}",
    response_model=PaperOut,
)
def update_paper(
    paper_id: int,
    updates: PaperUpdate,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    update_data = updates.model_dump(
        exclude_unset=True
    )

    try:
        paper = complete_paper_manually(
            db,
            paper,
            **update_data,
        )
    except StaleDataError as error:
        # The row vanished between the lookup and the UPDATE -- the
        # paper was deleted by another request while this one edited it.
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        ) from error

    except Exception as error:
        print("PAPER METADATA UPDATE FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to update paper metadata.",
        ) from error

    set_recommendation_index_stale(True)

    return paper



# ============================================================
# DELETE PAPER
# ============================================================

@app.delete("/api/papers/{paper_id}")
def delete_paper(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    stored_path = paper.stored_path

    try:
        if stored_path:
            delete_paper_file(stored_path)

    except Exception as error:
        print("Could not delete stored paper file:")
        print(error)

    db.delete(paper)
    db.commit()

    set_recommendation_index_stale(True)

    return {
        "status": "deleted"
    }


# ============================================================
# DELETE PDF (keep the bibliographic record)
# ============================================================

@app.delete(
    "/api/papers/{paper_id}/pdf",
    response_model=PaperOut,
)
def delete_paper_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Remove only the stored PDF file (and stored_path), keeping the
    paper's metadata intact so the record can be re-attached to a
    different open-access copy later.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    if not paper.stored_path:
        raise HTTPException(
            status_code=400,
            detail="This paper has no stored file.",
        )

    try:
        delete_paper_file(paper.stored_path)
    except Exception as error:
        print("Could not delete stored PDF file:")
        print(error)

    paper.stored_path = None
    db.commit()
    db.refresh(paper)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# PREVIEW PAPER
# ============================================================

def _duplicate_summary(
    db: Session,
    paper: Paper,
) -> dict | None:
    """The stored paper this one would be rejected as a copy of, if any."""

    try:
        match = find_duplicate_paper(
            db,
            title=paper.title,
            doi=paper.doi,
        )
    except Exception as error:
        print("WARNING: Preview duplicate check failed")
        print(error)

        return None

    if match is None:
        return None

    return {"id": match.id, "title": match.title}


def _paper_preview_payload(
    paper: Paper,
    pdf_candidates: list,
    duplicate_of: dict | None = None,
) -> dict:
    """
    The shared preview response shape: what saving this paper would
    persist, plus any discovered PDF candidates. Used by both the
    file preview and the identifier (DOI/arXiv) preview so the two
    flows can never drift apart.
    """
    return {
        "title": paper.title,
        "author": paper.author,
        "abstract": paper.abstract,
        "keywords": paper.keywords,
        "publication_year": paper.publication_year,
        "doi": paper.doi,
        "subject_category": paper.subject_category,
        "document_type": paper.document_type,
        "citation_count": paper.citation_count,
        "is_valid_for_recommendation": (
            paper.is_valid_for_recommendation
        ),
        "missing_fields": paper.missing_fields,
        "source_filename": paper.source_filename,
        "extraction_method": paper.extraction_method,
        "pdf_candidates": [
            candidate.to_dict()
            for candidate in pdf_candidates
        ],
        "duplicate_of": duplicate_of,
    }


# One upload may be this big. A PDF of a thesis is a few MB; this only
# stops a runaway or hostile file from filling the disk.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

ACCEPTED_UPLOAD_SUFFIXES = (".pdf", ".bib", ".tex", ".ris", ".enw")

_ACCEPTED_FILES_MESSAGE = (
    "Only PDF, BibTeX (.bib), RIS (.ris), EndNote (.enw), "
    "and LaTeX (.tex) files are accepted."
)


def _save_upload_to_temp(file: UploadFile) -> tuple[str, str]:
    """
    Copy an uploaded file to a temp file, checking its type and size on
    the way. Returns (path, suffix); the caller removes the file.
    """

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="A filename is required.",
        )

    suffix = os.path.splitext(file.filename)[1].lower()

    if suffix not in ACCEPTED_UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=_ACCEPTED_FILES_MESSAGE,
        )

    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(
            suffix=suffix,
            delete=False,
        ) as tmp:
            tmp_path = tmp.name
            total = 0
            head = b""

            while True:
                chunk = file.file.read(1024 * 1024)

                if not chunk:
                    break

                if not head:
                    head = chunk[:1024]

                total += len(chunk)

                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "That file is too large (the limit is "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."
                        ),
                    )

                tmp.write(chunk)

        if total == 0:
            raise HTTPException(
                status_code=400,
                detail="That file is empty.",
            )

        if suffix == ".pdf" and not head.lstrip().startswith(b"%PDF-"):
            raise HTTPException(
                status_code=400,
                detail="That file is not a valid PDF.",
            )

        if suffix != ".pdf" and b"\x00" in head:
            raise HTTPException(
                status_code=400,
                detail=(
                    "That looks like a binary file, not a text "
                    f"citation ({suffix})."
                ),
            )

        return tmp_path, suffix

    except BaseException:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

        raise


@app.post("/api/papers/preview")
def preview_paper(
    file: UploadFile = File(...),
    candidates: bool = False,
    db: Session = Depends(get_session),
):
    """
    Extract and validate paper metadata without creating a database record.

    This is the first step of the upload flow. The frontend can show the
    extracted metadata for editing, while the actual database insert and
    file storage only happen through /api/papers/upload after the user
    clicks Save. The response says whether the paper is already stored
    (`duplicate_of`) so the review form can warn before saving.

    Searching the web for PDF candidates takes several seconds, so it only
    runs when asked for (`?candidates=true`); the review form does not
    need it.
    """

    tmp_path, suffix = _save_upload_to_temp(file)

    try:
        try:
            metadata = extract_metadata(tmp_path, suffix)
        except Exception as error:
            print()
            print("PAPER PREVIEW EXTRACTION FAILED")
            print(error)

            raise HTTPException(
                status_code=422,
                detail=(
                    "Could not read metadata from that file. "
                    "Check that it is a valid "
                    f"{suffix[1:].upper()} file."
                ),
            ) from error

        paper = build_paper(metadata, file.filename, suffix)

        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: Paper preview classification failed")
            print(error)

        try:
            validate_paper(paper)
        except Exception as error:
            print("WARNING: Paper preview validation failed")
            print(error)

        try:
            refresh_prepared_text(paper)
        except Exception as error:
            print("WARNING: Paper preview text preparation failed")
            print(error)

        pdf_candidates = []

        if candidates and suffix in (".bib", ".tex") and paper.title:
            try:
                pdf_candidates = find_pdf_candidates(paper)
            except Exception as error:
                print("WARNING: Paper preview PDF discovery failed")
                print(error)

        return _paper_preview_payload(
            paper,
            pdf_candidates,
            _duplicate_summary(db, paper),
        )

    except HTTPException:
        raise

    except Exception as error:
        print()
        print("PAPER PREVIEW FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to preview the paper.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ============================================================
# PREVIEW BY IDENTIFIER (DOI / arXiv / link)
# ============================================================

@app.post("/api/papers/preview-identifier")
def preview_identifier(
    payload: IdentifierLookupRequest,
    db: Session = Depends(get_session),
):
    """
    Resolve a pasted DOI, arXiv id, or link to either into the same
    preview payload POST /api/papers/preview returns for an uploaded
    file.

    Nothing is persisted and no file exists yet -- the frontend shows
    the metadata for review and only then calls POST
    /api/papers/import-metadata. Keywords are generated locally (YAKE
    on title+abstract) because identifier imports have no extraction
    step and keywords are required for recommendation validity.
    """
    try:
        resolved = resolve_identifier(payload.identifier)

    except IdentifierLookupError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        )

    if resolved is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not read that identifier. Paste a DOI "
                "(10.xxxx/...), an arXiv id (2106.03762), or a link "
                "to either."
            ),
        )

    paper = Paper(
        title=resolved.get("title"),
        author=resolved.get("author"),
        abstract=resolved.get("abstract"),
        keywords=resolved.get("keywords"),
        publication_year=resolved.get("publication_year"),
        doi=resolved.get("doi"),
        subject_category=resolved.get("subject_category"),
        document_type=resolved.get("document_type"),
        citation_count=resolved.get("citation_count"),
        source_filename=resolved.get("source_filename"),
        extraction_method="identifier",
    )

    try:
        generate_keywords_if_missing(paper)
    except Exception as error:
        print("WARNING: Identifier preview keyword generation failed")
        print(error)

    # Classify after keyword generation (the rules read keywords) so
    # the preview shows the subject/category the paper will be filed
    # under, and the Upload form can reflect it in its dropdowns.
    try:
        classify_paper(paper)
    except Exception as error:
        print("WARNING: Identifier preview classification failed")
        print(error)

    try:
        validate_paper(paper)
    except Exception as error:
        print("WARNING: Identifier preview validation failed")
        print(error)

    try:
        refresh_prepared_text(paper)
    except Exception as error:
        print("WARNING: Identifier preview text preparation failed")
        print(error)

    return _paper_preview_payload(
        paper,
        [],
        _duplicate_summary(db, paper),
    )


# ============================================================
# UPLOAD PAPER
# ============================================================

@app.post(
    "/api/papers/upload",
    response_model=PaperOut,
)
def upload_paper(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    author: str | None = Form(None),
    abstract: str | None = Form(None),
    keywords: str | None = Form(None),
    publication_year: str | None = Form(None),
    doi: str | None = Form(None),
    subject_category: str | None = Form(None),
    document_type: str | None = Form(None),
    citation_count: str | None = Form(None),
    cleared: str | None = Form(None),
    db: Session = Depends(get_session),
):
    """
    Import a PDF, BibTeX, RIS, EndNote or LaTeX file.

    The optional form fields are the reviewer's corrections from the
    Upload form; they are laid over the extracted metadata *before* the
    duplicate check and the save, so one request is one atomic import.
    A field that is omitted keeps its extracted value. Form posts cannot
    tell "left out" from "left blank", so a field the reviewer emptied is
    named in `cleared` (comma-separated) instead.
    """

    reviewed: dict = {
        "title": title,
        "author": author,
        "abstract": abstract,
        "keywords": keywords,
        "doi": doi,
        "subject_category": subject_category,
        "document_type": document_type,
    }

    for name in (cleared or "").split(","):
        name = name.strip()

        if name in REVIEWED_FIELDS:
            reviewed[name] = ""

    for name, raw in (
        ("publication_year", publication_year),
        ("citation_count", citation_count),
    ):
        if raw is None:
            continue

        cleaned = raw.strip()

        if not cleaned:
            reviewed[name] = ""
            continue

        try:
            number = int(cleaned)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"{name.replace('_', ' ').capitalize()} must be a whole number.",
            )

        if name == "publication_year" and not (
            MIN_PUBLICATION_YEAR <= number <= MAX_PUBLICATION_YEAR
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Publication year must be between "
                    f"{MIN_PUBLICATION_YEAR} and {MAX_PUBLICATION_YEAR}."
                ),
            )

        if name == "citation_count" and number < 0:
            raise HTTPException(
                status_code=422,
                detail="Citation count cannot be negative.",
            )

        reviewed[name] = number

    tmp_path, _suffix = _save_upload_to_temp(file)

    try:
        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            file.filename,
            reviewed,
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except ValueError as error:
        # An unsupported or unreadable file: say why, not just "failed".
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:

        print()
        print("PAPER UPLOAD FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the paper.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# IMPORT FROM METADATA (no source file)
# ============================================================

@app.post(
    "/api/papers/import-metadata",
    response_model=PaperOut,
)
def import_from_metadata(
    payload: MetadataImportRequest,
    db: Session = Depends(get_session),
):
    """
    Create a paper directly from reviewed metadata -- the save step
    of the "Add by identifier" flow (DOI / arXiv / link), where there
    is no source file to upload.

    Duplicate detection runs first (the same DOI/title guard the
    other import paths were always meant to have). A PDF, if wanted,
    comes from pdf_url here or from the background enrichment queue
    afterwards -- the record itself is committed either way.
    """
    title = (payload.title or "").strip()

    if not title:
        raise HTTPException(
            status_code=400,
            detail="Title is required before saving.",
        )

    if payload.publication_year is not None and not (
        MIN_PUBLICATION_YEAR <= payload.publication_year <= MAX_PUBLICATION_YEAR
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Publication year must be between "
                f"{MIN_PUBLICATION_YEAR} and {MAX_PUBLICATION_YEAR}."
            ),
        )

    if payload.citation_count is not None and payload.citation_count < 0:
        raise HTTPException(
            status_code=422,
            detail="Citation count cannot be negative.",
        )

    if payload.pdf_url:
        try:
            assert_public_http_url(payload.pdf_url)
        except UnsafeUrlError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            ) from error

    return _save_metadata_import(db, payload, title)


def _save_metadata_import(
    db: Session,
    payload: MetadataImportRequest,
    title: str,
) -> Paper:
    """Save a reviewed record; the duplicate check and insert run one at a time."""

    with IMPORT_LOCK:
        duplicate = find_duplicate_paper(
            db,
            title=title,
            doi=payload.doi,
        )

        if duplicate is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Looks like a duplicate of paper #{duplicate.id}: "
                    f"{duplicate.title}"
                ),
            )

        paper = Paper(
            title=title,
            author=(payload.author or "").strip() or None,
            abstract=(payload.abstract or "").strip() or None,
            keywords=(payload.keywords or "").strip() or None,
            publication_year=payload.publication_year,
            doi=payload.doi,
            subject_category=payload.subject_category,
            document_type=payload.document_type,
            citation_count=payload.citation_count,
            source_filename=payload.source_filename,
            extraction_method="metadata",
        )

        try:
            generate_keywords_if_missing(paper)
        except Exception as error:
            print("WARNING: Identifier import keyword generation failed")
            print(error)

        # Fill-only: assigns only when the caller didn't supply a subject
        # (web imports never do; the Upload form's dropdowns win when the
        # user picked something).
        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: Identifier import classification failed")
            print(error)

        try:
            validate_paper(paper)
        except Exception as error:
            print("WARNING: Identifier import validation failed")
            print(error)

        try:
            refresh_prepared_text(paper)
        except Exception as error:
            print("WARNING: Identifier import text preparation failed")
            print(error)

        try:
            db.add(paper)
            db.commit()
            db.refresh(paper)

        except Exception:
            db.rollback()

            raise HTTPException(
                status_code=500,
                detail="Failed to save the paper.",
            )

    # Optional explicit PDF (the user picked a candidate). Best-effort:
    # the paper is already saved, and if this fails the background
    # queue will still search for one.
    if payload.pdf_url:
        try:
            with attachment_lock(paper.id):
                db.refresh(paper)

                if not (paper.stored_path or "").lower().endswith(".pdf"):
                    paper.stored_path = download_and_attach_pdf(
                        paper.id,
                        payload.pdf_url,
                        paper.title,
                        paper.doi,
                    )
                    db.commit()
                    db.refresh(paper)

        except Exception as error:
            db.rollback()
            print("WARNING: Could not attach the provided PDF:")
            print(error)

    enqueue_paper_enrichment(paper.id)
    set_recommendation_index_stale(True)

    return paper


# ============================================================
# WEB SEARCH (OpenAlex + Crossref)
# ============================================================

@app.get("/api/search-web")
def search_web_endpoint(
    q: str,
    year_min: int | None = None,
    year_max: int | None = None,
    peer_reviewed: bool = True,
    open_access: bool = False,
    sources: str = "openalex,crossref",
    sort: str = "relevance",
    limit: int = 15,
):
    """
    Search the open scholarly web through legitimate APIs (OpenAlex
    and Crossref -- no Google Scholar scraping). Peer-reviewed
    publication types only by default; retracted works and datasets/
    patents are excluded. Results are normalized, deduplicated across
    sources, and returned with provenance so the UI can show which
    API answered.

    The frontend imports a chosen hit via POST /api/papers/
    import-metadata, which also runs duplicate detection.
    """
    query = (q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if sort not in WEB_SEARCH_SORTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"sort must be one of: {', '.join(WEB_SEARCH_SORTS)}."
            ),
        )

    requested_sources = tuple(
        source.strip()
        for source in sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv")
    )

    try:
        results = search_web(
            query,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access,
            sources=requested_sources,
            sort=sort,
            limit=max(1, min(limit, 25)),
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    except Exception as error:
        print()
        print("WEB SEARCH FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="The web search failed unexpectedly.",
        )

    return [result.to_dict() for result in results]


# ============================================================
# MANUAL REBUILD OF RECOMMENDATION INDEX
# ============================================================

@app.post("/api/recommendations/rebuild")
def rebuild_recommendations():
    try:
        rebuild_recommendation_data()

        set_recommendation_index_stale(False)

        return {
            "success": True,
            "message": "Recommendation index rebuilt successfully.",
        }

    except Exception as error:
        print("RECOMMENDATION REBUILD FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to rebuild recommendation index.",
        )


# ============================================================
# GOOGLE SCHOLAR CITATION IMPORT
# ============================================================

SCHOLAR_EXPORT_URL_PATTERN = re.compile(
    r"^https://(?:scholar\.googleusercontent\.com|scholar\.google\.com)"
    r"/scholar\.(bib|enw|ris)",
    re.IGNORECASE,
)

_SCHOLAR_HOSTS = {"scholar.googleusercontent.com", "scholar.google.com"}

_SCHOLAR_CONTENT_SIGNATURES = {
    "bib": (r"@\w+\s*\{",),
    "enw": (r"(?m)^%0\s",),
    "ris": (r"(?im)^TY\s*-",),
}


def _fetch_scholar_export(url: str) -> tuple[str, str]:
    """Fetch a Google Scholar BibTeX / EndNote / RefMan export URL.

    Returns ``(format, text)`` for the ``scholar.bib``, ``scholar.enw``
    and ``scholar.ris`` links of the Google Scholar Cite dialog.
    Raises ``HTTPException`` with the established error semantics.
    """

    match = SCHOLAR_EXPORT_URL_PATTERN.match(url)

    if match is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Only Google Scholar BibTeX, EndNote, "
                "and RefMan links are accepted."
            ),
        )

    export_format = match.group(1).lower()

    try:
        response = safe_get(
            url,
            host_ok=lambda hop: (urlsplit(hop).hostname or "")
            in _SCHOLAR_HOSTS,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 "
                    "(Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 "
                    "(KHTML, like Gecko) "
                    "Chrome/124.0.0.0 "
                    "Safari/537.36"
                ),
                "Accept": (
                    "text/plain, "
                    "application/x-bibtex, "
                    "*/*"
                ),
            },
            timeout=10,
        )

    except UnsafeUrlError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except requests.RequestException as error:

        print("GOOGLE SCHOLAR REQUEST FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="Could not reach Google Scholar.",
        )

    if not response.ok:

        status_code = response.status_code

        if status_code in (
            403,
            429,
            503,
        ):
            raise HTTPException(
                status_code=502,
                detail=(
                    "Google Scholar is temporarily "
                    "blocking automated requests. "
                    "Please try again later."
                ),
            )

        raise HTTPException(
            status_code=502,
            detail=(
                f"Google Scholar returned "
                f"HTTP {status_code}."
            ),
        )

    content = response.text.strip()

    signature_patterns = _SCHOLAR_CONTENT_SIGNATURES[
        export_format
    ]

    if not any(
        re.search(pattern, content, re.IGNORECASE)
        for pattern in signature_patterns
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "The Google Scholar link did not "
                f"return a valid {export_format.upper()} citation."
            ),
        )

    return export_format, content


@app.post(
    "/api/papers/import-url",
    response_model=PaperOut,
)
def import_paper_from_url(
    url: str,
    db: Session = Depends(get_session),
):
    """Import a Google Scholar BibTeX / EndNote / RefMan link directly."""

    url = url.strip()

    export_format, content = _fetch_scholar_export(url)

    with tempfile.NamedTemporaryFile(
        suffix=f".{export_format}",
        delete=False,
        mode="w",
        encoding="utf-8",
    ) as tmp:

        tmp.write(content)
        tmp_path = tmp.name

    try:
        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            f"google-scholar.{export_format}",
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except Exception as error:

        print("SCHOLAR IMPORT FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the citation.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


@app.post("/api/papers/scholar-fetch")
def fetch_scholar_export_url(url: str):
    """Fetch a Google Scholar export link and return its text.

    The upload drop zone uses this endpoint for the review flow:
    nothing is persisted here. The frontend builds a file from
    ``{"format", "text"}`` and runs it through the normal
    preview -> review -> save path, exactly like the Chrome
    extension path.
    """

    url = url.strip()

    export_format, content = _fetch_scholar_export(url)

    return {
        "format": export_format,
        "text": content,
        "url": url,
    }


# ============================================================
# DIRECT BIBTEX IMPORT
# ============================================================

@app.post(
    "/api/papers/import-bibtex",
    response_model=PaperOut,
)
def import_bibtex(
    payload: dict,
    db: Session = Depends(get_session),
):
    bibtex = payload.get("bibtex")

    if not bibtex or not isinstance(
        bibtex,
        str,
    ):
        raise HTTPException(
            status_code=400,
            detail="BibTeX content is required.",
        )

    if not re.search(
        r"@\w+\s*\{",
        bibtex,
        re.IGNORECASE,
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid BibTeX content.",
        )

    with tempfile.NamedTemporaryFile(
        suffix=".bib",
        delete=False,
        mode="w",
        encoding="utf-8",
    ) as tmp:

        tmp.write(bibtex)
        tmp_path = tmp.name

    try:
        filename = "google-scholar.bib"

        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            filename,
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except Exception as error:

        print("BIBTEX IMPORT FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the citation.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# PERSONAL LIBRARY
# ============================================================

@app.get(
    "/api/library",
    response_model=list[LibraryEntryOut],
)
def get_library(
    db: Session = Depends(get_session),
):
    user = get_or_create_default_user(db)

    entries = (
        db.query(PersonalLibrary)
        .options(selectinload(PersonalLibrary.paper))
        .filter(
            PersonalLibrary.user_id == user.id
        )
        .all()
    )

    return entries


# ============================================================
# AUTO-ASSIGN KEYWORDS FOR LIBRARY PAPERS
# ============================================================

@app.post("/api/library/assign-keywords")
def assign_library_keywords(
    db: Session = Depends(get_session),
):
    """
    Automatic keyword assigner: generates YAKE keywords for every
    library paper that has none, then revalidates recommendation
    status and the prepared recommendation text.

    Runs entirely locally (no network) -- the My Library page calls
    this on load so saved papers always show keywords without the
    user doing anything. Must stay registered BEFORE
    /api/library/{paper_id}, or "assign-keywords" would be parsed
    as a paper id.
    """
    user = get_or_create_default_user(db)

    entries = (
        db.query(PersonalLibrary)
        .filter(PersonalLibrary.user_id == user.id)
        .all()
    )

    paper_ids = [entry.paper_id for entry in entries]

    if not paper_ids:
        return {
            "checked": 0,
            "updated": 0,
            "paper_ids": [],
        }

    papers = (
        db.query(Paper)
        .filter(Paper.id.in_(paper_ids))
        .all()
    )

    updated_ids: list[int] = []

    for paper in papers:
        if paper.keywords and paper.keywords.strip():
            continue

        try:
            if not generate_keywords_if_missing(paper):
                continue

            validate_paper(paper)
            refresh_prepared_text(paper)
            updated_ids.append(paper.id)

        except Exception as error:
            print(
                "WARNING: Keyword assignment failed for paper "
                f"id={paper.id}: {error}"
            )
            db.rollback()

    if updated_ids:
        db.commit()
        set_recommendation_index_stale(True)

    return {
        "checked": len(paper_ids),
        "updated": len(updated_ids),
        "paper_ids": updated_ids,
    }


# ============================================================
# SAVE PAPER TO LIBRARY
# ============================================================

@app.post("/api/library/{paper_id}")
def save_to_library(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    user = get_or_create_default_user(db)

    existing = (
        db.query(PersonalLibrary)
        .filter(
            PersonalLibrary.user_id == user.id,
            PersonalLibrary.paper_id == paper_id,
        )
        .first()
    )

    if existing:
        return {
            "status": "already_saved"
        }

    entry = PersonalLibrary(
        user_id=user.id,
        paper_id=paper_id,
    )

    db.add(entry)

    try:
        db.commit()

    except IntegrityError:
        # Lost the check-then-insert race against a concurrent save of
        # the same paper (double-click / two tabs): the UNIQUE constraint
        # did its job, so report the same outcome as the pre-check.
        db.rollback()
        return {
            "status": "already_saved"
        }

    # Automatic keyword assignment: a freshly saved paper without
    # keywords gets them right away (local YAKE, best-effort).
    try:
        if generate_keywords_if_missing(paper):
            validate_paper(paper)
            refresh_prepared_text(paper)
            db.commit()
            set_recommendation_index_stale(True)

    except Exception as error:
        print(
            "WARNING: Keyword assignment on save failed for paper "
            f"id={paper.id}: {error}"
        )
        db.rollback()

    return {
        "status": "saved"
    }


# ============================================================
# REMOVE PAPER FROM LIBRARY
# ============================================================

@app.delete("/api/library/{paper_id}")
def remove_from_library(
    paper_id: int,
    db: Session = Depends(get_session),
):
    user = get_or_create_default_user(db)

    entry = (
        db.query(PersonalLibrary)
        .filter(
            PersonalLibrary.user_id == user.id,
            PersonalLibrary.paper_id == paper_id,
        )
        .first()
    )

    if not entry:
        # Idempotent on purpose: a double-click (or a second tab) racing
        # the first DELETE must not surface "Paper is not in the library"
        # as an error after the paper was successfully removed.
        return {
            "status": "not_saved"
        }

    db.delete(entry)
    db.commit()

    return {
        "status": "removed"
    }


# ============================================================
# RECOMMENDATIONS
# ============================================================

IMPLEMENTED_PIPELINES = {
    "tfidf",
    "sbert",
    "tfidf_sbert",
    "tfidf_metadata",
    "sbert_metadata",
    "tfidf_sbert_metadata",
}

# The dial-allocated pipeline: the six presets plus "custom".
ALL_PIPELINE_IDS = IMPLEMENTED_PIPELINES | {"custom"}


class SearchResultOut(SearchResultOutBase):
    """
    One ranked result from /api/recommendations, plus the weighted
    per-component contributions that produced its score:

        components = {
            "tfidf": w_tfidf * s'_tfidf,
            "sbert": w_sbert * s'_sbert,
            "metadata": w_metadata * s_meta,
        }

    Additive and optional: producers that do not compute a breakdown
    (e.g. the traced/compare paths) serialize ``components: null``,
    and older clients can ignore the extra field entirely.
    """

    components: dict[str, float] | None = None

# Keep recommendation work and response sizes bounded at the API boundary.
# Pagination operates over this bounded ranked result set.
MAX_RECOMMENDATION_TOP_K = 100
DEFAULT_RECOMMENDATION_PAGE_SIZE = 20


def _resolve_custom_weights(
    pipeline: str,
    w_tfidf: float | None,
    w_sbert: float | None,
    w_metadata: float | None,
) -> dict[str, float] | None:
    """
    Normalize the dial allocation for pipeline="custom"; returns None
    for the presets. Raises 400 on misuse (missing/partial weights,
    or weights supplied with a preset pipeline).
    """
    provided = (
        w_tfidf is not None,
        w_sbert is not None,
        w_metadata is not None,
    )

    if pipeline == "custom":
        if not all(provided):
            raise HTTPException(
                status_code=400,
                detail=(
                    "The custom pipeline requires w_tfidf, "
                    "w_sbert and w_metadata."
                ),
            )

        try:
            return build_custom_weights(
                w_tfidf,  # type: ignore[arg-type]
                w_sbert,  # type: ignore[arg-type]
                w_metadata,  # type: ignore[arg-type]
            )

        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            )

    if any(provided):
        raise HTTPException(
            status_code=400,
            detail=(
                "w_tfidf/w_sbert/w_metadata may only be used "
                "with pipeline=custom."
            ),
        )

    return None


def _resolve_custom_recipe(
    custom_weights: dict[str, float] | None,
) -> dict[str, float] | None:
    """
    Normalize a Lab recipe dict ({tfidf, sbert, metadata}, any
    non-negative scale) the same way build_custom_weights does for
    the query and trace endpoints. Returns None when no recipe was
    supplied, and raises 400 for invalid values.
    """

    if custom_weights is None:
        return None

    try:
        return build_custom_weights(
            float(custom_weights.get("tfidf") or 0.0),
            float(custom_weights.get("sbert") or 0.0),
            float(custom_weights.get("metadata") or 0.0),
        )

    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "custom_weights must be non-negative numbers with "
                "at least one value greater than 0."
            ),
        ) from error


@app.get(
    "/api/recommendations",
    response_model=list[SearchResultOut],
)
def get_recommendations(
    pipeline: str,
    query: str | None = None,
    seed_paper_id: int | None = None,
    top_k: int = 10,
    page: int | None = None,
    page_size: int | None = None,
    mmr_lambda: float | None = None,
    mmr_pool: int = 50,
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
    db: Session = Depends(get_session),
):
    """Return ranked recommendations, optionally paged.

    ``top_k`` is limited to 100. Existing callers that omit ``page`` and
    ``page_size`` receive the same bare list response as before. When either
    pagination parameter is supplied, the response remains a list and contains
    the requested page of that bounded top-K result set. ``page`` is 1-based;
    a missing page defaults to 1 and a missing page size defaults to 20.
    """

    # --------------------------------------------------------
    # Validate pipeline
    # --------------------------------------------------------

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    # --------------------------------------------------------
    # Require either query OR seed paper
    # --------------------------------------------------------

    if not query and seed_paper_id is None:
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    # --------------------------------------------------------
    # Do not allow both at the same time
    # --------------------------------------------------------

    if query and seed_paper_id is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either a query or seed_paper_id, "
                "not both."
            ),
        )

    # --------------------------------------------------------
    # Validate top_k
    # --------------------------------------------------------

    if top_k <= 0 or top_k > MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "top_k must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    if page is not None and page < 1:
        raise HTTPException(
            status_code=400,
            detail="page must be greater than 0.",
        )

    if page_size is not None and not 1 <= page_size <= MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "page_size must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    if mmr_lambda is not None and not 0.0 <= mmr_lambda <= 1.0:
        raise HTTPException(
            status_code=400,
            detail="mmr_lambda must be between 0 and 1.",
        )

    if not 1 <= mmr_pool <= MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "mmr_pool must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    # --------------------------------------------------------
    # Validate seed paper
    # --------------------------------------------------------

    if seed_paper_id is not None:
        seed_paper = (
            db.query(Paper)
            .filter(Paper.id == seed_paper_id)
            .first()
        )

        if not seed_paper:
            raise HTTPException(
                status_code=404,
                detail="Seed paper not found.",
            )

    # --------------------------------------------------------
    # Run recommendation search
    # --------------------------------------------------------

    try:
        results = run_search(
            db=db,
            query=query,
            seed_paper_id=seed_paper_id,
            pipeline=pipeline,
            top_k=top_k,
            custom_weights=custom_weights,
            mmr_lambda=mmr_lambda,
            mmr_pool=mmr_pool,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("RECOMMENDATION SEARCH FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Recommendation search failed.",
        ) from error

    if page is not None or page_size is not None:
        requested_page = page or 1
        requested_page_size = page_size or DEFAULT_RECOMMENDATION_PAGE_SIZE
        start = (requested_page - 1) * requested_page_size
        return results[start : start + requested_page_size]

    return results


# ============================================================
# RECOMMENDATION EXECUTION TRACE
# ============================================================

@app.post(
    "/api/recommendations/trace",
    response_model=RecommendationTraceResponse,
)
def get_recommendation_trace(
    request: RecommendationTraceRequest,
    db: Session = Depends(get_session),
):
    """
    Run the recommendation search with instrumentation attached.

    Returns the same ranked results as /api/recommendations, plus an
    ordered list of trace events showing the actual intermediate
    values at every step of the computation (prepared query text,
    component scores, normalization bounds, weighted combination,
    ranking) -- for the mathematical visualization in the UI.
    """

    # --------------------------------------------------------
    # Require either query OR seed paper
    # --------------------------------------------------------

    if (
        not request.query
        and request.seed_paper_id is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    # --------------------------------------------------------
    # Do not allow both at the same time
    # --------------------------------------------------------

    if (
        request.query
        and request.seed_paper_id is not None
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either a query or seed_paper_id, "
                "not both."
            ),
        )

    # --------------------------------------------------------
    # Validate seed paper
    # --------------------------------------------------------

    if request.seed_paper_id is not None:
        seed_paper = (
            db.query(Paper)
            .filter(Paper.id == request.seed_paper_id)
            .first()
        )

        if not seed_paper:
            raise HTTPException(
                status_code=404,
                detail="Seed paper not found.",
            )

    custom_weights = _resolve_custom_weights(
        request.pipeline,
        request.w_tfidf,
        request.w_sbert,
        request.w_metadata,
    )

    # --------------------------------------------------------
    # Run the traced search
    # --------------------------------------------------------

    try:
        return run_traced_search(
            db=db,
            query=request.query,
            seed_paper_id=request.seed_paper_id,
            pipeline=request.pipeline,
            top_k=request.top_k,
            custom_weights=custom_weights,
            mmr_lambda=request.mmr_lambda,
            mmr_pool=request.mmr_pool,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("RECOMMENDATION TRACE FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Recommendation trace failed.",
        ) from error

# ============================================================
# PIPELINE COMPARISON ("PIPELINE BATTLE")
# ============================================================

@app.post(
    "/api/recommendations/compare",
    response_model=CompareResponse,
)
def compare_recommendation_pipelines(
    request: CompareRequest,
    db: Session = Depends(get_session),
):
    """
    Run all six recommendation pipelines against the same query or
    seed paper and return the ranked results side by side, plus
    consensus ranking and pairwise agreement statistics -- the raw
    material for the thesis evaluation chapter.
    """

    # --------------------------------------------------------
    # Require either query OR seed paper
    # --------------------------------------------------------

    if (
        not request.query
        and request.seed_paper_id is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    if (
        request.query
        and request.seed_paper_id is not None
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either a query or seed_paper_id, "
                "not both."
            ),
        )

    if request.seed_paper_id is not None:
        seed_paper = (
            db.query(Paper)
            .filter(Paper.id == request.seed_paper_id)
            .first()
        )

        if not seed_paper:
            raise HTTPException(
                status_code=404,
                detail="Seed paper not found.",
            )

    custom_weights = _resolve_custom_recipe(request.custom_weights)

    try:
        result = compare_pipelines(
            db=db,
            query=request.query,
            seed_paper_id=request.seed_paper_id,
            top_k=request.top_k,
            custom_weights=custom_weights,
            mmr_lambda=request.mmr_lambda,
            mmr_pool=request.mmr_pool,
        )

        # Log the run to the battle history so the frontend can
        # tally wins over time. Runs with no winner (empty
        # repository) are not recorded, and Lab simulations
        # opt out so they don't pollute the Arena's records.
        if result.winner is not None and request.record_battle:
            db.add(
                BattleRun(
                    query=request.query,
                    seed_paper_id=request.seed_paper_id,
                    top_k=request.top_k,
                    winner_pipeline_id=result.winner.pipeline_id,
                    winner_metric=result.winner.metric,
                    winner_value=result.winner.value,
                    avg_consensus_rank=result.winner.avg_consensus_rank,
                )
            )
            db.commit()

        return result

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("PIPELINE COMPARISON FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Pipeline comparison failed.",
        ) from error


# ============================================================
# PIPELINE COMPARISON OVER THE WEB ("WEB BATTLE")
# ============================================================

class WebCompareRequest(BaseModel):
    """Battle the pipelines over live web search hits instead of the
    repository. Same shape as CompareRequest, minus seed_paper_id —
    a web battle always runs on a query."""

    q: str
    top_k: int = 5
    sources: str = "openalex,crossref,arxiv"
    sort: str = "relevance"
    peer_reviewed: bool = True
    open_access: bool = False
    custom_weights: dict[str, float] | None = None


@app.post(
    "/api/recommendations/web-compare",
    response_model=CompareResponse,
)
def web_compare_recommendation_pipelines(
    request: WebCompareRequest,
):
    """
    Fetch live hits from the open scholarly web (OpenAlex, Crossref,
    arXiv), vectorize them on the fly with the same stored TF-IDF
    vectorizer and S-BERT model, and battle the six pipelines (plus
    an optional custom recipe) over those external candidates. The
    response is a standard CompareResponse, so the Arena and Lab
    render it exactly like a repository battle. Web battles are
    exploratory and never recorded to the battle history.
    """

    query = (request.q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if request.sort not in WEB_SEARCH_SORTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"sort must be one of: {', '.join(WEB_SEARCH_SORTS)}."
            ),
        )

    requested_sources = tuple(
        source.strip()
        for source in request.sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv")
    )

    try:
        hits = search_web(
            query,
            year_min=None,
            year_max=None,
            peer_reviewed=request.peer_reviewed,
            open_access_only=request.open_access,
            sources=requested_sources,
            sort=request.sort,
            limit=max(10, min(request.top_k * 3, 30)),
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    custom_weights = _resolve_custom_recipe(request.custom_weights)

    try:
        result = compare_web_results(
            query=query,
            hits=hits,
            top_k=request.top_k,
            custom_weights=custom_weights,
        )
        return result

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("WEB PIPELINE COMPARISON FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Web pipeline comparison failed.",
        ) from error


@app.get("/api/recommendations/web")
def recommend_from_web(
    q: str,
    pipeline: str,
    top_k: int = 20,
    year_min: int | None = None,
    year_max: int | None = None,
    peer_reviewed: bool = True,
    open_access: bool = False,
    sources: str = "openalex,crossref,arxiv",
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
):
    """
    Recommend from the open web with ONE of the pipelines.

    Fetches live hits from OpenAlex, Crossref and arXiv (the same
    sources as the web search), vectorizes them on the fly with the
    stored TF-IDF vectorizer and the S-BERT model, and ranks them with
    the chosen pipeline's weights (or the custom dial allocation). Each
    row is the web hit plus its rank, final score and component scores.
    Web recommendations are exploratory and are never recorded.
    """

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    query = (q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if top_k <= 0 or top_k > 25:
        raise HTTPException(
            status_code=400,
            detail="top_k must be between 1 and 25 for web results.",
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    from app.services.recommendation.pipeline_config import (
        get_pipeline_weights,
    )

    weights = (
        custom_weights
        if pipeline == "custom"
        else get_pipeline_weights(pipeline)
    )

    requested_sources = tuple(
        source.strip()
        for source in sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv")
    )

    try:
        hits = search_web(
            query,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access,
            sources=requested_sources,
            sort="relevance",
            limit=25,
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    try:
        return rank_web_results(
            query=query,
            hits=hits,
            weights=weights,
            top_k=top_k,
        )

    except Exception as error:
        print()
        print("WEB RECOMMENDATION FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Web recommendation failed.",
        ) from error


# ============================================================
# BATTLE HISTORY
# ============================================================

@app.get("/api/evaluation/battles")
def get_battle_history(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_session),
):
    """
    Battle history, paginated, newest first — plus the win tally
    across ALL recorded runs so the Arena page's champion board
    stays correct no matter which page is displayed.

    Every recorded pipeline-battle run is logged; the tally counts
    wins per pipeline over the whole table.
    """

    page = max(1, page)
    page_size = max(1, min(page_size, 100))

    total = db.query(BattleRun).count()
    pages = max(1, (total + page_size - 1) // page_size)

    runs = (
        db.query(BattleRun)
        .order_by(
            BattleRun.created_at.desc(),
            BattleRun.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    tally_rows = (
        db.query(
            BattleRun.winner_pipeline_id,
            func.count(BattleRun.id),
        )
        .group_by(BattleRun.winner_pipeline_id)
        .all()
    )

    return {
        "runs": [
            {
                "id": run.id,
                "query": run.query,
                "seed_paper_id": run.seed_paper_id,
                "top_k": run.top_k,
                "winner_pipeline_id": run.winner_pipeline_id,
                "winner_metric": run.winner_metric,
                "winner_value": run.winner_value,
                "avg_consensus_rank": run.avg_consensus_rank,
                "created_at": run.created_at.isoformat(),
            }
            for run in runs
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "tally": [
            {
                "pipeline_id": pipeline_id,
                "wins": wins,
            }
            for pipeline_id, wins in tally_rows
        ],
    }


# ============================================================
# SIMILAR PAPERS GRAPH
# ============================================================

@app.get("/api/catalog")
def get_catalog(
    db: Session = Depends(get_session),
):
    """
    The repository taxonomy — subjects, categories and document
    types — as seed defaults merged with every value actually
    stored in the papers table. Adding a reference with a new
    subject or category automatically extends the catalog.

    `subject_categories` maps each subject to the categories that
    actually co-occur with it in the imported references, so the
    Upload form can auto-suggest categories matching the chosen
    subject. Subjects with no stored rows fall back to the seed
    category list.
    """

    rows = (
        db.query(Paper.subject_category, Paper.document_type)
        .all()
    )

    stored_subjects: list[str] = []
    stored_categories: list[str] = []
    stored_document_types: list[str] = []
    subject_categories: dict[str, list[str]] = {}

    for subject_category, document_type in rows:
        parts = (subject_category or "").split(":", 2)

        subject = parts[0].strip()
        if subject:
            stored_subjects.append(subject)

        if len(parts) > 1:
            category = parts[1].strip()
            if category:
                stored_categories.append(category)
                # Record the subject -> category co-occurrence seen
                # in the imported reference set.
                subject_categories.setdefault(subject, [])
                if category not in subject_categories[subject]:
                    subject_categories[subject].append(category)

        if document_type and document_type.strip():
            stored_document_types.append(document_type.strip())

    # Every known subject gets a suggestion list: stored
    # co-occurrences first, seed defaults as the fallback for
    # subjects the reference set hasn't classified yet.
    for subject in merge_defaults(
        DEFAULT_SUBJECTS,
        stored_subjects,
    ):
        subject_categories.setdefault(subject, list(DEFAULT_CATEGORIES))

    return {
        "subjects": merge_defaults(
            DEFAULT_SUBJECTS,
            stored_subjects,
        ),
        "categories": merge_defaults(
            DEFAULT_CATEGORIES,
            stored_categories,
        ),
        "document_types": merge_defaults(
            DEFAULT_DOCUMENT_TYPES,
            stored_document_types,
        ),
        "subject_categories": subject_categories,
    }


@app.get("/api/papers/{paper_id}/similar-graph")
def get_similar_papers_graph(
    paper_id: int,
    pipeline: str = "tfidf_sbert_metadata",
    top_k: int = 10,
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
    db: Session = Depends(get_session),
):
    # --------------------------------------------------------
    # Validate pipeline
    # --------------------------------------------------------

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    # --------------------------------------------------------
    # Validate top_k
    # --------------------------------------------------------

    if top_k <= 0 or top_k > MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "top_k must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    # --------------------------------------------------------
    # Get selected paper
    # --------------------------------------------------------

    seed_paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not seed_paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    # --------------------------------------------------------
    # Make sure the seed can be used by the recommendation
    # system
    # --------------------------------------------------------

    if not seed_paper.is_valid_for_recommendation:
        raise HTTPException(
            status_code=400,
            detail=(
                "This paper is not valid for recommendation. "
                "Rebuild the recommendation index first."
            ),
        )

    if not seed_paper.prepared_text:
        raise HTTPException(
            status_code=400,
            detail=(
                "This paper has no prepared text and cannot "
                "be used for similarity search."
            ),
        )

    # --------------------------------------------------------
    # Run the EXISTING recommendation system
    # --------------------------------------------------------

    try:
        results = run_search(
            db=db,
            seed_paper_id=paper_id,
            pipeline=pipeline,
            top_k=top_k,
            custom_weights=custom_weights,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("SIMILAR PAPERS GRAPH FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Unable to generate similar papers graph.",
        ) from error

    # --------------------------------------------------------
    # Build the weighted graph (connectedpapers-js model):
    # origin star + pairwise edges, weighted shortest paths,
    # shared author/topic groups.
    # --------------------------------------------------------

    graph = build_connected_graph(
        seed=seed_paper,
        papers=[seed_paper] + [result["paper"] for result in results],
        pipeline=pipeline,
        weights=custom_weights,
    )

    # --------------------------------------------------------
    # Center node = selected paper
    # --------------------------------------------------------

    nodes = [
        {
            "id": seed_paper.id,
            "title": seed_paper.title,
            "author": seed_paper.author,
            "publication_year": seed_paper.publication_year,
            "abstract": seed_paper.abstract,
            "doi": seed_paper.doi,
            "citation_count": seed_paper.citation_count,
            "similarity": 1.0,
            "relationship": "current",
            "path": [seed_paper.id],
            "path_length": 0.0,
        }
    ]

    # --------------------------------------------------------
    # Similar-paper nodes (path = shortest weighted route back
    # to the origin, straight from the graph builder)
    # --------------------------------------------------------

    for result in results:
        paper = result["paper"]

        nodes.append(
            {
                "id": paper.id,
                "title": paper.title,
                "author": paper.author,
                "publication_year": paper.publication_year,
                "abstract": paper.abstract,
                "doi": paper.doi,
                "citation_count": paper.citation_count,
                "similarity": result["score"],
                "relationship": "similar",
                "path": graph["node_paths"].get(paper.id, []),
                "path_length": graph["path_lengths"].get(paper.id, 0.0),
            }
        )

    # --------------------------------------------------------
    # Return graph data
    # --------------------------------------------------------

    # Prior / derivative works: the external works the graph set
    # cites most (seminal references) and the works citing the most
    # graph papers (surveys / follow-ups). Clustered from the cached
    # OpenAlex neighborhood; empty when nothing overlaps yet.
    prior_works, derivative_works = clustered_works(
        db,
        [node["id"] for node in nodes],
    )

    # The local citation store keeps bare OpenAlex ids for unmatched
    # works; resolve real titles best-effort (cached) so the lists
    # read like the web scope. Offline -> the ids/DOIs stay.
    external_ids = [
        work["work_id"]
        for work in [*prior_works, *derivative_works]
        if not work.get("is_local")
    ]

    try:
        titles = resolve_work_titles(external_ids)
    except Exception:
        titles = {}

    for work in [*prior_works, *derivative_works]:
        title = titles.get(work["work_id"])

        if title:
            work["label"] = title
            work["title"] = title

    return {
        "paper_id": paper_id,
        "pipeline": pipeline,
        "start_id": graph["start_id"],
        "nodes": nodes,
        "edges": graph["edges"],
        # JSON object keys are strings -- keep the map honest instead
        # of letting Python ints silently stringify on the wire.
        "path_lengths": {
            str(node_id): distance
            for node_id, distance in graph["path_lengths"].items()
        },
        "common_authors": graph["common_authors"],
        "common_topics": graph["common_topics"],
        "common_references": graph["common_references"],
        "common_citers": graph["common_citers"],
        "prior_works": prior_works,
        "derivative_works": derivative_works,
    }


@app.get("/api/papers/{paper_id}/web-connections")
def paper_web_connections(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """WEB scope of the similar-papers pane: OpenAlex neighborhood.

    Prior works = the paper's references (heavily-cited first);
    derivative works = the works citing it. Live OpenAlex lookups,
    no caching -- the endpoint reports a friendly reason when the
    paper has no DOI or OpenAlex is unreachable.
    """
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    result = fetch_web_neighborhood(paper)

    if not result.get("ok"):
        reason = result.get("reason")

        if reason == "no_doi":
            raise HTTPException(
                status_code=400,
                detail=(
                    "This paper has no DOI, so OpenAlex cannot "
                    "resolve its web connections."
                ),
            )

        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAlex could not be reached for this paper. "
                "Try again in a moment."
            ),
        )

    result["paper_id"] = paper.id

    return result


@app.post("/api/papers/{paper_id}/citations/refresh")
def refresh_paper_citations_endpoint(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return refresh_paper_citations(db, paper)


# ============================================================
# RESEARCH ASSISTANT
# ============================================================

@app.post(
    "/api/research-chat",
    response_model=ResearchChatResponse,
)
def research_chat(
    request: ResearchChatRequest,
    db: Session = Depends(get_session),
):
    try:
        return answer_research_question(
            db=db,
            request=request,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error
    except Exception as error:
        print("RESEARCH CHAT FAILED")
        print(error)
        raise HTTPException(
            status_code=500,
            detail="Research chat failed.",
        ) from error


@app.post(
    "/api/research-chat/suggestions",
    response_model=SuggestionResponse,
)
def research_chat_suggestions(request: SuggestionRequest):
    """Follow-up questions for the chat's suggestion pills."""

    return suggest_followups(request)


# ============================================================
# LIBRARY MODE & SITE EDITOR
# ============================================================


def _seed_library_site() -> None:
    """Create the admin account + persist feature defaults (idempotent)."""
    db = SessionLocal()

    try:
        ensure_admin_user(db)
        # Writes the defaults on first boot; afterwards it only
        # rewrites the same values, so a missing row can never leave
        # the public endpoint without a full feature map.
        set_library_features(db, {})
    except Exception:
        logging.getLogger(__name__).exception(
            "Could not seed the library site editor state"
        )
    finally:
        db.close()


def require_admin(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_session),
) -> User:
    """Bearer-token gate for the site-editor endpoints."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Admin sign-in required.",
        )

    token = authorization.split(" ", 1)[1].strip()
    user = verify_admin_token(db, token)

    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Admin session expired or invalid.",
        )

    return user


def _announcement_or_404(
    db: Session,
    announcement_id: int,
) -> Announcement:
    row = (
        db.query(Announcement)
        .filter(Announcement.id == announcement_id)
        .first()
    )

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Announcement not found.",
        )

    return row


@app.get(
    "/api/site/library-features",
    response_model=LibraryFeaturesOut,
)
def public_library_features(db: Session = Depends(get_session)):
    """Feature states for Library Mode (public: the nav needs it)."""
    return LibraryFeaturesOut(features=get_library_features(db))


@app.get(
    "/api/library/announcements",
    response_model=list[AnnouncementOut],
)
def public_announcements(db: Session = Depends(get_session)):
    """Active announcements, in admin-defined order."""
    return (
        db.query(Announcement)
        .filter(Announcement.active.is_(True))
        .order_by(
            Announcement.position.asc(),
            Announcement.id.asc(),
        )
        .all()
    )


@app.post("/api/admin/login", response_model=AdminTokenOut)
def admin_login(
    payload: AdminLoginIn,
    db: Session = Depends(get_session),
):
    user = (
        db.query(User)
        .filter(
            User.username == payload.username.strip(),
            User.is_admin.is_(True),
        )
        .first()
    )

    if user is None or not verify_password(
        payload.password,
        user.password_hash,
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid admin credentials.",
        )

    token, expires_at = create_admin_token(db, user.id)

    return AdminTokenOut(
        token=token,
        username=user.username,
        expires_at=expires_at,
    )


@app.get("/api/admin/me", response_model=AdminMeOut)
def admin_me(admin: User = Depends(require_admin)):
    return AdminMeOut(username=admin.username)


@app.post("/api/admin/password")
def admin_change_password(
    payload: AdminPasswordChange,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    if not verify_password(payload.current_password, admin.password_hash):
        raise HTTPException(
            status_code=400,
            detail="Current password is incorrect.",
        )

    admin.password_hash = hash_password(payload.new_password)
    db.commit()

    return {"ok": True}


@app.get(
    "/api/admin/announcements",
    response_model=list[AnnouncementOut],
)
def admin_list_announcements(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    return (
        db.query(Announcement)
        .order_by(
            Announcement.position.asc(),
            Announcement.id.asc(),
        )
        .all()
    )


@app.post(
    "/api/admin/announcements",
    response_model=AnnouncementOut,
    status_code=201,
)
def admin_create_announcement(
    payload: AnnouncementIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    last_position = db.query(func.max(Announcement.position)).scalar()

    row = Announcement(
        title=payload.title.strip(),
        body=payload.body.strip(),
        level=payload.level,
        active=payload.active,
        position=0 if last_position is None else last_position + 1,
    )

    db.add(row)
    db.commit()
    db.refresh(row)

    return row


@app.put(
    "/api/admin/announcements/{announcement_id}",
    response_model=AnnouncementOut,
)
def admin_update_announcement(
    announcement_id: int,
    payload: AnnouncementUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    row = _announcement_or_404(db, announcement_id)
    data = payload.model_dump(exclude_unset=True)

    if "title" in data:
        row.title = data["title"].strip()

    if "body" in data:
        row.body = data["body"].strip()

    if "level" in data:
        row.level = data["level"]

    if "active" in data:
        row.active = data["active"]

    if "position" in data:
        row.position = data["position"]

    db.commit()
    db.refresh(row)

    return row


@app.delete("/api/admin/announcements/{announcement_id}")
def admin_delete_announcement(
    announcement_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    row = _announcement_or_404(db, announcement_id)
    db.delete(row)
    db.commit()

    return {"ok": True, "deleted": announcement_id}


@app.get(
    "/api/admin/library-features",
    response_model=LibraryFeaturesOut,
)
def admin_get_library_features(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    return LibraryFeaturesOut(features=get_library_features(db))


@app.put(
    "/api/admin/library-features",
    response_model=LibraryFeaturesOut,
)
def admin_set_library_features(
    payload: LibraryFeaturesIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    try:
        features = set_library_features(db, payload.features)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    return LibraryFeaturesOut(features=features)


# ============================================================
# LITERATURE ACTIONS (multi-select context menu)
# ============================================================


def _load_selected_papers(
    db: Session,
    paper_ids: list[int],
) -> list[Paper]:
    """Fetch the selected papers in the order requested, deduped."""
    wanted = list(dict.fromkeys(paper_ids))

    papers = (
        db.query(Paper)
        .filter(Paper.id.in_(wanted))
        .all()
    )

    by_id = {paper.id: paper for paper in papers}
    ordered = [by_id[paper_id] for paper_id in wanted if paper_id in by_id]

    if not ordered:
        raise HTTPException(
            status_code=404,
            detail="None of the selected papers exist.",
        )

    return ordered


def _sanitize_file_base(value: str, fallback: str) -> str:
    """Lowercase slug for a document filename (no extension)."""
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")

    return (slug[:80].rstrip("-")) or fallback


def _rename_base(
    paper: Paper,
    pattern: str,
    custom_name: str | None,
) -> str:
    fallback = f"paper-{paper.id}"

    if pattern == "custom":
        return _sanitize_file_base(
            (custom_name or "").strip() or (paper.title or ""),
            fallback,
        )

    if pattern == "author-year":
        parts = [
            paper.author or "",
            str(paper.publication_year or ""),
        ]
        return _sanitize_file_base(" ".join(parts), fallback)

    if pattern == "author-year-title":
        parts = [
            paper.author or "",
            str(paper.publication_year or ""),
            paper.title or "",
        ]
        return _sanitize_file_base(" ".join(parts), fallback)

    return _sanitize_file_base(paper.title or "", fallback)


def _reveal_in_file_manager(path: str) -> bool:
    """Open the OS file manager with the given file selected.

    Runs on the machine hosting the backend -- which is the user's
    own machine for this local-first app. Returns False when the
    platform call fails; never raises.
    """
    import platform

    try:
        system = platform.system()

        if system == "Darwin":
            subprocess.Popen(["open", "-R", path])
        elif system == "Windows":
            subprocess.Popen(["explorer", "/select,", path])
        else:
            subprocess.Popen(["xdg-open", str(Path(path).parent)])

        return True
    except Exception:
        logging.getLogger(__name__).exception(
            "Could not reveal %s in the file manager", path
        )
        return False


@app.post("/api/papers/refresh-metadata")
def refresh_papers_metadata(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Re-run background metadata enrichment for the selected papers.

    Same enrichment pipeline imports use (PDF discovery + field
    filling + keywords); the frontend polls /enrichment-status and
    refreshes the rows once each job reports done.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    for paper in papers:
        enqueue_paper_enrichment(paper.id)

    return {"ok": True, "queued": [paper.id for paper in papers]}


@app.post("/api/papers/reveal")
def reveal_papers(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Open the containing folder of the first selected paper with
    a stored file (Finder / Explorer / xdg-open)."""
    papers = _load_selected_papers(db, payload.paper_ids)

    for paper in papers:
        if not paper.stored_path:
            continue

        path = get_paper_file_path(paper.stored_path)

        if not os.path.exists(path):
            continue

        launched = _reveal_in_file_manager(path)

        if not launched:
            raise HTTPException(
                status_code=500,
                detail="The file manager could not be opened.",
            )

        return {
            "ok": True,
            "paper_id": paper.id,
            "path": path,
        }

    raise HTTPException(
        status_code=404,
        detail="None of the selected papers has a stored file.",
    )


@app.post("/api/papers/rename-files")
def rename_paper_files(
    payload: RenameFilesIn,
    db: Session = Depends(get_session),
):
    """Rename the stored document files of the selected papers.

    Patterns: title | author-year | author-year-title | custom.
    Files stay in storage/papers/; collisions get a -2, -3 suffix.
    Papers without a stored file are reported under `skipped`.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    renamed: list[dict] = []
    skipped: list[dict] = []

    for paper in papers:
        if not paper.stored_path:
            skipped.append({"id": paper.id, "reason": "no_file"})
            continue

        current = Path(get_paper_file_path(paper.stored_path))

        if not current.exists():
            skipped.append({"id": paper.id, "reason": "file_missing"})
            continue

        base = _rename_base(paper, payload.pattern, payload.custom_name)
        suffix = current.suffix.lower()
        target = current.parent / f"{base}{suffix}"

        if target.name == current.name:
            skipped.append({"id": paper.id, "reason": "already_named"})
            continue

        counter = 2

        while target.exists():
            target = current.parent / f"{base}-{counter}{suffix}"
            counter += 1

        try:
            current.rename(target)
        except OSError:
            skipped.append({"id": paper.id, "reason": "rename_failed"})
            continue

        paper.stored_path = str(Path("papers") / target.name)

        renamed.append(
            {"id": paper.id, "stored_path": paper.stored_path}
        )

    db.commit()

    return {"ok": True, "renamed": renamed, "skipped": skipped}


@app.post("/api/papers/mark")
def mark_papers(
    payload: MarkPapersIn,
    db: Session = Depends(get_session),
):
    """Bulk set recommendation validity on the selected papers."""
    papers = _load_selected_papers(db, payload.paper_ids)

    changed = 0

    for paper in papers:
        if bool(paper.is_valid_for_recommendation) != payload.valid:
            paper.is_valid_for_recommendation = payload.valid
            changed += 1

    db.commit()

    if changed:
        # Validity gates the recommendation index.
        set_recommendation_index_stale(True)

    return {"ok": True, "updated": changed, "valid": payload.valid}


@app.post("/api/papers/merge")
def merge_selected_papers(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Merge the selected records into one master.

    Reuses the duplicate-merge engine: the master keeps the best
    metadata, library rows and citation rows are repointed, and the
    other rows are deleted.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    if len(papers) < 2:
        raise HTTPException(
            status_code=400,
            detail="Select at least two papers to merge.",
        )

    try:
        summary = merge_group(db, papers)
        db.commit()
    except ValueError as error:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error
    except Exception as error:
        db.rollback()
        print("MERGE FAILED")
        print(error)
        raise HTTPException(
            status_code=500,
            detail="The merge failed; nothing was changed.",
        ) from error

    set_recommendation_index_stale(True)

    return {"ok": True, **summary}

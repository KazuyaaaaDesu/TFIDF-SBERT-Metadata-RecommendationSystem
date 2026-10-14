"""
Gather the literature a leave-one-out tournament needs.

A tournament scores each pipeline on how well it recovers a paper's
real references, but a reference only counts if it is itself a paper
in the repository. Libraries usually hold a paper without the works
it cites, so most references stay unresolved and there is nothing to
score against.

``gather_cited_works`` closes that gap. It looks at the references
the repository has already cached from OpenAlex (``paper_citations``,
direction "cites") that point at no local paper, picks the ones cited
most often across the library, fetches their metadata from OpenAlex
in batches, and adds them as papers. Every cached reference row for
an added (or already-present duplicate) work is then linked to its
paper, so references resolve and more papers qualify as queries.

Only works with a title *and* an abstract are added: the pipelines
rank on text, so a record without an abstract can never be retrieved
or judged. Added papers are tagged ``extraction_method =
"openalex-gather"`` so they stay distinguishable from papers a person
chose.

The new papers have no vectors until the recommendation index is
rebuilt; the caller is responsible for that (see the API route).
Network failures skip a batch and are reported, never raised. ``fetch``
is injectable for offline tests.
"""

from __future__ import annotations

from collections import Counter

from sqlalchemy.orm import Session

from app.models.models import Paper, PaperCitation
from app.services.citations import (
    OPENALEX_WORK_BASE,
    _default_fetch,
    _normalize_work_id,
    gathered_work_map,
    normalize_doi,
)
from app.services.classification import classify_paper
from app.services.duplicate_detection import find_duplicate_paper
from app.services.metadata_enrichment import generate_keywords_if_missing
from app.services.pdf_finder import _reconstruct_openalex_abstract
from app.services.text_preparation import refresh_prepared_text
from app.services.validation import validate_paper

DEFAULT_LIMIT = 300
MAX_LIMIT = 1000
BATCH = 50
EXTRACTION_METHOD = "openalex-gather"
MIN_ABSTRACT_CHARS = 80

_SELECT = (
    "id,doi,display_name,authorships,publication_year,type,"
    "cited_by_count,abstract_inverted_index"
)


def _work_to_fields(work: dict) -> dict | None:
    """Paper fields from an OpenAlex work, or None if unusable."""

    title = (work.get("display_name") or "").strip()
    abstract = _reconstruct_openalex_abstract(
        work.get("abstract_inverted_index")
    )

    if not title or not abstract or len(abstract) < MIN_ABSTRACT_CHARS:
        return None

    authors = "; ".join(
        ((a.get("author") or {}).get("display_name") or "").strip()
        for a in work.get("authorships") or []
    ).strip("; ")

    return {
        "title": title,
        "author": authors or "Unknown",
        "abstract": abstract[:6000],
        "publication_year": work.get("publication_year"),
        "doi": normalize_doi(work.get("doi")),
        "citation_count": work.get("cited_by_count"),
        "document_type": (
            "Book Chapter"
            if work.get("type") == "book-chapter"
            else "Journal Article"
        ),
    }


def unresolved_reference_counts(db: Session) -> Counter:
    """work id -> number of distinct local papers that cite it, for
    cached references that match no local paper yet."""

    pairs = (
        db.query(PaperCitation.external_work_id, PaperCitation.paper_id)
        .filter(PaperCitation.direction == "cites")
        .filter(PaperCitation.matched_paper_id.is_(None))
        .distinct()
        .all()
    )

    return Counter(work_id for work_id, _ in pairs)


def _link_rows(db: Session, work_id: str, paper_id: int) -> int:
    rows = (
        db.query(PaperCitation)
        .filter(PaperCitation.external_work_id == work_id)
        .filter(PaperCitation.matched_paper_id.is_(None))
        .filter(PaperCitation.paper_id != paper_id)
        .all()
    )

    for row in rows:
        row.matched_paper_id = paper_id

    return len(rows)


def gather_cited_works(
    db: Session,
    *,
    limit: int = DEFAULT_LIMIT,
    fetch=None,
    on_progress=None,
) -> dict:
    """
    Add up to ``limit`` of the library's most-cited unresolved
    references as papers and link the reference rows to them.

    Returns a summary; ``added`` is the number of new papers, which
    is the signal the recommendation index needs rebuilding.

    ``on_progress(summary, batches_done, batches_total, added_title)``
    is called after the plan is made, after every paper is added
    (``added_title`` set) and after every batch. It must not raise;
    exceptions from it are swallowed so a UI problem cannot abort an
    import.
    """

    if not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}.")

    fetch = fetch or _default_fetch
    counts = unresolved_reference_counts(db)
    # Most-cited-across-the-library first; id order keeps ties stable.
    ordered = [
        work_id
        for work_id, _ in sorted(
            counts.items(), key=lambda item: (-item[1], item[0])
        )
    ]

    summary = {
        "unresolved_references": len(ordered),
        "considered": 0,
        "added": 0,
        "already_in_library": 0,
        "skipped_no_abstract": 0,
        "failed_batches": 0,
        "rows_linked": 0,
        "limit": limit,
    }

    # Over-fetch: a share of works has no usable abstract.
    pool = ordered[: limit * 3]
    batches_total = (len(pool) + BATCH - 1) // BATCH

    def notify(batches_done: int, title: str | None = None) -> None:
        if on_progress is None:
            return

        try:
            on_progress(dict(summary), batches_done, batches_total, title)
        except Exception:
            pass

    notify(0)

    for start in range(0, len(pool), BATCH):
        batches_done = start // BATCH

        if summary["added"] >= limit:
            break

        batch = pool[start : start + BATCH]
        url = (
            f"{OPENALEX_WORK_BASE}?filter=openalex_id:{'|'.join(batch)}"
            f"&select={_SELECT}&per-page={BATCH}"
        )

        try:
            page = fetch(url)
        except Exception:
            summary["failed_batches"] += 1
            notify(batches_done + 1)
            continue

        for work in (page or {}).get("results") or []:
            if summary["added"] >= limit:
                break

            work_id = _normalize_work_id(work.get("id"))

            if not work_id:
                continue

            summary["considered"] += 1
            fields = _work_to_fields(work)

            if fields is None:
                summary["skipped_no_abstract"] += 1
                continue

            existing = find_duplicate_paper(
                db, title=fields["title"], doi=fields["doi"]
            )

            if existing is not None:
                summary["rows_linked"] += _link_rows(db, work_id, existing.id)
                summary["already_in_library"] += 1
                continue

            paper = Paper(
                source_filename=f"openalex:{work_id}",
                extraction_method=EXTRACTION_METHOD,
                **fields,
            )

            for step in (
                generate_keywords_if_missing,
                classify_paper,
                validate_paper,
                refresh_prepared_text,
            ):
                try:
                    step(paper)
                except Exception as error:  # best-effort, as in import
                    print(f"WARNING: gather {step.__name__} failed: {error}")

            db.add(paper)
            db.flush()
            summary["rows_linked"] += _link_rows(db, work_id, paper.id)
            summary["added"] += 1
            notify(batches_done, paper.title)

        db.commit()
        notify(batches_done + 1)

    return summary


REFERENCE_SELECT = "id,doi,referenced_works"
MAX_EXPAND = 5000


def papers_needing_references(db: Session) -> list[Paper]:
    """Papers with no cached "cites" rows that OpenAlex can look up:
    imported by the gather (their work id is known) or carrying a DOI."""

    has_refs = (
        db.query(PaperCitation.paper_id)
        .filter(PaperCitation.direction == "cites")
        .distinct()
        .subquery()
    )

    candidates = (
        db.query(Paper)
        .filter(~Paper.id.in_(db.query(has_refs.c.paper_id)))
        .order_by(Paper.id)
        .all()
    )

    wanted = gathered_work_map(db)
    known = set(wanted.values())

    return [
        paper
        for paper in candidates
        if paper.id in known or normalize_doi(paper.doi)
    ]


def expand_references(
    db: Session,
    *,
    limit: int = MAX_EXPAND,
    fetch=None,
    on_progress=None,
) -> dict:
    """
    Cache the reference list of papers that have none, so they can act
    as leave-one-out queries.

    Only papers the library already has can be queries, and only
    papers with cached references qualify. After a gather the library
    is mostly *cited* works that were never looked up themselves, so
    most of it is invisible to the tournament. This fetches each such
    paper's ``referenced_works`` from OpenAlex (batched by work id for
    gathered papers, by DOI for the rest) and stores them as "cites"
    rows. The caller links the rows to local papers afterwards
    (``citations.link_reference_rows``).

    ``on_progress(summary, batches_done, batches_total)`` is called
    after each batch and must not raise (exceptions are swallowed).
    """

    if not 1 <= limit <= MAX_EXPAND:
        raise ValueError(f"limit must be between 1 and {MAX_EXPAND}.")

    fetch = fetch or _default_fetch
    work_of = {
        paper_id: work_id
        for work_id, paper_id in gathered_work_map(db).items()
    }
    papers = papers_needing_references(db)[:limit]

    by_work: dict[str, Paper] = {}
    by_doi: dict[str, Paper] = {}

    for paper in papers:
        work_id = work_of.get(paper.id)

        if work_id:
            by_work[work_id] = paper
        else:
            by_doi[normalize_doi(paper.doi)] = paper

    jobs: list[tuple[str, list[str]]] = []
    work_ids = sorted(by_work)
    dois = sorted(by_doi)

    for start in range(0, len(work_ids), BATCH):
        jobs.append(("openalex_id", work_ids[start : start + BATCH]))

    for start in range(0, len(dois), BATCH):
        jobs.append(("doi", dois[start : start + BATCH]))

    summary = {
        "papers_considered": len(papers),
        "papers_expanded": 0,
        "rows_added": 0,
        "failed_batches": 0,
        "not_found": 0,
    }

    def notify(done: int) -> None:
        if on_progress is None:
            return

        try:
            on_progress(dict(summary), done, len(jobs))
        except Exception:
            pass

    notify(0)

    for index, (kind, keys) in enumerate(jobs):
        url = (
            f"{OPENALEX_WORK_BASE}?filter={kind}:{'|'.join(keys)}"
            f"&select={REFERENCE_SELECT}&per-page={BATCH}"
        )

        try:
            page = fetch(url)
        except Exception:
            summary["failed_batches"] += 1
            notify(index + 1)
            continue

        seen: set[int] = set()

        for work in (page or {}).get("results") or []:
            if kind == "openalex_id":
                paper = by_work.get(_normalize_work_id(work.get("id")) or "")
            else:
                paper = by_doi.get(normalize_doi(work.get("doi")) or "")

            if paper is None or paper.id in seen:
                continue

            seen.add(paper.id)
            refs = {
                ref
                for ref in (
                    _normalize_work_id(raw)
                    for raw in work.get("referenced_works") or []
                )
                if ref
            }

            if not refs:
                # Nothing to cache. (No placeholder row: a shared fake
                # id would couple every such paper in the similar-papers
                # graph.) It is simply looked up again next time.
                continue

            for ref in sorted(refs):
                db.add(
                    PaperCitation(
                        paper_id=paper.id,
                        direction="cites",
                        external_work_id=ref,
                        source="openalex",
                    )
                )

            summary["papers_expanded"] += 1
            summary["rows_added"] += len(refs)

        summary["not_found"] += len(keys) - len(seen)
        db.commit()
        notify(index + 1)

    return summary

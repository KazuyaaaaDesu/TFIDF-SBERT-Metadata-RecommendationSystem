"""
Citation-based relatedness via OpenAlex (P2-A).

Bibliographic coupling and co-citation are the reference model's
CommonReferences / CommonCitations signals (connectedpapers-js):

    coupling   = |shared references| / max(1, min(|refs_a|, |refs_b|))
    cocitation = |shared citers|     / max(1, min(|citers_a|, |citers_b|))
    combined   = 0.5 * coupling + 0.5 * cocitation   (clamped to 0..1)

The paper <-> OpenAlex work mapping is cached in the paper_citations
table by scripts/refresh_citations.py; this module only reads that
cache for similarity work and refreshes one paper's cache on demand.

Key scheme for citation sets (documented once, used everywhere):

    "local:<paper_id>"   the external work was matched to a local
                         Paper through its DOI
    "<external_work_id>" the normalized OpenAlex id itself, e.g.
                         "W2741809807" (used when no local paper
                         was matched, and always stored alongside
                         the local key when one was)

Because every matched row contributes BOTH keys, two local papers
couple through "local:<id>" even when OpenAlex gives the same work
two different ids across the two fetch payloads, while unmatched
works still couple through the raw OpenAlex id. The "local:" prefix
cannot collide with an OpenAlex id (those start with "W").
"""

from __future__ import annotations

import json
import re
import urllib.request

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.models import Paper, PaperCitation

# Base endpoint + one resolved work is all a refresh needs.
OPENALEX_WORK_BASE = "https://api.openalex.org/works"

# Network calls are best-effort; scripts/refresh_citations.py must
# survive an offline machine without raising.
OPENALEX_REQUEST_TIMEOUT = 15.0

# OpenAlex hard-caps a page at 200 results.
OPENALEX_PER_PAGE = 200

# Local copy of duplicate_detection._normalize_doi (that helper is
# private and deliberately not imported): lowercase, drop the
# resolver prefix -- both "https://doi.org/10.x" and
# "http://dx.doi.org/10.x" collapse to "10.x".
_DOI_PREFIX_RE = re.compile(r"^https?://(dx\.)?doi\.org/")

# OpenAlex returns work ids as full URLs ("https://openalex.org/W123",
# sometimes with an /works/ path); a short id is more stable as a
# unique-key value.
_WORK_URL_RE = re.compile(
    r"^https?://(?:api\.)?openalex\.org/(?:works/)?(w\d+)$",
    re.IGNORECASE,
)
_WORK_SHORT_RE = re.compile(r"^w\d+$", re.IGNORECASE)


def normalize_doi(doi: str | None) -> str | None:
    """Lowercase a DOI and strip any doi.org resolver prefix."""
    if not doi:
        return None

    normalized = _DOI_PREFIX_RE.sub("", str(doi).strip().lower())

    return normalized or None


def openalex_work_url(doi: str | None) -> str | None:
    """The OpenAlex single-work endpoint for a DOI, or None."""
    normalized = normalize_doi(doi)

    if not normalized:
        return None

    return f"{OPENALEX_WORK_BASE}/doi:{normalized}"


def _normalize_work_id(work_id: object) -> str | None:
    """Collapse a URL or bare OpenAlex id to its short "W..." form."""
    if work_id is None:
        return None

    value = str(work_id).strip()

    if not value:
        return None

    match = _WORK_URL_RE.match(value)

    if match:
        return match.group(1).upper()

    if _WORK_SHORT_RE.match(value):
        return value.upper()

    return value


def _with_per_page(url: str, per_page: int) -> str:
    """Append per-page unless the API URL already sets it."""
    if "per-page=" in url:
        return url

    separator = "&" if "?" in url else "?"

    return f"{url}{separator}per-page={per_page}"


def _default_fetch(url: str) -> dict:
    """Default transport: urllib.request, JSON in, dict out.

    Transport errors propagate to refresh_paper_citations, which is
    the function that turns them into {"ok": False, ...}.
    """
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "thesis-recommendation-system/1.0",
        },
    )

    with urllib.request.urlopen(
        request,
        timeout=OPENALEX_REQUEST_TIMEOUT,
    ) as response:
        return json.loads(response.read().decode("utf-8"))


def _entry_doi(entry: dict) -> str | None:
    """DOI from a citing-work entry, direct field or ids block."""
    doi = entry.get("doi")

    if not doi and isinstance(entry.get("ids"), dict):
        doi = entry["ids"].get("doi")

    return doi


def _work_entry(raw: object) -> tuple[str | None, str | None]:
    """(work_id, doi) for a referenced_works item or citer entry.

    referenced_works are normally bare id strings; citer results are
    objects. Both shapes are accepted so payload fixtures and future
    OpenAlex responses parse the same way.
    """
    if isinstance(raw, dict):
        return _normalize_work_id(raw.get("id")), _entry_doi(raw)

    return _normalize_work_id(raw), None


def _local_doi_map(db: Session) -> dict[str, int]:
    """normalized DOI -> local Paper.id for every paper with a DOI."""
    mapping: dict[str, int] = {}

    rows = (
        db.query(Paper.id, Paper.doi)
        .filter(Paper.doi.isnot(None))
        .all()
    )

    for paper_id, doi in rows:
        normalized = normalize_doi(doi)

        if normalized and normalized not in mapping:
            mapping[normalized] = paper_id

    return mapping


def _external_rows(
    raw_entries,
    doi_map: dict[str, int],
    limit: int | None = None,
) -> list[dict]:
    """Dedupe external entries into PaperCitation kwargs rows."""
    rows: list[dict] = []
    seen: set[str] = set()

    for raw in raw_entries or []:
        work_id, doi = _work_entry(raw)

        if not work_id or work_id in seen:
            continue

        seen.add(work_id)

        normalized_doi = normalize_doi(doi)
        matched_id = (
            doi_map.get(normalized_doi)
            if normalized_doi
            else None
        )

        rows.append(
            {
                "external_work_id": work_id,
                "external_doi": normalized_doi,
                "matched_paper_id": matched_id,
            }
        )

        if limit is not None and len(rows) >= limit:
            break

    return rows


def _replace_direction(
    db: Session,
    paper_id: int,
    direction: str,
    rows: list[dict],
) -> None:
    """Idempotent upsert: drop this direction, insert the fresh rows."""
    (
        db.query(PaperCitation)
        .filter(
            PaperCitation.paper_id == paper_id,
            PaperCitation.direction == direction,
        )
        .delete(synchronize_session=False)
    )

    for row in rows:
        db.add(
            PaperCitation(
                paper_id=paper_id,
                direction=direction,
                source="openalex",
                **row,
            )
        )


def refresh_paper_citations(
    db: Session,
    paper: Paper,
    fetch=None,
    max_cited_by: int = 200,
) -> dict:
    """
    Refresh one paper's cached OpenAlex citation neighborhood.

    Resolves https://api.openalex.org/works/doi:{doi}, stores
    referenced_works as direction "cites", then fetches
    cited_by_api_url once (up to max_cited_by citers) as "cited_by".
    DOIs found on citing works are matched against local Paper.doi
    and recorded as matched_paper_id.

    The refresh is idempotent -- each direction is deleted and
    reinserted -- so re-running cannot duplicate rows and always
    converges on the latest payload.

    Never raises for network or parse problems: returns
    {"ok": False, "reason": ...} instead. A failure fetching the
    citers page keeps the references just stored and reports a
    "warning", because retrying is safe and partial data is useful.

    `fetch` is an injectable callable(url) -> dict for offline
    tests; the default uses urllib.request with a 15s timeout.
    """
    normalized_doi = normalize_doi(paper.doi)

    if not normalized_doi:
        return {"ok": False, "reason": "no_doi"}

    if fetch is None:
        fetch = _default_fetch

    work_url = openalex_work_url(normalized_doi)

    try:
        work = fetch(work_url)
    except Exception as error:
        # Any transport/parse failure -- offline, timeout, bad JSON.
        return {
            "ok": False,
            "reason": f"fetch_failed: {error}",
        }

    if not isinstance(work, dict) or not work.get("id"):
        return {"ok": False, "reason": "work_not_found"}

    doi_map = _local_doi_map(db)

    reference_rows = _external_rows(
        work.get("referenced_works"),
        doi_map,
    )

    citer_rows: list[dict] = []
    warning: str | None = None
    cited_by_url = work.get("cited_by_api_url")

    if not cited_by_url:
        # OpenAlex no longer includes cited_by_api_url in the default
        # single-work payload (verified live 2026-10: the field is
        # None even with a mailto). The equivalent query is the works
        # filter endpoint -- filter=cites:W... returns the citing
        # works in the same {"results": [...]} shape.
        work_id = _normalize_work_id(work.get("id"))

        if work_id:
            cited_by_url = (
                f"{OPENALEX_WORK_BASE}?filter=cites:{work_id}"
            )

    if cited_by_url and max_cited_by > 0:
        try:
            citers_page = fetch(
                _with_per_page(str(cited_by_url), OPENALEX_PER_PAGE)
            )

            if isinstance(citers_page, dict):
                citer_rows = _external_rows(
                    citers_page.get("results"),
                    doi_map,
                    limit=max_cited_by,
                )
        except Exception as error:
            warning = f"cited_by_failed: {error}"

    try:
        _replace_direction(db, paper.id, "cites", reference_rows)
        _replace_direction(db, paper.id, "cited_by", citer_rows)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()

        return {
            "ok": False,
            "reason": f"db_error: {error}",
        }

    result = {
        "ok": True,
        "paper_id": paper.id,
        "doi": normalized_doi,
        "cites": len(reference_rows),
        "cited_by": len(citer_rows),
        "matched": sum(
            1
            for row in reference_rows + citer_rows
            if row["matched_paper_id"] is not None
        ),
    }

    if warning:
        result["warning"] = warning

    return result


def citation_maps(
    db: Session,
    paper_ids: list[int] | None = None,
) -> tuple[dict[int, set[str]], dict[int, set[str]]]:
    """
    Load the cached citation graph as two paper-id -> key-set maps.

    Returns (references_by_paper, citers_by_paper). Keys follow the
    module scheme: "local:<paper_id>" for DOI-matched works and the
    normalized "W..." OpenAlex id otherwise -- both are present when
    a row was matched, so either side of a couple can meet.

    paper_ids limits the rows loaded to that node set (None = all).
    """
    if paper_ids is not None:
        wanted = set(paper_ids)

        if not wanted:
            return {}, {}

        query = db.query(
            PaperCitation.paper_id,
            PaperCitation.direction,
            PaperCitation.external_work_id,
            PaperCitation.matched_paper_id,
        ).filter(PaperCitation.paper_id.in_(wanted))
    else:
        query = db.query(
            PaperCitation.paper_id,
            PaperCitation.direction,
            PaperCitation.external_work_id,
            PaperCitation.matched_paper_id,
        )

    references_by_paper: dict[int, set[str]] = {}
    citers_by_paper: dict[int, set[str]] = {}

    for row in query.all():
        if row.direction == "cites":
            bucket = references_by_paper
        elif row.direction == "cited_by":
            bucket = citers_by_paper
        else:
            continue

        keys = bucket.setdefault(row.paper_id, set())

        if row.external_work_id:
            keys.add(row.external_work_id)

        if row.matched_paper_id is not None:
            keys.add(f"local:{row.matched_paper_id}")

    return references_by_paper, citers_by_paper


def _shared_pair_counts(
    mapping: dict[int, set[str]],
) -> dict[tuple[int, int], int]:
    """Count, per unordered paper pair, how many keys they share.

    Built from an inverted key -> papers index so the cost is
    proportional to the citation rows, not to n^2 pairs.
    """
    inverted: dict[str, list[int]] = {}

    for paper_id, keys in mapping.items():
        for key in keys:
            inverted.setdefault(key, []).append(paper_id)

    counts: dict[tuple[int, int], int] = {}

    for paper_ids in inverted.values():
        ordered = sorted(set(paper_ids))

        for index, left in enumerate(ordered):
            for right in ordered[index + 1:]:
                pair = (left, right)
                counts[pair] = counts.get(pair, 0) + 1

    return counts


def _ratio(shared: int, left: set[str], right: set[str]) -> float:
    """|shared| / max(1, min(|left|, |right|)), the coupling shape."""
    if shared <= 0:
        return 0.0

    return shared / max(1, min(len(left), len(right)))


def similarity_from_maps(
    references_by_paper: dict[int, set[str]],
    citers_by_paper: dict[int, set[str]],
    paper_ids: list[int] | None = None,
) -> dict[tuple[int, int], float]:
    """
    Pure pair scorer over already-loaded citation maps.

    Only pairs with at least one shared reference or citer are
    emitted; combined = 0.5*coupling + 0.5*cocitation, clamped to
    [0, 1]. Kept separate from citation_similarity so the graph can
    load rows once and reuse them for both weights and groups.
    """
    if paper_ids is None:
        universe = set(references_by_paper) | set(citers_by_paper)
    else:
        universe = set(paper_ids)

    reference_counts = _shared_pair_counts(references_by_paper)
    citer_counts = _shared_pair_counts(citers_by_paper)

    scores: dict[tuple[int, int], float] = {}

    for pair in set(reference_counts) | set(citer_counts):
        left, right = pair

        if left not in universe or right not in universe:
            continue

        coupling = _ratio(
            reference_counts.get(pair, 0),
            references_by_paper.get(left, set()),
            references_by_paper.get(right, set()),
        )
        cocitation = _ratio(
            citer_counts.get(pair, 0),
            citers_by_paper.get(left, set()),
            citers_by_paper.get(right, set()),
        )

        combined = 0.5 * coupling + 0.5 * cocitation

        if combined > 0:
            scores[pair] = max(0.0, min(1.0, combined))

    return scores


def citation_similarity(
    db: Session,
    paper_ids: list[int] | None = None,
) -> dict[tuple[int, int], float]:
    """DB-backed pair similarity map (see similarity_from_maps)."""
    references_by_paper, citers_by_paper = citation_maps(db, paper_ids)

    return similarity_from_maps(
        references_by_paper,
        citers_by_paper,
        paper_ids,
    )


def related_by_citation(
    db: Session,
    paper_id: int,
    top_k: int = 10,
) -> list[tuple[int, float]]:
    """Local papers most related to paper_id by citation overlap.

    Best score first; ties break by the smaller paper id so the
    order is deterministic.
    """
    if top_k <= 0:
        return []

    scores = citation_similarity(db)

    related: list[tuple[int, float]] = []

    for (left, right), score in scores.items():
        if left == paper_id:
            related.append((right, score))
        elif right == paper_id:
            related.append((left, score))

    related.sort(key=lambda item: (-item[1], item[0]))

    return related[:top_k]


def citation_stats(db: Session) -> dict:
    """Cache size by direction plus DOI coverage of the library."""
    by_direction = {"cites": 0, "cited_by": 0}

    rows = (
        db.query(
            PaperCitation.direction,
            func.count(PaperCitation.id),
        )
        .group_by(PaperCitation.direction)
        .all()
    )

    for direction, count in rows:
        if direction in by_direction:
            by_direction[direction] = count

    matched = (
        db.query(func.count(PaperCitation.id))
        .filter(PaperCitation.matched_paper_id.isnot(None))
        .scalar()
        or 0
    )

    papers_with_doi = (
        db.query(func.count(Paper.id))
        .filter(Paper.doi.isnot(None))
        .scalar()
        or 0
    )

    return {
        "total": sum(by_direction.values()),
        "by_direction": by_direction,
        "matched": matched,
        "papers_with_doi": papers_with_doi,
    }


def clustered_works(
    db: Session,
    paper_ids: list[int],
    *,
    min_mentions: int = 2,
    limit: int = 12,
) -> tuple[list[dict], list[dict]]:
    """Cluster the cached citations of a paper set into two lists.

    Returns (prior_works, derivative_works):

        prior_works      -- external works most commonly cited BY the
                            papers in the set ("the seminal works").
        derivative_works -- external works that cite the most papers
                            in the set ("surveys / recent follow-ups").

    Only works mentioned by at least `min_mentions` papers are kept
    (a single mention is not a pattern), sorted by mention count.

    Each entry:
        {
          work_id, label, doi, is_local, matched_paper_id,
          graph_paper_ids: [paper ids that reference (or are cited
                            by) the work], count,
        }

    Labels prefer the local paper a work matched to; otherwise the
    stored DOI; otherwise the raw OpenAlex id. No network calls.
    """
    wanted = sorted(set(paper_ids))

    if not wanted:
        return [], []

    rows = (
        db.query(PaperCitation)
        .filter(PaperCitation.paper_id.in_(wanted))
        .all()
    )

    grouped: dict[str, dict] = {
        "cites": {},
        "cited_by": {},
    }

    for row in rows:
        bucket = grouped.get(row.direction)

        if bucket is None:
            continue

        entry = bucket.setdefault(
            row.external_work_id,
            {
                "work_id": row.external_work_id,
                "doi": None,
                "matched_paper_id": None,
                "graph_paper_ids": set(),
            },
        )

        entry["graph_paper_ids"].add(row.paper_id)

        if entry["doi"] is None and row.external_doi:
            entry["doi"] = row.external_doi

        if entry["matched_paper_id"] is None and row.matched_paper_id:
            entry["matched_paper_id"] = row.matched_paper_id

    matched_ids = {
        entry["matched_paper_id"]
        for bucket in grouped.values()
        for entry in bucket.values()
        if entry["matched_paper_id"] is not None
    }

    titles: dict[int, str] = {}

    if matched_ids:
        title_rows = (
            db.query(Paper.id, Paper.title)
            .filter(Paper.id.in_(sorted(matched_ids)))
            .all()
        )
        titles = {paper_id: title for paper_id, title in title_rows}

    def finalize(bucket: dict) -> list[dict]:
        entries: list[dict] = []

        for entry in bucket.values():
            count = len(entry["graph_paper_ids"])

            if count < min_mentions:
                continue

            matched = entry["matched_paper_id"]
            label = (
                titles.get(matched)
                or (f"DOI {entry['doi']}" if entry["doi"] else None)
                or entry["work_id"]
            )

            entries.append(
                {
                    "work_id": entry["work_id"],
                    "label": label,
                    "doi": entry["doi"],
                    "is_local": matched is not None,
                    "matched_paper_id": matched,
                    "graph_paper_ids": sorted(entry["graph_paper_ids"]),
                    "count": count,
                }
            )

        entries.sort(key=lambda item: (-item["count"], item["label"]))

        return entries[:limit]

    return finalize(grouped["cites"]), finalize(grouped["cited_by"])


OPENALEX_DOI_BATCH = 50


def gathered_work_map(db: Session) -> dict[str, int]:
    """OpenAlex work id -> local paper id for papers imported by the
    literature gather, which records its source as ``openalex:W...``.
    Exact and free: no network needed to know these papers' ids."""

    mapping: dict[str, int] = {}

    for paper_id, source in (
        db.query(Paper.id, Paper.source_filename)
        .filter(Paper.source_filename.like("openalex:W%"))
        .all()
    ):
        work_id = _normalize_work_id(source.split(":", 1)[1])

        if work_id:
            mapping[work_id] = paper_id

    return mapping


def link_reference_rows(db: Session, fetch=None) -> dict:
    """
    Resolve cached citation rows to local papers by OpenAlex work id.

    ``referenced_works`` come back as bare OpenAlex ids with no DOI, so
    a "cites" row can never be matched by DOI the way a "cited_by" row
    can, and ``matched_paper_id`` stays NULL for every reference. That
    leaves nothing to treat as ground truth: no paper has a resolved
    reference list, so leave-one-out tournaments have no queries.

    The work ids come from two places. Papers imported by the
    literature gather carry theirs in ``source_filename`` (free). For
    every other local paper with a DOI, OpenAlex is asked for the id
    (batched, ``filter=doi:a|b|c``). Every row -- either direction --
    whose ``external_work_id`` is one of those ids gets its
    ``matched_paper_id``. Rows already matched are left alone, so it
    is safe to re-run.

    Network trouble on one batch skips that batch and reports it;
    nothing raises. ``fetch`` is injectable like
    ``refresh_paper_citations``.
    """

    fetch = fetch or _default_fetch
    work_to_paper: dict[str, int] = dict(gathered_work_map(db))
    known_papers = set(work_to_paper.values())
    doi_map = {
        doi: paper_id
        for doi, paper_id in _local_doi_map(db).items()
        if paper_id not in known_papers
    }
    failed_batches = 0
    dois = sorted(doi_map)

    for start in range(0, len(dois), OPENALEX_DOI_BATCH):
        batch = dois[start : start + OPENALEX_DOI_BATCH]
        url = (
            f"{OPENALEX_WORK_BASE}?filter=doi:{'|'.join(batch)}"
            f"&select=id,doi&per-page={OPENALEX_DOI_BATCH}"
        )

        try:
            page = fetch(url)
        except Exception:
            failed_batches += 1
            continue

        for entry in (page or {}).get("results") or []:
            work_id = _normalize_work_id(entry.get("id"))
            paper_id = doi_map.get(normalize_doi(entry.get("doi")) or "")

            if work_id and paper_id is not None:
                work_to_paper[work_id] = paper_id

    linked = 0

    work_ids = list(work_to_paper)

    # Chunked: an IN list over thousands of ids can exceed SQLite's
    # bound-variable limit on older builds.
    for start in range(0, len(work_ids), 500):
        rows = (
            db.query(PaperCitation)
            .filter(PaperCitation.matched_paper_id.is_(None))
            .filter(
                PaperCitation.external_work_id.in_(
                    work_ids[start : start + 500]
                )
            )
            .all()
        )

        for row in rows:
            target = work_to_paper[row.external_work_id]

            # A paper citing itself is a data glitch, not a reference.
            if target != row.paper_id:
                row.matched_paper_id = target
                linked += 1

    db.commit()

    return {
        "ok": failed_batches == 0,
        "local_papers_with_doi": len(dois),
        "work_ids_found": len(work_to_paper),
        "rows_linked": linked,
        "failed_batches": failed_batches,
    }

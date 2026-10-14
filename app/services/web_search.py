"""
Web-based scholarly search across legitimate, keyless APIs.

Google Scholar offers no official API, and scraping it breaks its
ToS (the same conclusion documented in pdf_finder.py). The sources
used here are the legitimate equivalents that reference managers --
including Zotero -- actually build on:

    OpenAlex   open catalog of 250M+ works; citation counts, reliable
               open-access status, abstracts, retraction flags.
    Crossref   the DOI registry; publisher-deposited metadata for
               journals, proceedings and book chapters.
    arXiv      preprints (opt-in).
    DOAJ       open-access journal articles from vetted journals
               (opt-in).

All are free, keyless, and explicitly allow this kind of query.

PEER-REVIEWED FILTERING
    With peer_reviewed=True (the default) only publication types
    that went through peer review are returned:

        OpenAlex  type:article | book-chapter   (article covers
                  journal papers AND conference/proceedings papers;
                  preprints, datasets, reviews-of-articles excluded)
        Crossref  post-filtered to journal-article, proceedings-article
                  and book-chapter (belt and braces: the response types
                  are checked, never trusted blindly)

    Retracted works are excluded (OpenAlex is_retracted:false).
    With peer_reviewed=False, preprints/report-level material is
    included but datasets/patents/errata never are.

Open-access filtering uses OpenAlex's reliable OA flag; Crossref
metadata cannot say whether a full text is free, so when
open_access_only=True Crossref is skipped rather than guessing.
"""

from __future__ import annotations

import copy
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, asdict

from app.services.pdf_finder import (
    _get_with_retry,
    _reconstruct_openalex_abstract,
    source_health,
    UNPAYWALL_CONTACT_EMAIL,
)
from app.services.identifier_resolver import (
    _format_crossref_authors,
    _strip_markup,
    _DOCUMENT_TYPE_MAP,
)

logger = logging.getLogger(__name__)

# Sorts accepted by the API endpoint.
VALID_SORTS = ("relevance", "citations", "year")

# Publication types that passed peer review.
PEER_REVIEWED_TYPES = {"journal-article", "proceedings-article", "book-chapter"}

# Included only when the user explicitly opts out of the
# peer-reviewed filter.
NON_PEER_TYPES = {"posted-content", "report", "book", "monograph"}

SOURCES = ("openalex", "crossref", "arxiv", "doaj")

OPENALEX_TYPE_FILTER = "type:article|book-chapter"

_ABSTRACT_MAX_CHARS = 4000

CACHE_TTL_SECONDS = 10 * 60
CACHE_MAX_ENTRIES = 256
_CACHE_LOCK = threading.Lock()
_CACHE: dict[tuple, tuple[float, list["WebSearchResult"]]] = {}

# Identical queries that arrive while an identical query is already in
# flight wait on its Event instead of opening a second set of upstream
# requests. Search-as-you-type fires near-duplicate queries constantly,
# and without this a burst of keystrokes multiplies the API load.
_INFLIGHT: dict[tuple, threading.Event] = {}

# One shared pool for the whole process: web_search is called from
# FastAPI's threadpool and from the Arena/Lab request handlers, so
# these threads are reused and connections stay warm.
_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="websearch")

# Hard ceiling on the fan-out. OpenAlex and Crossref normally answer in
# well under 2s; past this the user is better served by the results in
# hand than by waiting on a source that is not coming back.
FANOUT_DEADLINE_SECONDS = 8.0

# A follower waits this long for the leader before doing the work
# itself, so a leader that dies can never wedge a caller forever.
_INFLIGHT_WAIT_SECONDS = 30.0

# ---------------------------------------------------------------------
# Circuit breaker
#
# OpenAlex rate-limits unauthenticated bursts and answers 429 with
# Retry-After. _get_with_retry honors that politely, which is right for
# a one-off request and badly wrong for an interactive search: the
# ladder sleeps up to MAX_429_BACKOFF_SECONDS twice, so a single
# rate-limited source dragged a whole three-source response to ~16s
# while Crossref and arXiv had already answered in under a second.
#
# Once a source rate-limits repeatedly, stop asking it for a while and
# serve the sources that do work. The breaker is per-process and
# intentionally blunt -- it exists to stop a hot source from taxing
# every keystroke, not to model the limit precisely.
# ---------------------------------------------------------------------

# One 429 is enough. With respect_429_backoff=False an interactive
# search gives up on the source immediately rather than sleeping, so
# skipping it for a while IS the polite behavior -- and the cooldown is
# far longer than the Retry-After any of these APIs asks for.
BREAKER_TRIP_AFTER_429 = 1
BREAKER_COOLDOWN_SECONDS = 90.0
_BREAKER_OPEN_UNTIL: dict[str, float] = {}
_BREAKER_LOCK = threading.Lock()

# _get_with_retry records health under its own label, which the three
# _search_* functions set to "<source>-search". That suffix keeps web
# search's counters separate from pdf_finder's calls to the same
# upstream APIs, so the breaker must look health up by the label rather
# than by the bare source name.
_SEARCH_LABELS = {
    "openalex": "openalex-search",
    "crossref": "crossref-search",
    "arxiv": "arxiv-search",
    "doaj": "doaj-search",
}


def _breaker_open(source: str) -> bool:
    with _BREAKER_LOCK:
        until = _BREAKER_OPEN_UNTIL.get(source, 0.0)

        if until <= time.monotonic():
            _BREAKER_OPEN_UNTIL.pop(source, None)
            return False

        return True


def _breaker_trip(source: str) -> None:
    health = source_health(_SEARCH_LABELS.get(source, source))

    if health.get("consecutive_429", 0) < BREAKER_TRIP_AFTER_429:
        return

    with _BREAKER_LOCK:
        _BREAKER_OPEN_UNTIL[source] = (
            time.monotonic() + BREAKER_COOLDOWN_SECONDS
        )

    logger.warning(
        "[web_search] %s rate-limited repeatedly; skipping it for %.0fs",
        source, BREAKER_COOLDOWN_SECONDS,
    )


class WebSearchError(Exception):
    """Every requested source failed -- nothing was searched."""


@dataclass
class WebSearchResult:
    """One hit, normalized across sources."""

    title: str
    author: str | None = None
    abstract: str | None = None
    publication_year: int | None = None
    doi: str | None = None
    venue: str | None = None
    source: str = "openalex"  # provenance: which API answered
    citations: int | None = None
    is_oa: bool | None = None  # None = unknown (Crossref can't tell)
    landing_url: str | None = None
    document_type: str | None = None
    pdf_url: str | None = None  # direct full-text link (arXiv)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------
# OpenAlex
# ---------------------------------------------------------------------

_OPENALEX_SELECT = ",".join(
    [
        "id",
        "doi",
        "display_name",
        "authorships",
        "publication_year",
        "type",
        "cited_by_count",
        "open_access",
        "primary_location",
        "abstract_inverted_index",
    ]
)


def _openalex_document_type(work: dict, venue: str | None) -> str | None:
    if work.get("type") == "book-chapter":
        return "Book Chapter"

    source = (work.get("primary_location") or {}).get("source") or {}

    if source.get("type") == "conference":
        return "Conference Paper"

    if venue and re.search(
        r"conference|proceedings|symposium|workshop|congress",
        venue,
        re.I,
    ):
        return "Conference Paper"

    return "Journal Article"


def _search_openalex(
    query: str,
    *,
    year_min: int | None,
    year_max: int | None,
    peer_reviewed: bool,
    open_access_only: bool,
    sort: str,
    limit: int,
) -> list[WebSearchResult] | None:
    filters = ["is_retracted:false"]

    if peer_reviewed:
        filters.append(OPENALEX_TYPE_FILTER)

    if open_access_only:
        filters.append("open_access.is_oa:true")

    if year_min is not None:
        filters.append(f"from_publication_date:{year_min}-01-01")

    if year_max is not None:
        filters.append(f"to_publication_date:{year_max}-12-31")

    params: dict = {
        "search": query,
        "filter": ",".join(filters),
        "per-page": min(max(limit * 2, limit), 40),
        "select": _OPENALEX_SELECT,
        "mailto": UNPAYWALL_CONTACT_EMAIL,
    }

    if sort == "citations":
        params["sort"] = "cited_by_count:desc"
    elif sort == "year":
        params["sort"] = "publication_date:desc"
    # relevance: OpenAlex's default ranking for `search`.

    response = _get_with_retry(
        "https://api.openalex.org/works",
        params=params,
        source="openalex-search",
        respect_429_backoff=False,
    )

    if response is None or not response.ok:
        logger.debug(
            "[web_search] OpenAlex unavailable (status=%s)",
            getattr(response, "status_code", None),
        )
        return None

    try:
        works = response.json().get("results") or []
    except ValueError:
        return None

    results: list[WebSearchResult] = []

    for work in works:
        title = (work.get("display_name") or "").strip()

        if not title:
            continue

        # Server-side type filter is not the only line of defense.
        if peer_reviewed and work.get("type") not in ("article", "book-chapter"):
            continue

        source = (work.get("primary_location") or {}).get("source") or {}
        venue = (source.get("display_name") or "").strip() or None

        authors = "; ".join(
            (
                (authorship.get("author") or {}).get("display_name") or ""
            ).strip()
            for authorship in work.get("authorships") or []
        ).strip("; ")
        authors = authors or None

        doi = work.get("doi") or ""
        if doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/"):]
        doi = doi or None

        landing_url = (
            (work.get("primary_location") or {}).get("landing_page_url")
            or (f"https://doi.org/{doi}" if doi else None)
        )

        abstract = _reconstruct_openalex_abstract(
            work.get("abstract_inverted_index")
        )
        if abstract and len(abstract) > _ABSTRACT_MAX_CHARS:
            abstract = abstract[:_ABSTRACT_MAX_CHARS]

        open_access = (work.get("open_access") or {}).get("is_oa")

        results.append(
            WebSearchResult(
                title=title,
                author=authors,
                abstract=abstract,
                publication_year=work.get("publication_year"),
                doi=doi,
                venue=venue,
                source="openalex",
                citations=work.get("cited_by_count"),
                is_oa=bool(open_access) if open_access is not None else None,
                landing_url=landing_url,
                document_type=_openalex_document_type(work, venue),
            )
        )

    return results


# ---------------------------------------------------------------------
# Crossref
# ---------------------------------------------------------------------

_CROSSREF_SELECT = ",".join(
    [
        "DOI",
        "title",
        "author",
        "issued",
        "container-title",
        "type",
        "abstract",
        "is-referenced-by-count",
        "URL",
    ]
)


def _search_crossref(
    query: str,
    *,
    year_min: int | None,
    year_max: int | None,
    peer_reviewed: bool,
    sort: str,
    limit: int,
) -> list[WebSearchResult] | None:
    filters: list[str] = []

    if year_min is not None:
        filters.append(f"from-pub-date:{year_min}-01-01")

    if year_max is not None:
        filters.append(f"until-pub-date:{year_max}-12-31")

    params: dict = {
        "query": query,
        "rows": min(max(limit * 2, limit), 40),
        "select": _CROSSREF_SELECT,
    }

    if filters:
        params["filter"] = ",".join(filters)

    if sort == "citations":
        params["sort"] = "is-referenced-by-count"
        params["order"] = "desc"
    elif sort == "year":
        params["sort"] = "published"
        params["order"] = "desc"
    # relevance: Crossref's default (relevance score).

    response = _get_with_retry(
        "https://api.crossref.org/works",
        params=params,
        headers={
            "User-Agent": (
                f"PaperRec/1.0 (mailto:{UNPAYWALL_CONTACT_EMAIL})"
            ),
        },
        source="crossref-search",
        respect_429_backoff=False,
    )

    if response is None or not response.ok:
        logger.debug(
            "[web_search] Crossref unavailable (status=%s)",
            getattr(response, "status_code", None),
        )
        return None

    try:
        items = response.json().get("message", {}).get("items") or []
    except ValueError:
        return None

    allowed_types = PEER_REVIEWED_TYPES if peer_reviewed else (
        PEER_REVIEWED_TYPES | NON_PEER_TYPES
    )

    results: list[WebSearchResult] = []

    for item in items:
        item_type = item.get("type") or ""

        # Never trust the upstream filter alone -- check every item.
        if item_type not in allowed_types:
            continue

        titles = item.get("title") or []
        title = (titles[0] if titles else "").strip()

        if not title:
            continue

        containers = item.get("container-title") or []
        venue = (containers[0] if containers else "").strip() or None

        doi = (item.get("DOI") or "").strip() or None

        date_parts = (item.get("issued") or {}).get("date-parts") or []
        year = None
        if date_parts and date_parts[0]:
            year = date_parts[0][0]

        abstract = _strip_markup(item.get("abstract"))
        if abstract and len(abstract) > _ABSTRACT_MAX_CHARS:
            abstract = abstract[:_ABSTRACT_MAX_CHARS]

        citations = item.get("is-referenced-by-count")

        results.append(
            WebSearchResult(
                title=title,
                author=_format_crossref_authors(item.get("author")),
                abstract=abstract,
                publication_year=int(year) if year else None,
                doi=doi,
                venue=venue,
                source="crossref",
                citations=int(citations) if citations is not None else None,
                # Crossref has no reliable OA flag -- unknown, not False.
                is_oa=None,
                landing_url=(item.get("URL") or None),
                document_type=_DOCUMENT_TYPE_MAP.get(item_type),
            )
        )

    return results


# ---------------------------------------------------------------------
# arXiv
# ---------------------------------------------------------------------

_ARXIV_API = "https://export.arxiv.org/api/query"
_ARXIV_NS = {"a": "http://www.w3.org/2005/Atom"}


def _search_arxiv(
    query: str,
    *,
    year_min: int | None,
    year_max: int | None,
    sort: str,
    limit: int,
) -> list[WebSearchResult] | None:
    """Query the arXiv Atom API (official, keyless).

    arXiv is a preprint server: its records are open access with a
    direct PDF link. Results are marked "Preprint" so the UI can
    say so, and the peer-reviewed default does not apply to this
    source; selecting arXiv is an explicit opt-in to preprints.
    """

    params: dict = {
        # Unquoted: arXiv ANDs the terms (quoted phrases require
        # exact adjacency and return nothing for long queries).
        "search_query": f"all:{query}",
        "start": 0,
        "max_results": min(max(limit * 2, limit), 40),
        "sortBy": "submittedDate" if sort == "year" else "relevance",
        "sortOrder": "descending",
    }

    response = _get_with_retry(
        _ARXIV_API,
        params=params,
        source="arxiv-search",
        respect_429_backoff=False,
    )

    if response is None or not response.ok:
        logger.debug(
            "[web_search] arXiv unavailable (status=%s)",
            getattr(response, "status_code", None),
        )
        return None

    try:
        root = ET.fromstring(response.content)
    except ET.ParseError:
        return None

    results: list[WebSearchResult] = []

    for entry in root.findall("a:entry", _ARXIV_NS):
        title = " ".join(
            (entry.findtext("a:title", "", _ARXIV_NS) or "").split()
        )

        if not title or title.lower() == "error":
            continue

        authors = "; ".join(
            " ".join((name.text or "").split())
            for name in entry.findall("a:author/a:name", _ARXIV_NS)
            if (name.text or "").strip()
        ) or None

        summary = " ".join(
            (entry.findtext("a:summary", "", _ARXIV_NS) or "").split()
        ) or None
        if summary and len(summary) > _ABSTRACT_MAX_CHARS:
            summary = summary[:_ABSTRACT_MAX_CHARS]

        published = entry.findtext("a:published", "", _ARXIV_NS) or ""
        year = (
            int(published[:4])
            if len(published) >= 4 and published[:4].isdigit()
            else None
        )

        if year_min is not None and year is not None and year < year_min:
            continue
        if year_max is not None and year is not None and year > year_max:
            continue

        abs_url = (entry.findtext("a:id", "", _ARXIV_NS) or "").strip() or None

        pdf_url = None
        if abs_url:
            arxiv_id = re.search(r"abs/(.+)$", abs_url)
            if arxiv_id:
                pdf_url = f"https://arxiv.org/pdf/{arxiv_id.group(1)}.pdf"

        results.append(
            WebSearchResult(
                title=title,
                author=authors,
                abstract=summary,
                publication_year=year,
                doi=None,
                venue="arXiv",
                source="arxiv",
                citations=None,
                is_oa=True,
                landing_url=abs_url,
                document_type="Preprint",
                pdf_url=pdf_url,
            )
        )

    return results


# ---------------------------------------------------------------------
# DOAJ
# ---------------------------------------------------------------------

_DOAJ_API = "https://doaj.org/api/search/articles/"

# Characters with meaning in Elasticsearch query strings. A user query
# is free text, so they are neutralised rather than interpreted (the
# query travels in the URL path, where "/" would also break routing).
_DOAJ_SPECIAL = re.compile(r'[+\-=&|><!(){}\[\]^"~*?:\\/]')


def _doaj_clean_query(query: str) -> str:
    cleaned = _DOAJ_SPECIAL.sub(" ", query)
    # Bare AND / OR / NOT would be read as operators.
    words = [
        word.lower() if word in ("AND", "OR", "NOT") else word
        for word in cleaned.split()
    ]
    return " ".join(words)


def _search_doaj(
    query: str,
    *,
    year_min: int | None,
    year_max: int | None,
    sort: str,
    limit: int,
) -> list[WebSearchResult] | None:
    """Query the DOAJ article search API (official, keyless).

    DOAJ indexes only open-access articles from vetted journals, so
    every hit is open access and a journal article; the peer-reviewed
    default needs no special handling. Opt-in like arXiv.

    DOAJ has no citation counts, and sorting server-side on
    bibjson.year times out upstream, so "year" and "citations" are
    handled by the shared merge (relevance order is requested).
    """

    cleaned = _doaj_clean_query(query)

    if not cleaned:
        return []

    # Year filter as an Elasticsearch range appended to the query.
    if year_min is not None or year_max is not None:
        low = str(year_min) if year_min is not None else "*"
        high = str(year_max) if year_max is not None else "*"
        cleaned = f"({cleaned}) AND bibjson.year:[{low} TO {high}]"

    response = _get_with_retry(
        _DOAJ_API + quote(cleaned, safe=""),
        params={
            "page": 1,
            "pageSize": min(max(limit * 2, limit), 40),
        },
        headers={
            "User-Agent": (
                f"PaperRec/1.0 (mailto:{UNPAYWALL_CONTACT_EMAIL})"
            ),
        },
        source="doaj-search",
        respect_429_backoff=False,
    )

    if response is None or not response.ok:
        logger.debug(
            "[web_search] DOAJ unavailable (status=%s)",
            getattr(response, "status_code", None),
        )
        return None

    try:
        items = response.json().get("results") or []
    except ValueError:
        return None

    results: list[WebSearchResult] = []

    for item in items:
        bib = item.get("bibjson") or {}

        title = " ".join((bib.get("title") or "").split())

        if not title:
            continue

        doi = None
        for identifier in bib.get("identifier") or []:
            if (
                isinstance(identifier, dict)
                and (identifier.get("type") or "").lower() == "doi"
                and (identifier.get("id") or "").strip()
            ):
                doi = _normalize_doi(identifier["id"])
                break

        year_raw = str(bib.get("year") or "").strip()
        year = int(year_raw) if year_raw.isdigit() else None

        # Never trust the upstream filter alone.
        if year_min is not None and year is not None and year < year_min:
            continue
        if year_max is not None and year is not None and year > year_max:
            continue

        authors = "; ".join(
            " ".join((author.get("name") or "").split())
            for author in bib.get("author") or []
            if isinstance(author, dict)
            and (author.get("name") or "").strip()
        ) or None

        abstract = " ".join((bib.get("abstract") or "").split()) or None
        if abstract and len(abstract) > _ABSTRACT_MAX_CHARS:
            abstract = abstract[:_ABSTRACT_MAX_CHARS]

        venue = (
            (bib.get("journal") or {}).get("title") or ""
        ).strip() or None

        landing_url = None
        pdf_url = None
        for link in bib.get("link") or []:
            if not isinstance(link, dict):
                continue
            url = (link.get("url") or "").strip()
            if not url or (link.get("type") or "") != "fulltext":
                continue
            landing_url = landing_url or url
            if pdf_url is None and url.lower().split("?")[0].endswith(
                ".pdf"
            ):
                pdf_url = url

        if landing_url is None and doi:
            landing_url = f"https://doi.org/{doi}"

        results.append(
            WebSearchResult(
                title=title,
                author=authors,
                abstract=abstract,
                publication_year=year,
                doi=doi,
                venue=venue,
                source="doaj",
                citations=None,
                # DOAJ lists open-access journals only.
                is_oa=True,
                landing_url=landing_url,
                document_type=_DOCUMENT_TYPE_MAP["journal-article"],
                pdf_url=pdf_url,
            )
        )

    return results


# ---------------------------------------------------------------------
# Merge + cache
# ---------------------------------------------------------------------

def _normalize_doi(doi: str | None) -> str | None:
    if not doi:
        return None

    return doi.strip().lower().removeprefix("https://doi.org/")


def _normalize_title(title: str) -> str:
    return re.sub(r"[^\w\s]", " ", title.lower()).split()


def _title_key(title: str, year: int | None) -> tuple:
    return (" ".join(_normalize_title(title)), year)


def _interleave(*lists: list[WebSearchResult]) -> list[WebSearchResult]:
    """Round-robin so a relevance search blends all sources fairly."""
    merged: list[WebSearchResult] = []
    longest = max((len(items) for items in lists), default=0)

    for index in range(longest):
        for items in lists:
            if index < len(items):
                merged.append(items[index])

    return merged


def _merge(
    openalex_results: list[WebSearchResult],
    crossref_results: list[WebSearchResult],
    arxiv_results: list[WebSearchResult],
    doaj_results: list[WebSearchResult] | None,
    sort: str,
    limit: int,
) -> list[WebSearchResult]:
    if sort == "citations":
        candidates = (
            openalex_results + crossref_results + arxiv_results
            + (doaj_results or [])
        )
        candidates.sort(
            key=lambda result: result.citations or 0,
            reverse=True,
        )
    elif sort == "year":
        candidates = (
            openalex_results + crossref_results + arxiv_results
            + (doaj_results or [])
        )
        candidates.sort(
            key=lambda result: result.publication_year or 0,
            reverse=True,
        )
    else:
        # Relevance: interleave the ranked lists.
        candidates = _interleave(
            openalex_results,
            crossref_results,
            arxiv_results,
            doaj_results or [],
        )

    # Deduplicate: DOI first (OpenAlex entries win -- they carry
    # abstracts and OA status), then normalized title + year.
    seen_dois: set[str] = set()
    seen_titles: set[tuple] = set()
    unique: list[WebSearchResult] = []

    for result in candidates:
        doi = _normalize_doi(result.doi)

        if doi:
            if doi in seen_dois:
                continue
            seen_dois.add(doi)

        title_key = _title_key(result.title, result.publication_year)

        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)

        unique.append(result)

    return unique[:limit]


def _fetch_source(
    source: str,
    query: str,
    *,
    year_min: int | None,
    year_max: int | None,
    peer_reviewed: bool,
    open_access_only: bool,
    sort: str,
    limit: int,
) -> list[WebSearchResult] | None:
    """Run one source's query. Never raises -- a failure is None."""

    if _breaker_open(source):
        logger.debug("[web_search] %s breaker open, skipping", source)
        return None

    try:
        if source == "openalex":
            results = _search_openalex(
                query,
                year_min=year_min,
                year_max=year_max,
                peer_reviewed=peer_reviewed,
                open_access_only=open_access_only,
                sort=sort,
                limit=limit,
            )
        elif source == "crossref":
            results = _search_crossref(
                query,
                year_min=year_min,
                year_max=year_max,
                peer_reviewed=peer_reviewed,
                sort=sort,
                limit=limit,
            )
        elif source == "doaj":
            # DOAJ is open-access journal articles only; opt-in.
            results = _search_doaj(
                query,
                year_min=year_min,
                year_max=year_max,
                sort=sort,
                limit=limit,
            )
        else:
            # arXiv is an explicit opt-in source: it runs even under the
            # peer-reviewed default because choosing it is the user's
            # signal that preprints are welcome.
            results = _search_arxiv(
                query,
                year_min=year_min,
                year_max=year_max,
                sort=sort,
                limit=limit,
            )

    except Exception as error:  # noqa: BLE001 - one bad source must
        # not sink the other two; the caller only gives up when every
        # source failed. Logged with a traceback so a bug here shows
        # up as a crash rather than passing for "source is down".
        logger.exception("[web_search] %s raised", source)
        return None

    _breaker_trip(source)

    return results


def search_web(
    query: str,
    *,
    year_min: int | None = None,
    year_max: int | None = None,
    peer_reviewed: bool = True,
    open_access_only: bool = False,
    sources: tuple[str, ...] = SOURCES,
    sort: str = "relevance",
    limit: int = 15,
) -> list[WebSearchResult]:
    """
    Query the requested sources and return one merged, deduplicated,
    peer-reviewed-by-default result list. Raises WebSearchError only
    when EVERY requested source failed (so a single flaky API still
    yields partial results).

    Sources are fetched concurrently, so wall-clock time tracks the
    slowest source rather than their sum.
    """
    query = (query or "").strip()

    if not query:
        return []

    requested = tuple(
        source for source in sources if source in SOURCES
    ) or SOURCES

    # Open-access-only relies on OpenAlex's OA flag; Crossref cannot
    # answer that question, so it is dropped rather than guessed.
    # arXiv and DOAJ are open access by nature and stay.
    if open_access_only and "crossref" in requested:
        requested = tuple(s for s in requested if s != "crossref")

    if not requested:
        requested = ("openalex",)

    cache_key = (
        query,
        year_min,
        year_max,
        peer_reviewed,
        open_access_only,
        requested,
        sort,
        limit,
    )

    now = time.monotonic()

    event: threading.Event | None = None
    leader_event: threading.Event | None = None

    with _CACHE_LOCK:
        entry = _CACHE.get(cache_key)

        if entry and entry[0] > now:
            return copy.deepcopy(entry[1])

        if entry:
            _CACHE.pop(cache_key, None)

        # Join an identical search already running, or become the one
        # that runs it.
        leader_event = _INFLIGHT.get(cache_key)
        is_leader = leader_event is None

        if is_leader:
            event = threading.Event()
            _INFLIGHT[cache_key] = event

    if not is_leader and leader_event is not None:
        # Someone else is already paying for this query.
        leader_event.wait(timeout=_INFLIGHT_WAIT_SECONDS)

        with _CACHE_LOCK:
            entry = _CACHE.get(cache_key)

            if entry and entry[0] > time.monotonic():
                return copy.deepcopy(entry[1])

        # The leader finished without caching anything (every source
        # failed). Fall through and try it ourselves rather than
        # returning an error the caller did not cause.

    try:
        merged = _search_all_sources(
            query,
            requested=requested,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access_only,
            sort=sort,
            limit=limit,
        )

    except WebSearchError:
        if is_leader:
            with _CACHE_LOCK:
                _INFLIGHT.pop(cache_key, None)

            event.set()

        raise

    with _CACHE_LOCK:
        if len(_CACHE) >= CACHE_MAX_ENTRIES:
            expired = [
                key
                for key, (expiry, _) in _CACHE.items()
                if expiry <= now
            ]
            for key in expired:
                _CACHE.pop(key, None)

            while len(_CACHE) >= CACHE_MAX_ENTRIES:
                _CACHE.pop(next(iter(_CACHE)))

        _CACHE[cache_key] = (
            time.monotonic() + CACHE_TTL_SECONDS,
            copy.deepcopy(merged),
        )

    if is_leader:
        with _CACHE_LOCK:
            _INFLIGHT.pop(cache_key, None)

        event.set()

    return merged


def _search_all_sources(
    query: str,
    *,
    requested: tuple[str, ...],
    year_min: int | None,
    year_max: int | None,
    peer_reviewed: bool,
    open_access_only: bool,
    sort: str,
    limit: int,
) -> tuple[list[WebSearchResult], bool]:
    """Fan every requested source out at once and merge the answers.

    Raises WebSearchError when every source failed, which the caller
    deliberately leaves uncached so the next attempt retries instead
    of replaying the outage for the whole TTL.
    """

    futures = {
        source: _EXECUTOR.submit(
            _fetch_source,
            source,
            query,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access_only,
            sort=sort,
            limit=limit,
        )
        for source in requested
    }

    # Wait up to the fan-out deadline, then take whatever answered.
    # A straggler is left running on the pool (its result is simply
    # dropped), so one wedged source cannot hold the whole response.
    done, pending = wait(
        futures.values(), timeout=FANOUT_DEADLINE_SECONDS
    )

    if pending:
        logger.warning(
            "[web_search] %d/%d sources missed the %.0fs deadline: %s",
            len(pending), len(futures), FANOUT_DEADLINE_SECONDS,
            ", ".join(
                sorted(
                    source
                    for source, future in futures.items()
                    if future in pending
                )
            ),
        )

    # Iterating `requested` (not `done`) keeps the merge deterministic:
    # which source wins a duplicate no longer depends on which one
    # happened to answer first.
    collected: dict[str, list[WebSearchResult] | None] = {}

    for source in requested:
        future = futures[source]

        if future in done:
            collected[source] = future.result()
        else:
            collected[source] = None

    openalex_results = collected.get("openalex")
    crossref_results = collected.get("crossref")
    arxiv_results = collected.get("arxiv")
    doaj_results = collected.get("doaj")

    if (
        openalex_results is None
        and crossref_results is None
        and arxiv_results is None
        and doaj_results is None
    ):
        raise WebSearchError("Every web search source failed.")

    merged = _merge(
        openalex_results or [],
        crossref_results or [],
        arxiv_results or [],
        doaj_results or [],
        sort,
        limit,
    )

    return merged

"""
Second-opinion citation neighborhoods -- Semantic Scholar and Crossref.

`web_connections.py` answers the "ON THE WEB" scope from OpenAlex alone,
because OpenAlex is the one source that hands back a work's references
*and* its citers in the same shape. That single-source rule leaves real
coverage on the table: the two graphs are built from different deposits,
so a work OpenAlex has never cited often has citers in Semantic Scholar,
and a reference OpenAlex dropped often survives in Crossref's deposit.

This module asks the other sources the same two questions and normalizes
the answers into OpenAlex's connection-card shape, so the caller can
union the lists without knowing where a row came from. Each card records
which sources vouched for it (`sources`), which is also what the UI shows
next to a row.

Every read goes through an injectable `fetch(url) -> dict` so tests run
offline, matching web_connections.py's seam.

Best-effort by construction: a source that 404s, rate-limits, or answers
with a shape we do not recognise contributes nothing and never raises.
The neighborhood is richer with these sources and correct without them.
"""

import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from app.services.citations import OPENALEX_REQUEST_TIMEOUT, normalize_doi

# Semantic Scholar's graph API. v1 needs no key; a key only raises the
# rate limit, so it is read when present (pdf_finder.py uses the same
# variable for the same upstream).
SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1"

# Crossref's REST API. Its polite pool wants a contact address; the same
# placeholder Unpaywall uses elsewhere in this codebase.
CROSSREF_WORKS_BASE = "https://api.crossref.org/works"
CROSSREF_MAILTO = "research-dev@example.com"

SEMANTIC_SCHOLAR_API_KEY = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()

# The fields we actually consume. Semantic Scholar rejects unknown
# fields with a 400, so this list has to stay in step with the parsing
# below.
_S2_FIELDS = "title,year,authors,externalIds,citationCount"

# How many candidates each source contributes per side. The union is
# capped later; this only bounds the fan-out.
S2_LIMIT = 20
CROSSREF_REFERENCE_LIMIT = 40

_S2_PAPER_ID = re.compile(r"\A[A-Za-z0-9]{1,40}\Z")


OPENALEX_REQUEST_TIMEOUT = 15.0

# The extra sources are asked in parallel and every one of them sits in
# the user's wait, so they get a shorter budget than OpenAlex's 15s.
# Measured against the live APIs, all of them answer in well under a
# second when healthy; 8s leaves room for a slow hop without letting one
# flaky provider hold the pane open. Europe PMC in particular drops
# connections outright every few calls, so a short timeout that fails
# fast is strictly better than a long one that eventually gives up.
EXTRA_SOURCE_TIMEOUT = 8.0


def _default_fetch(
    url: str,
    *,
    source: str = "",
    timeout: float = EXTRA_SOURCE_TIMEOUT,
) -> dict:
    """Default transport: urllib.request, JSON in, dict out.

    citations.py's transport cannot send the Semantic Scholar API key
    (it takes no headers), and this module is not OpenAlex, so it has its
    own. Transport errors propagate to the callers below, which treat
    them as "this source has nothing to add" and record the reason.
    """
    headers = {
        "Accept": "application/json",
        "User-Agent": "thesis-recommendation-system/1.0",
    }

    if source == "semantic_scholar" and SEMANTIC_SCHOLAR_API_KEY:
        headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY

    request = urllib.request.Request(url, headers=headers)

    with urllib.request.urlopen(
        request,
        timeout=timeout,
    ) as response:
        return json.loads(response.read().decode("utf-8"))


def _first_author(authors) -> str | None:
    """Semantic Scholar authors are [{"name": ...}]; Crossref's are
    {"given": ..., "family": ...}. Both collapse to one display name."""
    if not isinstance(authors, list) or not authors:
        return None

    first = authors[0]

    if isinstance(first, dict):
        name = (first.get("name") or "").strip()

        if name:
            return name

        given = (first.get("given") or "").strip()
        family = (first.get("family") or "").strip()

        if given or family:
            return f"{given} {family}".strip() or None

    return None


def _title_key(title: str | None) -> str:
    """Lowercased alphanumeric skeleton, for cross-source matching.

    Same normalization web_connections.py uses for its title lookup, so
    the two modules agree on what "the same paper" means.
    """
    return re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()


# Why a source contributed nothing is worth keeping. "This paper is not
# in Europe PMC" and "Europe PMC timed out" look identical from the
# outside -- both just mean no rows -- but they mean opposite things: one
# is a true statement about coverage, the other is a broken provider that
# will silently shrink the neighborhood on every call until someone
# notices. Measured live, Europe PMC drops roughly every third connection
# under load, so conflating the two would have hidden a real fault
# behind apparently-correct behaviour.
def _no_record(source: str) -> dict:
    """The source answered, and has no record of this work."""
    return {"ok": False, "source": source, "reason": "no_record"}


def _unavailable(source: str, detail: str = "") -> dict:
    """The request failed, so we learned nothing about this work."""
    result = {"ok": False, "source": source, "reason": "unavailable"}

    if detail:
        result["detail"] = detail

    return result


def _merge_identity(
    card: dict,
    *,
    doi: str | None,
    title: str | None,
    key: str,
    source: str,
) -> None:
    """Fill the blanks an earlier source left, and note who agreed.

    OpenAlex is asked first, so it wins every field it supplied; a later
    source only fills a gap and appends its name. `cited_by_count` is the
    exception -- the counts are not interchangeable across sources, so
    the first non-null value stands rather than being overwritten or
    summed.
    """
    for field, value in (("title", title), ("doi", doi), ("author", card.get("author"))):
        if not card.get(field) and value:
            card[field] = value

    if card.get("publication_year") is None and card.get("_year"):
        card["publication_year"] = card.pop("_year")

    if card.get("cited_by_count") is None and card.get("_citations") is not None:
        card["cited_by_count"] = card.pop("_citations")

    card.pop("_year", None)
    card.pop("_citations", None)

    if source not in card["sources"]:
        card["sources"].append(source)


def _finalize(card: dict) -> dict:
    """Strip the private scratch keys and add a stable identity key."""
    card.pop("_year", None)
    card.pop("_citations", None)
    card["identity"] = card["doi"] or _title_key(card.get("title"))

    return card


# ---------------------------------------------------------------------
# Semantic Scholar
# ---------------------------------------------------------------------


def _s2_entry(paper: dict, source: str = "semantic_scholar") -> dict | None:
    """Normalize one Semantic Scholar paper into the connection shape."""
    if not isinstance(paper, dict):
        return None

    paper_id = str(paper.get("paperId") or "").strip()

    if not paper_id or not _S2_PAPER_ID.match(paper_id):
        return None

    externals = paper.get("externalIds") or {}
    doi = normalize_doi(externals.get("DOI")) if isinstance(externals, dict) else None

    title = (paper.get("title") or "").strip() or None
    card: dict = {
        # The graph keys nodes by work_id, so an id that cannot collide
        # with an OpenAlex one (W<digits>) is what keeps a unioned row
        # addressable in WebGraph.
        "work_id": f"s2:{paper_id}",
        "title": title,
        "doi": doi,
        "publication_year": paper.get("year"),
        "cited_by_count": paper.get("citationCount"),
        "author": _first_author(paper.get("authors")),
        "sources": [source],
        "_year": paper.get("year"),
        "_citations": paper.get("citationCount"),
    }

    return _finalize(card)


def _s2_side(paper_id: str, direction: str, fetch, limit: int) -> list[dict]:
    """One side of the neighborhood: "references" or "citations".

    Semantic Scholar nests the work under `citedPaper` / `citingPaper`
    depending on the direction, so both keys are read and the first
    dict wins.
    """
    url = (
        f"{SEMANTIC_SCHOLAR_BASE}/paper/{quote(paper_id, safe='')}"
        f"/{direction}?fields={_S2_FIELDS}&limit={limit}"
    )

    try:
        payload = fetch(url)
    except Exception:
        return []

    if not isinstance(payload, dict):
        return []

    out: list[dict] = []

    for row in payload.get("data") or []:
        if not isinstance(row, dict):
            continue

        nested = row.get("citedPaper") or row.get("citingPaper") or {}

        if not isinstance(nested, dict):
            continue

        entry = _s2_entry(nested)

        if entry is None:
            continue

        # A self-citation or a duplicate inside one page is noise.
        if entry["work_id"] == f"s2:{paper_id}":
            continue

        out.append(entry)

        if len(out) >= limit:
            break

    return out


def fetch_semantic_scholar_neighborhood(
    *,
    doi: str | None = None,
    title: str | None = None,
    fetch=None,
    max_references: int = S2_LIMIT,
    max_citers: int = S2_LIMIT,
) -> dict:
    """Prior and derivative works for one work, from Semantic Scholar.

    Resolution order is DOI, then title search -- the same order
    web_connections.py uses, so the two sources agree on what the center
    is. Never raises. A provider that answered and holds no such paper
    reports "no_record"; one that could not be reached reports
    "unavailable" -- Semantic Scholar rate-limits hard without a key,
    and calling that a coverage statement would hide a live fault.
    """
    if fetch is None:
        fetch = lambda url: _default_fetch(url, source="semantic_scholar")  # noqa: E731

    doi = normalize_doi(doi)
    title = (title or "").strip()
    failed = False

    def resolve() -> str | None:
        # `failed` is written from in here, so it has to be bound to
        # the enclosing scope -- without `nonlocal` this assignment
        # creates a local and the caller never sees the failure, which
        # is how a rate-limited provider ends up reported as coverage.
        nonlocal failed

        if doi:
            # The slash must stay literal. Semantic Scholar routes
            # `DOI:<doi>` as a path segment and does not decode %2F, so
            # an encoded slash resolves to nothing (it answers 429
            # rather than a clean 404, which hides the mistake behind
            # the rate-limit branch). web_connections.py escapes the
            # slash in its own OpenAlex URL, where encoding is correct;
            # here it is not, so `safe="/"` is load-bearing.
            url = (
                f"{SEMANTIC_SCHOLAR_BASE}/paper/DOI:"
                f"{quote(doi, safe='/')}?fields={_S2_FIELDS}"
            )

            try:
                payload = fetch(url)
            except Exception as error:
                print(f"[web_connections] semantic_scholar: {error}")
                failed = True
                payload = None

            if isinstance(payload, dict) and payload.get("paperId"):
                return str(payload["paperId"])

        if not title:
            return None

        wanted = _title_key(title)

        if len(wanted) < 8:
            return None

        url = (
            f"{SEMANTIC_SCHOLAR_BASE}/paper/search"
            f"?query={quote(title[:300])}&fields={_S2_FIELDS}&limit=3"
        )

        try:
            payload = fetch(url)
        except Exception as error:
            print(f"[web_connections] semantic_scholar: {error}")
            failed = True
            return None

        if not isinstance(payload, dict):
            failed = True
            return None

        for row in (payload.get("data") or [])[:3]:
            if not isinstance(row, dict):
                continue

            found = _title_key(row.get("title"))

            if not found:
                continue

            if found == wanted:
                return str(row.get("paperId") or "") or None

            shorter, longer = sorted((found, wanted), key=len)

            if len(shorter) >= 0.9 * len(longer) and shorter in longer:
                return str(row.get("paperId") or "") or None

        return None

    paper_id = resolve()

    if not paper_id:
        return (
            _unavailable("semantic_scholar")
            if failed
            else _no_record("semantic_scholar")
        )

    # Both sides are independent; asking them at once halves the wait
    # and keeps a slow one from holding up the other.
    with ThreadPoolExecutor(max_workers=2) as pool:
        prior_future = pool.submit(
            _s2_side, paper_id, "references", fetch, max_references
        )
        derivative_future = pool.submit(
            _s2_side, paper_id, "citations", fetch, max_citers
        )
        prior = prior_future.result()
        derivative = derivative_future.result()

    return {
        "ok": True,
        "source": "semantic_scholar",
        "paper_id": paper_id,
        "prior_works": prior,
        "derivative_works": derivative,
    }


# ---------------------------------------------------------------------
# Crossref
# ---------------------------------------------------------------------


def _crossref_entry(reference: dict) -> dict | None:
    """Normalize one Crossref `reference` entry.

    Crossref's reference array is publisher-deposited and ragged: an
    entry may carry only a DOI, only an unstructured string, or a
    journal-title with no author at all. Anything without a usable
    identity is dropped rather than rendered as a blank row.
    """
    if not isinstance(reference, dict):
        return None

    doi = normalize_doi(reference.get("DOI"))
    title = (reference.get("unstructured") or "").strip() or None

    if not title:
        title = (reference.get("article-title") or "").strip() or None

    if not title:
        title = (reference.get("volume-title") or "").strip() or None

    if not doi and not title:
        return None

    year = None

    for key in ("year", "published-print", "published-online", "issued"):
        raw = reference.get(key)

        if isinstance(raw, int):
            year = raw
            break

        if isinstance(raw, dict):
            parts = raw.get("date-parts") or []

            if parts and isinstance(parts[0], list) and parts[0]:
                try:
                    year = int(parts[0][0])
                except (TypeError, ValueError):
                    year = None

            if year is not None:
                break

    return _finalize(
        {
            # Crossref has no per-reference stable id, so the DOI (or the
            # normalized title) is the only addressable key available.
            "work_id": f"doi:{doi}" if doi else f"cr:{_title_key(title)[:60]}",
            "title": title,
            "doi": doi,
            "publication_year": year,
            # Crossref cannot say how often one deposited reference was
            # cited, so this stays null rather than being faked as 0.
            "cited_by_count": None,
            "author": _first_author(reference.get("author")),
            "sources": ["crossref"],
            "_year": year,
        }
    )


def fetch_crossref_references(
    *,
    doi: str | None = None,
    fetch=None,
    limit: int = CROSSREF_REFERENCE_LIMIT,
) -> dict:
    """Prior works for one work, from Crossref's own reference deposit.

    Crossref is one-sided: its API has no "who cites this" endpoint, so
    this contributes prior works only. That is still worth having -- a
    reference OpenAlex dropped often survives in the publisher's
    deposit -- and it never touches the derivative list.
    """
    if fetch is None:
        fetch = _default_fetch

    doi = normalize_doi(doi)

    if not doi:
        return _no_record("crossref")

    url = (
        f"{CROSSREF_WORKS_BASE}/{quote(doi, safe='/')}"
        f"?mailto={quote(CROSSREF_MAILTO)}"
    )

    try:
        payload = fetch(url)
    except Exception as error:
        return _unavailable("crossref", str(error))

    message = payload.get("message") if isinstance(payload, dict) else None

    if not isinstance(message, dict):
        return _no_record("crossref")

    out: list[dict] = []
    seen: set[str] = set()

    for reference in (message.get("reference") or [])[:limit]:
        entry = _crossref_entry(reference)

        if entry is None:
            continue

        if entry["identity"] in seen:
            continue

        seen.add(entry["identity"])
        out.append(entry)

    return {
        "ok": True,
        "source": "crossref",
        "prior_works": out,
        "derivative_works": [],
    }

# ---------------------------------------------------------------------
# OpenCitations
# ---------------------------------------------------------------------

# The Index API over the COCI corpus: open DOI-to-DOI citation links
# derived from Crossref. It needs no key (an access token only makes
# usage measurable) and the data is openly licensed, which is why it is
# worth carrying alongside the API-backed sources.
OPEN_CITATIONS_BASE = "https://api.opencitations.net/index/v2"

# The references endpoint answers in one page of a few dozen rows. The
# citations endpoint is deliberately NOT called: it has no limit or
# pagination, so a well-cited paper streams its entire citer list
# (AlexNet is >70,000 rows) and the request never completes. Europe PMC
# covers citers instead -- see fetch_europepmc_neighborhood.
OPEN_CITATIONS_MAX = 50


def _oc_identifier(uri: object) -> str | None:
    """Pull one identifier out of an OpenCitations compound id field.

    Every entity carries the same work described several ways in one
    space-separated string, e.g.

        "omid:br/06102430459 doi:10.1021/ci500747n openalex:W1999798000"

    The DOI is what the rest of this module matches on, so it is
    preferred; an OpenAlex id is taken as a fallback so a reference
    with no DOI is still addressable and still dedupes.
    """
    if not isinstance(uri, str):
        return None

    openalex_id = None

    for part in uri.split():
        if part.startswith("doi:"):
            return normalize_doi(part[4:]) or None

        if openalex_id is None and part.startswith("openalex:"):
            openalex_id = part.split(":", 1)[1] or None

    return openalex_id


def _oc_entry(citation: dict) -> dict | None:
    """Normalize one OpenCitations reference row.

    OpenCitations is DOI-only: there are no titles, authors or years in
    the response at all. The row is therefore returned with those left
    null, and the union fills them from whichever other source knows
    the same work. That is the whole point of unioning -- no single
    provider is complete, so each carries the fields it actually has.
    """
    if not isinstance(citation, dict):
        return None

    identifier = _oc_identifier(citation.get("cited"))

    if not identifier:
        return None

    # `creation` is the publication date of the citing entity, not of
    # the reference, so it must not be read as the reference's year.
    return _finalize(
        {
            "work_id": f"oc:{identifier}",
            "title": None,
            "doi": identifier if identifier.lower().startswith("10.") else None,
            "publication_year": None,
            "cited_by_count": None,
            "author": None,
            "sources": ["open_citations"],
            "_year": None,
        }
    )


def fetch_opencitations_references(
    *,
    doi: str | None = None,
    fetch=None,
    limit: int = OPEN_CITATIONS_MAX,
) -> dict:
    """Prior works for one work, from the open OpenCitations Index.

    References only, for the reason given at OPEN_CITATIONS_BASE. Never
    raises; an unreachable or unrecognized source returns
    {"ok": False, ...} with empty lists.
    """
    if fetch is None:
        fetch = _default_fetch

    doi = normalize_doi(doi)

    if not doi:
        return _no_record("open_citations")

    url = f"{OPEN_CITATIONS_BASE}/references/doi:{quote(doi, safe='/')}"

    try:
        payload = fetch(url)
    except Exception as error:
        return _unavailable("open_citations", str(error))

    if not isinstance(payload, list):
        return _no_record("open_citations")

    out: list[dict] = []
    seen: set[str] = set()

    for citation in payload[:limit]:
        entry = _oc_entry(citation)

        if entry is None or entry["identity"] in seen:
            continue

        seen.add(entry["identity"])
        out.append(entry)

    return {
        "ok": True,
        "source": "open_citations",
        "prior_works": out,
        "derivative_works": [],
    }


# ---------------------------------------------------------------------
# Europe PMC
# ---------------------------------------------------------------------

# The life-sciences half of Europe PMC. It answers both directions with
# real pagination, which is precisely what OpenCitations cannot do, and
# it returns titles, authors, journal and year with every row rather
# than bare DOIs. No key is required.
#
# Coverage is the limitation, not the interface: this indexes biomedicine
# and the life sciences. A machine-learning or mathematics paper usually
# resolves to nothing here, which is correct behaviour -- the source
# simply has no record -- and costs one request.
EUROPE_PMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"

# Europe PMC caps pageSize server-side; 100 is comfortably inside it and
# still a small response.
EUROPE_PMC_MAX = 100

_EPMC_SOURCES = ("MED", "PMC")


def _epmc_entry(row: dict, source: str = "europe_pmc") -> dict | None:
    """Normalize one Europe PMC reference or citation row."""
    if not isinstance(row, dict):
        return None

    identifier = str(row.get("id") or "").strip()
    namespace = str(row.get("source") or source).strip() or "MED"

    if not identifier or not re.fullmatch(r"[A-Za-z0-9]{1,24}", identifier):
        return None

    title = (row.get("title") or "").strip() or None

    if not title:
        return None

    year = row.get("pubYear")

    try:
        year = int(year) if year else None
    except (TypeError, ValueError):
        year = None

    # Europe PMC reference rows carry no DOI, only a PMID/PMCID, so the
    # identity falls back to the normalized title and the row dedupes
    # against the other sources by title.
    return _finalize(
        {
            "work_id": f"epmc:{namespace}:{identifier}",
            "title": title,
            "doi": None,
            "publication_year": year,
            "cited_by_count": None,
            # Europe PMC gives "LeCun Y, Bengio Y, Hinton G." as one
            # string, which is already display-ready.
            "author": (row.get("authorString") or "").strip() or None,
            "sources": [source],
            "_year": year,
        }
    )


def _epmc_side(namespace: str, identifier: str, kind: str, fetch, limit: int) -> list[dict]:
    """One side of the neighborhood: "references" or "citations".

    Europe PMC wraps the rows differently per direction --
    referenceList.reference vs citationList.citation -- so the key is
    derived from `kind` rather than probed for.
    """
    url = (
        f"{EUROPE_PMC_BASE}/{namespace}/{quote(identifier, safe='')}"
        f"/{kind}?format=json&pageSize={limit}&page=1"
    )

    try:
        payload = fetch(url)
    except Exception:
        return []

    if not isinstance(payload, dict):
        return []

    container = payload.get("referenceList" if kind == "references" else "citationList")

    if not isinstance(container, dict):
        return []

    out: list[dict] = []

    for row in container.get("reference" if kind == "references" else "citation") or []:
        entry = _epmc_entry(row)

        if entry is not None:
            out.append(entry)

        if len(out) >= limit:
            break

    return out


def fetch_europepmc_neighborhood(
    *,
    doi: str | None = None,
    title: str | None = None,
    fetch=None,
    max_references: int = EUROPE_PMC_MAX,
    max_citers: int = EUROPE_PMC_MAX,
) -> dict:
    """Prior and derivative works for one work, from Europe PMC.

    A Europe PMC record is addressed by its internal id, so a paper has
    to be resolved before either side can be asked for -- DOI first,
    then title. Never raises.
    """
    if fetch is None:
        fetch = _default_fetch

    doi = normalize_doi(doi)
    title = (title or "").strip()

    query = f"DOI:{doi}" if doi else (f'TITLE:"{title}"' if title else "")

    if not query:
        return _no_record("europe_pmc")

    # The DOI goes in the query UNQUOTED. Europe PMC parses
    # `DOI:"10.1038/x"` as a literal phrase and matches nothing --
    # verified live, where the quoted form returns 0 hits and the bare
    # form returns 1. This is load-bearing, not cosmetic.
    url = (
        f"{EUROPE_PMC_BASE}/search?query={quote(query, safe=':')}"
        f"&format=json&pageSize=1"
    )

    try:
        payload = fetch(url)
    except Exception as error:
        return _unavailable("europe_pmc", str(error))

    if not isinstance(payload, dict):
        return _unavailable("europe_pmc")

    rows = (payload.get("resultList") or {}).get("result") or []

    if not rows:
        return _no_record("europe_pmc")

    row = rows[0]
    namespace = str(row.get("source") or "MED").strip().upper()
    identifier = str(row.get("id") or "").strip()

    if not identifier or namespace not in _EPMC_SOURCES:
        return _no_record("europe_pmc")

    # Both directions are independent and paginate, so ask in parallel.
    with ThreadPoolExecutor(max_workers=2) as pool:
        prior_future = pool.submit(
            _epmc_side, namespace, identifier, "references", fetch, max_references
        )
        derivative_future = pool.submit(
            _epmc_side, namespace, identifier, "citations", fetch, max_citers
        )
        prior = prior_future.result()
        derivative = derivative_future.result()

    return {
        "ok": True,
        "source": "europe_pmc",
        "paper_id": f"{namespace}/{identifier}",
        "prior_works": prior,
        "derivative_works": derivative,
    }

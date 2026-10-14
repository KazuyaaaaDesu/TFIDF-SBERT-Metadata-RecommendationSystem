"""
Web connections -- a paper's citation neighborhood.

The local graph draws on the repository's own embeddings and cached
citations; this module answers the "WEB" side of the scope switch in
the similar-papers pane: given a paper's DOI, resolve the work, then
its references (prior works) and its citers (derivative works), with
titles and years fetched in one batch request.

OpenAlex is the lead source and still supplies the edge structure,
because it is the only one that returns each neighbor's own reference
list (which is what the co-reference / co-citation edges are built
from). Semantic Scholar, Crossref, OpenCitations and Europe PMC are
asked for the same two questions by web_connections_extra.py and
unioned in: the graphs are built from different deposits, so a work one
has never cited often has citers in another, and no single provider
carries titles for everything it indexes. Each row records which
sources vouched for it. A source that fails contributes nothing -- the
neighborhood is richer with them and correct without them.

Prior works are ordered by their own citation count, so the seminal
papers of the field surface first; derivative works the same way, so
surveys and heavily-cited follow-ups lead.

Every network read goes through an injectable `fetch(url) -> dict`
(the same seam citations.py uses), so tests run offline.
"""

import re
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor

from app.services.citations import (
    OPENALEX_WORK_BASE,
    _default_fetch,
    normalize_doi,
)
from app.services.web_connections_extra import (
    fetch_crossref_references,
    fetch_europepmc_neighborhood,
    fetch_opencitations_references,
    fetch_semantic_scholar_neighborhood,
)

_SELECT = (
    "id,title,doi,publication_year,cited_by_count,"
    "authorships,referenced_works"
)

_WORK_ID = re.compile(r"(W\d+)\s*$")

MAX_REFERENCES = 15
MAX_CITERS = 15

# How many extra sources are asked alongside OpenAlex, and how much room
# each gets before the union is trimmed. OpenAlex alone caps at
# MAX_REFERENCES / MAX_CITERS; the union allows more headroom because a
# second graph contributes rows the first never had.
EXTRA_SOURCES = (
    "semantic_scholar",
    "crossref",
    "open_citations",
    "europe_pmc",
)
MERGED_MAX = 30


def _title_key(title: str | None) -> str:
    """Lowercased alphanumeric skeleton of a title, for matching."""
    return re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()


def _work_entry(work: dict) -> dict | None:
    """Normalize one OpenAlex work into the connection-card shape."""
    match = _WORK_ID.search(str(work.get("id") or ""))

    if not match:
        return None

    author = None
    authorships = work.get("authorships") or []

    if authorships:
        author = (
            authorships[0].get("author", {}).get("display_name")
            or None
        )

    return {
        "work_id": match.group(1),
        "title": work.get("title") or None,
        "doi": normalize_doi(work.get("doi")),
        "publication_year": work.get("publication_year"),
        "cited_by_count": work.get("cited_by_count"),
        "author": author,
        # Which sources vouched for this row. web_connections_extra.py
        # appends its own name when a second source agrees, and the UI
        # shows it, so an OpenAlex-only row is visibly narrower than a
        # corroborated one.
        "sources": ["openalex"],
        # The cross-source matching key: a DOI when we have one, else
        # the normalized title. Computed here so the union in
        # merge_neighborhoods() does not repeat the normalization.
        "identity": normalize_doi(work.get("doi")) or _title_key(
            work.get("title")
        ),
    }


def _fetch_details(
    work_ids: list[str],
    fetch,
) -> list[dict]:
    """Resolve a batch of OpenAlex ids into full work records.

    One `ids.openalex` filter call when the API accepts it; a small
    thread pool of individual lookups as the fallback so a filter
    change upstream cannot blank the list.
    """
    if not work_ids:
        return []

    url = (
        f"{OPENALEX_WORK_BASE}"
        f"?filter=ids.openalex:{'|'.join(work_ids)}"
        f"&per-page=50&select={_SELECT}"
    )

    try:
        payload = fetch(url)
        results = payload.get("results")

        if isinstance(results, list) and results:
            return results
    except Exception:
        pass

    def one(work_id: str):
        try:
            return fetch(
                f"{OPENALEX_WORK_BASE}/{work_id}?select={_SELECT}"
            )
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = pool.map(one, work_ids[:10])

    return [work for work in fetched if isinstance(work, dict)]


def _ref_set(work: dict) -> set[str]:
    """Normalized OpenAlex ids of one fetched work's references."""
    refs: set[str] = set()

    for raw in work.get("referenced_works") or []:
        match = _WORK_ID.search(str(raw))

        if match:
            refs.add(match.group(1))

    return refs


# Titles already resolved this process, so the local graph only pays
# the OpenAlex lookup once per external work. Bounded: reset when it
# grows past the cap rather than tracking LRU order.
_TITLE_CACHE: dict[str, str] = {}
_TITLE_CACHE_CAP = 600


def resolve_work_titles(
    work_ids: list[str],
    fetch=None,
    limit: int = 40,
) -> dict[str, str]:
    """Best-effort OpenAlex titles for bare work ids.

    The local citation store keeps only ids (and sometimes DOIs) for
    the works the graph cites / is cited by; the prior/derivative
    lists are much more readable with the real titles. One batch
    lookup for anything not cached; failures return what's cached
    (possibly nothing) and never raise.
    """
    if not work_ids:
        return {}

    if fetch is None:
        fetch = _default_fetch

    missing = [
        work_id
        for work_id in dict.fromkeys(work_ids)
        if work_id not in _TITLE_CACHE
    ][:limit]

    if missing:
        if len(_TITLE_CACHE) > _TITLE_CACHE_CAP:
            _TITLE_CACHE.clear()

        try:
            for work in _fetch_details(missing, fetch):
                entry = _work_entry(work)

                if entry and entry["title"]:
                    _TITLE_CACHE[entry["work_id"]] = entry["title"]
        except Exception:
            # Offline / rate-limited: labels stay as ids or DOIs.
            pass

    return {
        work_id: _TITLE_CACHE[work_id]
        for work_id in dict.fromkeys(work_ids)
        if work_id in _TITLE_CACHE
    }


def _build_edges(
    prior_works: list[dict],
    derivative_works: list[dict],
    prior_raw: list[dict],
    citer_raw: list[dict],
    *,
    min_shared: int = 2,
    limit: int = 160,
) -> list[list]:
    """Connection list for the web graph — a rich neighborhood
    instead of a plain star, using the reference lists OpenAlex
    already returned alongside each work:

        "ref"    center → prior work it cites
        "cit"    citer → center
        "cites"  citer → prior work it also cites
        "coref"  two prior works sharing >= min_shared references
                 (bibliographic coupling)
        "cocite" two citers sharing >= min_shared references
                 (co-citation, surveys built on the same base)

    Sources/targets are OpenAlex work ids; the center is the literal
    "center". Capped at `limit` edges, star edges kept first.
    """
    refs: dict[str, set[str]] = {}

    for work in [*prior_raw, *citer_raw]:
        entry = _work_entry(work)

        if entry:
            refs[entry["work_id"]] = _ref_set(work)

    prior_ids = [work["work_id"] for work in prior_works]
    citer_ids = [work["work_id"] for work in derivative_works]
    known_prior = set(prior_ids)

    edges: list[list] = []

    for work_id in prior_ids:
        edges.append([work_id, "center", 1.0, "ref"])

    for work_id in citer_ids:
        edges.append([work_id, "center", 1.0, "cit"])

        for target in sorted(refs.get(work_id, set()) & known_prior)[:5]:
            edges.append([work_id, target, 0.8, "cites"])

    def add_shared(ids: list[str], kind: str) -> None:
        for index, left in enumerate(ids):
            for right in ids[index + 1 :]:
                shared = len(
                    refs.get(left, set()) & refs.get(right, set())
                )

                if shared >= min_shared:
                    weight = round(min(1.0, shared / 8), 3)
                    edges.append([left, right, weight, kind])

    add_shared(prior_ids, "coref")
    add_shared(citer_ids, "cocite")

    return edges[:limit]


def _lookup_by_title(title: str, fetch) -> dict | None:
    """Best OpenAlex work for a title, only when the title matches.

    Title search is fuzzy, so the top hit is accepted only when its
    own title equals the query after normalization (or one contains
    the other and they share most words) -- a wrong neighborhood is
    worse than none.
    """
    wanted = _title_key(title)

    if len(wanted) < 8:
        return None

    url = (
        f"{OPENALEX_WORK_BASE}?search={quote(str(title)[:300])}"
        f"&per-page=3&select={_SELECT}"
    )
    page = fetch(url)

    for work in (page.get("results") or [])[:3]:
        found = _title_key(work.get("title"))

        if not found:
            continue

        if found == wanted:
            return work

        shorter, longer = sorted((found, wanted), key=len)

        if len(shorter) >= 0.9 * len(longer) and shorter in longer:
            return work

    return None


def fetch_web_neighborhood(
    paper,
    *,
    fetch=None,
    max_references: int = MAX_REFERENCES,
    max_citers: int = MAX_CITERS,
    sources: tuple[str, ...] = EXTRA_SOURCES,
) -> dict:
    """Prior/derivative works for one saved paper (by its DOI)."""
    return fetch_neighborhood(
        doi=paper.doi,
        fetch=fetch,
        max_references=max_references,
        max_citers=max_citers,
        sources=sources,
    )


def fetch_neighborhood(
    *,
    doi: str | None = None,
    title: str | None = None,
    work_id: str | None = None,
    fetch=None,
    max_references: int = MAX_REFERENCES,
    max_citers: int = MAX_CITERS,
    sources: tuple[str, ...] = EXTRA_SOURCES,
) -> dict:
    """Prior/derivative works for a work given by DOI, provider id
    or (last resort) exact-ish title, from several sources at once.

    OpenAlex resolves the center and leads the lists; `sources` names the
    extra providers to union in ("semantic_scholar", "crossref").
    Pass `sources=()` for the original OpenAlex-only behaviour.

    Only well-formed provider URLs are ever built: the DOI goes through
    normalize_doi and is percent-quoted, an OpenAlex id must be
    W<digits>, and the title is a quoted search parameter. Never raises:
    network and parse problems come back as {"ok": False, ...}.
    """
    if fetch is None:
        fetch = _default_fetch

    doi = normalize_doi(doi)
    work_id = (work_id or "").strip()

    if work_id and not re.fullmatch(r"W\d+", work_id):
        work_id = ""

    title = (title or "").strip()

    if not doi and not work_id and not title:
        return {"ok": False, "reason": "no_doi"}

    root = None

    def get_or_none(url: str):
        """One lookup; an HTTP 404 means "OpenAlex has no such work"."""
        try:
            return fetch(url)
        except Exception as error:
            if getattr(error, "code", None) == 404:
                return None
            raise

    def found(work) -> bool:
        return isinstance(work, dict) and bool(work.get("id"))

    try:
        if doi:
            root = get_or_none(
                f"{OPENALEX_WORK_BASE}/doi:{quote(doi, safe='/:()')}"
                f"?select={_SELECT}"
            )

        if not found(root) and work_id:
            root = get_or_none(
                f"{OPENALEX_WORK_BASE}/{work_id}?select={_SELECT}"
            )

        if not found(root) and title:
            root = _lookup_by_title(title, fetch)
    except Exception as error:
        return {
            "ok": False,
            "reason": "lookup_failed",
            "detail": str(error),
        }

    if not isinstance(root, dict) or not root.get("id"):
        return {"ok": False, "reason": "lookup_failed"}

    reference_ids = [
        _WORK_ID.search(str(work_id)).group(1)
        for work_id in (root.get("referenced_works") or [])[
            :max_references
        ]
        if _WORK_ID.search(str(work_id))
    ]

    prior_raw = _fetch_details(reference_ids, fetch)

    prior_works = [
        entry
        for work in prior_raw
        if (entry := _work_entry(work))
    ]
    prior_works.sort(
        key=lambda work: (
            -(work["cited_by_count"] or 0),
            work["work_id"],
        )
    )

    derivative_works: list[dict] = []

    # OpenAlex dropped the cited_by_api_url field, so citers come
    # from the filter endpoint: works?filter=cites:W…
    root_entry = _work_entry(root)

    citer_raw: list[dict] = []

    if root_entry:
        citers_url = (
            f"{OPENALEX_WORK_BASE}"
            f"?filter=cites:{root_entry['work_id']}"
            f"&per-page={max_citers}&select={_SELECT}"
        )

        try:
            page = fetch(citers_url)
            citer_raw = [
                work
                for work in (page.get("results") or [])[:max_citers]
                if _WORK_ID.search(str(work.get("id") or ""))
            ]
        except Exception:
            citer_raw = []

    derivative_works = [
        entry
        for work in citer_raw
        if (entry := _work_entry(work))
    ]

    derivative_works.sort(
        key=lambda work: (
            -(work["cited_by_count"] or 0),
            work["work_id"],
        )
    )

    # Inter-work connection structure (co-reference, co-citation,
    # citer → prior links) from the reference lists already fetched.
    # OpenAlex-only by construction: the edge kinds need each
    # neighbor's own reference list, which is the one thing the extra
    # sources do not return in the same call.
    edges = _build_edges(
        prior_works,
        derivative_works,
        prior_raw,
        citer_raw,
    )

    extras, skipped = _fetch_extra_sources(
        doi=(root_entry or {}).get("doi") or doi,
        title=title or (root_entry or {}).get("title"),
        fetch=fetch,
        sources=sources,
    )

    contributed = {
        name: {
            "prior": len(result.get("prior_works") or []),
            "derivative": len(result.get("derivative_works") or []),
        }
        for name, result in extras.items()
    }

    merged_prior = merge_neighborhoods(
        prior_works,
        [
            result.get("prior_works") or []
            for result in extras.values()
        ],
        limit=MERGED_MAX,
    )

    merged_derivative = merge_neighborhoods(
        derivative_works,
        [
            result.get("derivative_works") or []
            for result in extras.values()
        ],
        limit=MERGED_MAX,
    )

    return {
        "ok": True,
        "doi": (root_entry or {}).get("doi") or doi,
        "work_id": root_entry["work_id"] if root_entry else None,
        "prior_works": merged_prior,
        "derivative_works": merged_derivative,
        "edges": edges,
        # Which providers answered, and how many rows each added before
        # dedupe. The UI uses this to say where the list came from
        # instead of implying one source produced all of it.
        "sources": ["openalex", *extras],
        "source_counts": contributed,
        # Why a provider contributed nothing. "no_record" is coverage;
        # "unavailable" is a provider that is down right now, and the
        # two are worth telling apart before anyone trusts the count.
        "sources_skipped": skipped,
    }


# ============================================================
# MULTI-SOURCE UNION
# ============================================================


def _card_identity(work: dict) -> str:
    """The key two sources are matched on: DOI when present, else the
    normalized title. A row with neither is unusable as a match target
    and is kept out of the index so it cannot collide with anything."""
    doi = normalize_doi(work.get("doi"))

    if doi:
        return doi

    title = _title_key(work.get("title"))

    return title or ""


def _merge_cards(base: dict, other: dict) -> dict:
    """Fold `other` into `base`; the earlier source wins every field.

    Order matters: OpenAlex is merged first, so its title, DOI, year and
    citation count stand and a later source only fills a genuine gap.
    `cited_by_count` is never replaced -- the counts are not comparable
    across sources, and a Crossref row has none at all.
    """
    merged = dict(base)

    for field in ("title", "doi", "author", "publication_year"):
        if not merged.get(field) and other.get(field):
            merged[field] = other[field]

    if merged.get("cited_by_count") is None and other.get("cited_by_count") is not None:
        merged["cited_by_count"] = other["cited_by_count"]

    for source in other.get("sources") or []:
        if source not in merged["sources"]:
            merged["sources"].append(source)

    merged["identity"] = _card_identity(merged)

    return merged


def _sort_key(work: dict) -> tuple:
    """Most-cited first, then a stable tiebreak on the id.

    A row with no citation count sorts last rather than first: an
    unknown count is not evidence of being seminal, and OpenAlex's own
    ordering used the same treatment.
    """
    return (-(work.get("cited_by_count") or 0), work.get("work_id") or "")


def merge_neighborhoods(
    primary: list[dict],
    extras: list[list[dict]],
    *,
    limit: int = MERGED_MAX,
) -> list[dict]:
    """Union connection cards from several sources into one ordered list.

    Matching is two-key. A DOI is the strong key, but the sources
    disagree about which records carry one -- OpenAlex often has none
    for an older reference while Semantic Scholar and Crossref both do --
    so a title-only row would never meet its own DOI-bearing twin and the
    same paper would appear twice. Each card is therefore indexed under
    both keys and looked up by DOI first, title second; the two indexes
    are kept in step so merging through one also merges through the
    other.

    Anything with neither key is dropped: it would be undeduplicable.
    """
    by_doi: dict[str, dict] = {}
    by_title: dict[str, dict] = {}

    def absorb(card: dict) -> None:
        doi = normalize_doi(card.get("doi"))
        title = _title_key(card.get("title"))

        existing = None

        if doi and doi in by_doi:
            existing = by_doi[doi]
        elif title and title in by_title:
            existing = by_title[title]

        merged = (
            _merge_cards(existing, card)
            if existing is not None
            else {**card, "sources": list(card.get("sources") or [])}
        )

        merged["identity"] = normalize_doi(merged.get("doi")) or title
        merged_doi = normalize_doi(merged.get("doi"))
        merged_title = _title_key(merged.get("title"))

        # A later source may have supplied the DOI the first one lacked,
        # or the title the first one lacked, so both keys are re-derived
        # after the merge rather than reusing the incoming card's.
        if merged_doi:
            by_doi[merged_doi] = merged

        if merged_title:
            by_title[merged_title] = merged

    for work in [primary, *extras]:
        for card in work:
            if normalize_doi(card.get("doi")) or _title_key(card.get("title")):
                absorb(card)

    merged_rows = list(by_doi.values())

    for card in by_title.values():
        if card not in merged_rows:
            merged_rows.append(card)

    for card in merged_rows:
        if not card.get("sources"):
            card["sources"] = ["openalex"]

        card["identity"] = normalize_doi(card.get("doi")) or _title_key(
            card.get("title")
        )

    merged_rows.sort(key=_sort_key)

    return merged_rows[:limit]


def _fetch_extra_sources(
    *,
    doi: str | None,
    title: str | None,
    fetch,
    sources: tuple[str, ...],
) -> tuple[dict[str, dict], dict[str, str]]:
    """Ask each extra source the same question, in parallel.

    One source failing is the expected case, not an error: Semantic
    Scholar rate-limits hard without a key, Europe PMC simply has no
    record of a mathematics paper, and Crossref 404s on a DOI it never
    saw deposited. Each is isolated so none can take down the OpenAlex
    result or the others. Returns (answered, skipped), where `skipped`
    maps a provider to why it contributed nothing -- "no_record" for
    coverage, "unavailable" for a fault.
    """
    jobs = []

    if "semantic_scholar" in sources:
        jobs.append(
            (
                "semantic_scholar",
                lambda: fetch_semantic_scholar_neighborhood(
                    doi=doi,
                    title=title,
                    fetch=fetch,
                ),
            )
        )

    if "crossref" in sources:
        jobs.append(
            (
                "crossref",
                lambda: fetch_crossref_references(doi=doi, fetch=fetch),
            )
        )

    if "open_citations" in sources:
        jobs.append(
            (
                "open_citations",
                lambda: fetch_opencitations_references(
                    doi=doi,
                    fetch=fetch,
                ),
            )
        )

    if "europe_pmc" in sources:
        jobs.append(
            (
                "europe_pmc",
                lambda: fetch_europepmc_neighborhood(
                    doi=doi,
                    title=title,
                    fetch=fetch,
                ),
            )
        )

    if not jobs:
        return {}, {}

    out: dict[str, dict] = {}
    skipped: dict[str, str] = {}

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {
            name: pool.submit(job) for name, job in jobs
        }

        for name, future in futures.items():
            try:
                result = future.result()
            except Exception as error:
                print(f"[web_connections] {name} failed: {error}")
                skipped[name] = "unavailable"
                continue

            if isinstance(result, dict) and result.get("ok"):
                out[name] = result
            else:
                reason = (result or {}).get("reason", "no_record")
                skipped[name] = reason

                if reason == "unavailable":
                    # A provider that answered "I have no record" is
                    # coverage; one that failed is a fault, and worth a
                    # line in the log so it does not quietly shrink
                    # every neighborhood from here on.
                    print(
                        f"[web_connections] {name} unavailable: "
                        f"{(result or {}).get('detail', 'no detail')}"
                    )

    return out, skipped

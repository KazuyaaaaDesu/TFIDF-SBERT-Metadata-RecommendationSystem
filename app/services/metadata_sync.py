"""
Refresh paper metadata from Crossref (what "Sync" is for).

The Repository's Sync button used to do one thing: rebuild the
recommendation index. It never touched the records themselves, so a
paper stored with a missing year, a truncated abstract or authors
written as initials stayed that way no matter how often Sync was
pressed.

This module looks each paper up by DOI and applies Crossref's record
under the same cautious rules enrichment uses elsewhere:

    - a BLANK field is filled; a populated field is never overwritten
      (year, abstract, citation count, a corrupted title);
    - authors are the exception, because Crossref is the one source
      that gives each author as separate given / family names. They
      are set when missing, and upgraded in place when the existing
      list names the same people (same family names, same order) but
      only as initials ("J. Smith" -> "John Smith"). A different set of
      people is never swapped in over what is stored: that may be a
      deliberate edit.

``plan_updates`` is pure (a paper and a Crossref record in, a dict of
changes out) so every rule is testable without a network. Network
trouble on one paper skips that paper and is counted, never raised.
"""

from __future__ import annotations

import re
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session

from app.models.models import Paper, _author_rows
from app.services.author_names import AuthorName, parse_author
from app.services.citations import _default_fetch, normalize_doi
from app.services.metadata_enrichment import (
    MIN_ABSTRACT_LENGTH,
    is_title_corrupted,
)

CROSSREF_WORK = "https://api.crossref.org/works/"
# Crossref rate-limits anonymous clients: eight parallel lookups drew
# HTTP 429 on more than half of the requests, two draw none.
WORKERS = 2
CHUNK = 40
RETRIES = 3
BACKOFF_SECONDS = 1.0

_TAGS = re.compile(r"<[^>]+>")


def _initials_only(given: str) -> bool:
    letters = re.sub(r"[^\w]", "", given or "", flags=re.UNICODE)

    return bool(letters) and len(letters) <= 2


def _smart_case(text: str) -> str:
    """Some Crossref records are ALL CAPS; store them as names."""

    words = []

    for word in text.split():
        letters = re.sub(r"[^\w]", "", word, flags=re.UNICODE)

        # A short all-caps token is initials ("JR", "J.R."), not shouting.
        if len(letters) > 3 and word.isupper():
            word = re.sub(
                r"(^|[-\u2010'])(\w)",
                lambda m: m.group(1) + m.group(2).upper(),
                word.lower(),
                flags=re.UNICODE,
            )

        words.append(word)

    return " ".join(words)


def _split_given(given: str) -> tuple[str, str]:
    """Crossref's "given" is "John Michael": first name + the rest."""

    tokens = (given or "").split()

    return (tokens[0], " ".join(tokens[1:])) if tokens else ("", "")


def crossref_authors(message: dict) -> list[AuthorName]:
    """Crossref ``author`` entries as structured names, in order."""

    names: list[AuthorName] = []

    for entry in message.get("author") or []:
        family = (entry.get("family") or "").strip()
        given = (entry.get("given") or "").strip()

        if not family and not given:
            # Organisations come as {"name": "..."}; keep them whole.
            parsed = parse_author(entry.get("name"))

            if parsed:
                names.append(AuthorName(family=parsed.family))

            continue

        first, middle = _split_given(_smart_case(given))
        names.append(
            AuthorName(
                first,
                middle,
                _smart_case(family),
                (entry.get("suffix") or "").strip(),
            )
        )

    return names


def _year(message: dict) -> int | None:
    for key in ("issued", "published-print", "published-online", "published"):
        parts = ((message.get(key) or {}).get("date-parts") or [[None]])[0]

        if parts and isinstance(parts[0], int):
            return parts[0]

    return None


def _abstract(message: dict) -> str | None:
    raw = message.get("abstract")

    if not raw:
        return None

    text = re.sub(r"\s+", " ", _TAGS.sub(" ", raw)).strip()
    text = re.sub(r"^abstract\s*[:.]?\s*", "", text, flags=re.I)

    return text if len(text) >= MIN_ABSTRACT_LENGTH else None


def _compatible(old: AuthorName, new: AuthorName) -> bool:
    """Could ``new`` be the same person as ``old``, spelled out?"""

    if old.family.casefold() != new.family.casefold():
        return False

    if not old.given or not new.given:
        return True

    return old.given[0].casefold() == new.given[0].casefold()


def _merged(old: AuthorName, new: AuthorName) -> AuthorName:
    """Keep whichever of the two spells each part out more fully."""

    return AuthorName(
        new.given if len(new.given) >= len(old.given) else old.given,
        new.middle if len(new.middle) >= len(old.middle) else old.middle,
        old.family if old.family != old.family.upper() else new.family,
        old.suffix or new.suffix,
    )


def upgraded_authors(
    current: list[AuthorName], incoming: list[AuthorName]
) -> list[AuthorName] | None:
    """The existing authors with abbreviated names spelled out, or None.

    Only when both lists are the same people in the same order and every
    given name is compatible (same initial): "J. Smith" becomes
    "John Smith", but "D. Randy Garrison" is never rewritten to "Randy
    Garrison", and a different set of people is never swapped in over
    what is stored (that may be a deliberate edit).
    """

    if not current or len(current) != len(incoming):
        return None

    if not all(_compatible(o, n) for o, n in zip(current, incoming)):
        return None

    merged = [_merged(o, n) for o, n in zip(current, incoming)]

    return merged if merged != current else None


def plan_updates(paper: Paper, message: dict) -> dict:
    """The changes Crossref's record implies for ``paper`` (pure)."""

    changes: dict = {}

    current = [row.to_name() for row in paper.authors]
    incoming = crossref_authors(message)

    if incoming:
        if not current:
            changes["authors"] = incoming
        else:
            better = upgraded_authors(current, incoming)

            if better is not None:
                changes["authors"] = better

    if paper.publication_year is None:
        year = _year(message)

        if year:
            changes["publication_year"] = year

    if not paper.abstract or len(paper.abstract.strip()) < MIN_ABSTRACT_LENGTH:
        abstract = _abstract(message)

        if abstract:
            changes["abstract"] = abstract

    if paper.citation_count is None:
        count = message.get("is-referenced-by-count")

        if isinstance(count, int) and count >= 0:
            changes["citation_count"] = count

    if is_title_corrupted(paper.title):
        titles = message.get("title") or []

        if titles and titles[0].strip():
            changes["title"] = titles[0].strip()

    return changes


def needs_sync(paper: Paper) -> bool:
    """Whether a paper has something Crossref could fill in or sharpen."""

    if not normalize_doi(paper.doi):
        return False

    names = [row.to_name() for row in paper.authors]

    return bool(
        not names
        or any(
            not n.is_corporate and (not n.given or _initials_only(n.given))
            for n in names
        )
        or paper.publication_year is None
        or not paper.abstract
        or len(paper.abstract.strip()) < MIN_ABSTRACT_LENGTH
        or is_title_corrupted(paper.title)
    )


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _lookup(fetch, doi: str):
    """Crossref's record for ``doi``: a dict, None when Crossref does not
    know it, or "failed". Rate limits (429) and server errors are retried
    with a growing pause before they count as a failure."""

    for attempt in range(RETRIES + 1):
        try:
            reply = fetch(CROSSREF_WORK + urllib.parse.quote(doi, safe="/"))
        except urllib.error.HTTPError as error:
            # 404: Crossref does not know this DOI (e.g. a DataCite/arXiv
            # DOI). That is an answer, not a failure worth retrying.
            if error.code == 404:
                return None

            if error.code in (429, 500, 502, 503, 504) and attempt < RETRIES:
                _sleep(BACKOFF_SECONDS * (2**attempt))
                continue

            return "failed"
        except Exception:
            return "failed"

        message = (reply or {}).get("message") if isinstance(reply, dict) else None

        return message if isinstance(message, dict) else None

    return "failed"


def sync_metadata(
    db: Session,
    *,
    force: bool = False,
    limit: int | None = None,
    fetch=None,
    workers: int = WORKERS,
    on_progress=None,
) -> dict:
    """
    Refresh metadata for papers that can benefit (or every paper with a
    DOI when ``force``). Returns a summary; ``changed`` is the number of
    papers whose record was updated, which is also the signal that the
    recommendation index is now stale.

    ``on_progress(summary, done, total)`` runs after each chunk and must
    not raise (exceptions are swallowed).
    """

    fetch = fetch or _default_fetch
    papers = [
        p
        for p in db.query(Paper).order_by(Paper.id)
        if (normalize_doi(p.doi) if force else needs_sync(p))
    ]

    if limit is not None:
        papers = papers[:limit]

    summary = {
        "considered": len(papers),
        "changed": 0,
        "not_found": 0,
        "failed": 0,
        "fields": {},
    }

    def notify(done: int) -> None:
        if on_progress is None:
            return

        try:
            on_progress(
                {**summary, "fields": dict(summary["fields"])},
                done,
                len(papers),
            )
        except Exception:
            pass

    notify(0)

    for start in range(0, len(papers), CHUNK):
        chunk = papers[start : start + CHUNK]
        dois = [normalize_doi(p.doi) for p in chunk]

        # Network only, in parallel; every DB write stays on this thread.
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            replies = list(pool.map(lambda doi: _lookup(fetch, doi), dois))

        for paper, message in zip(chunk, replies):
            if message == "failed":
                summary["failed"] += 1
                continue

            if message is None:
                summary["not_found"] += 1
                continue

            changes = plan_updates(paper, message)

            if not changes:
                continue

            apply_changes(paper, changes)
            summary["changed"] += 1

            for field in changes:
                summary["fields"][field] = summary["fields"].get(field, 0) + 1

        db.commit()
        notify(min(start + CHUNK, len(papers)))

    return summary


def apply_changes(paper: Paper, changes: dict) -> None:
    """Write planned changes and refresh what is derived from them."""

    from app.services.classification import classify_paper
    from app.services.text_preparation import refresh_prepared_text
    from app.services.validation import validate_paper

    for field, value in changes.items():
        if field == "authors":
            # The flush hook rebuilds the display string from the parts.
            paper.authors = _author_rows(value)
        else:
            setattr(paper, field, value)

    note = "metadata <- crossref (" + ", ".join(sorted(changes)) + ")"
    existing = (paper.enrichment_notes or "").strip()
    paper.enrichment_notes = f"{existing}; {note}" if existing else note

    for step in (classify_paper, validate_paper, refresh_prepared_text):
        try:
            step(paper)
        except Exception as error:  # best-effort, as on import
            print(f"WARNING: sync {step.__name__} failed: {error}")

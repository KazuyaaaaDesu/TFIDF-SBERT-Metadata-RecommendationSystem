"""
A cheap, stable fingerprint of the corpus a battle ran against.

Chapter III quotes the corpus the campaign was collected on ("168
papers / 145 valid"). A win share recorded against a corpus nobody can
name is not comparable with one recorded a week later, after papers
were added or re-validated, so every battle run stores the size of the
candidate set it saw and a short version string for it.

Both numbers come from one aggregate query -- COUNT and MAX over the
same indexed predicate the pipelines use to pick candidates -- rather
than from loading the papers. That is cheap enough to call per run,
but a run also happens while a campaign is in progress, where many
runs land in a row against an unchanging corpus; so the answer is
cached for a few seconds. The window is short on purpose: a paper
added between two runs has to show up on the next one, and a stale
count recorded next to a real one is worse than a second of COUNT.

The version string is a hash, not a timestamp: two runs an hour apart
over the same papers must produce the same value, so that "same
corpus" is a string comparison in the export instead of a
reconstruction.
"""

from __future__ import annotations

import hashlib
import threading
import time

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.models import Paper
from app.services.recommendation.vector_index import INDEX_VERSION

# Seconds a computed snapshot is reused for. Long enough that a burst
# of runs in one sitting costs one COUNT, short enough that an edit is
# reflected on the very next run.
CACHE_TTL_SECONDS = 5.0

# Digest length. Short enough to read in a spreadsheet cell, long
# enough that two different corpora colliding is not a practical
# concern.
_DIGEST_CHARS = 12

_lock = threading.Lock()
_cache: tuple[float, int | None, str | None] | None = None


def _corpus_version(
    valid_count: int | None,
    last_updated_at: str | None,
) -> str | None:
    """Fingerprint of (size, newest update, index version).

    Bumped by INDEX_VERSION so a rebuild of the vector matrices marks
    a new corpus version even when the paper rows themselves have not
    changed -- the recommendation results can differ.
    """

    if valid_count is None:
        return None

    digest = hashlib.sha256(
        "|".join(
            [
                str(valid_count),
                str(last_updated_at or ""),
                str(INDEX_VERSION),
            ]
        ).encode("utf-8")
    ).hexdigest()[:_DIGEST_CHARS]

    return f"v{INDEX_VERSION}-n{valid_count}-{digest}"


def _query(db: Session) -> tuple[int, str | None]:
    row = (
        db.query(
            func.count(Paper.id),
            func.max(Paper.updated_at),
        )
        .filter(Paper.is_valid_for_recommendation.is_(True))
        .one()
    )

    valid_count, last_updated_at = row

    return int(valid_count or 0), (
        last_updated_at.isoformat() if last_updated_at else None
    )


def corpus_snapshot(db: Session, *, now: float | None = None) -> dict:
    """``{"corpus_size": int | None, "corpus_version": str | None}``.

    The keys are named to match the ``battle_runs`` columns they are
    written into. ``corpus_size`` is None when the query fails: a run
    with no recorded corpus size is honest about it, where a silent 0
    would read as "the corpus was empty" and quietly distort a mean.
    """

    global _cache

    moment = time.monotonic() if now is None else now

    with _lock:
        if _cache is not None:
            cached_at, cached_size, cached_version = _cache

            if moment - cached_at < CACHE_TTL_SECONDS:
                return {
                    "corpus_size": cached_size,
                    "corpus_version": cached_version,
                }

    try:
        valid_count, last_updated_at = _query(db)
    except Exception:
        # The battle itself succeeded, so the run is still worth
        # recording; it just records no corpus. Swallowing this here
        # keeps a COUNT from ever failing a comparison request.
        return {"corpus_size": None, "corpus_version": None}

    snapshot = {
        "corpus_size": valid_count,
        "corpus_version": _corpus_version(valid_count, last_updated_at),
    }

    with _lock:
        _cache = (moment, snapshot["corpus_size"], snapshot["corpus_version"])

    return snapshot


def clear_cache() -> None:
    """Drop the cached snapshot (tests, and after a bulk paper edit)."""

    global _cache

    with _lock:
        _cache = None

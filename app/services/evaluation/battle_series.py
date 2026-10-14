"""A series of battles as one campaign: queries and the board over them.

A single battle is one sample. A series runs many queries under one run
label and pools them, so the question "how do the pipelines compare on
this set" has an answer with an interval around it instead of a pile of
single-query winners.

Two helpers:

    clean_queries   turn pasted text into a de-duplicated query list
    series_summary  pool the recorded battles of one label
"""

from __future__ import annotations

import json
import re
from typing import Mapping, Sequence

from app.services.evaluation import battle_judge, stats

MAX_SERIES = 50
MAX_QUERY_CHARS = 300
CURRENT_METRIC = "independence_weighted_consensus"


def clean_queries(text: str | Sequence[str], *, limit: int = MAX_SERIES) -> dict:
    """One query per line; blanks and case/space-insensitive repeats are
    dropped, long lines are cut. ``dropped`` says what happened so the UI
    can tell the person instead of silently shortening their list."""

    lines = text.splitlines() if isinstance(text, str) else list(text)
    seen: set[str] = set()
    queries: list[str] = []
    duplicates = 0
    truncated = 0

    for line in lines:
        query = re.sub(r"\s+", " ", str(line)).strip()

        if not query:
            continue

        if len(query) > MAX_QUERY_CHARS:
            query = query[:MAX_QUERY_CHARS].rstrip()
            truncated += 1

        key = query.casefold()

        if key in seen:
            duplicates += 1
            continue

        seen.add(key)
        queries.append(query)

    over = max(0, len(queries) - limit)

    return {
        "queries": queries[:limit],
        "duplicates_dropped": duplicates,
        "truncated": truncated,
        "over_limit": over,
        "limit": limit,
    }


def series_summary(rows: Sequence[Mapping]) -> dict:
    """Pool the recorded battles of one run label.

    ``rows`` are dicts with ``response_json`` (and optionally
    ``judgement_json``). Agreement is the mean independence-weighted
    consensus share per pipeline with a bootstrap interval; it is still
    agreement, not quality. Quality comes from the judged battles in the
    series, pooled by ``battle_judge.judged_summary``.
    """

    shares: dict[str, list[float]] = {}
    decisive_wins: dict[str, int] = {}
    decisive = too_close = unscored = 0
    queries: set[str] = set()

    for row in rows:
        try:
            response = json.loads(row.get("response_json") or "null")
        except ValueError:
            response = None

        winner = (response or {}).get("winner") or {}

        if not winner.get("shares"):
            unscored += 1
            continue

        queries.add(str(row.get("query") or f"paper:{row.get('seed_paper_id')}"))

        for pipeline, share in winner["shares"].items():
            shares.setdefault(pipeline, []).append(float(share))

        if winner.get("decisive"):
            decisive += 1
            decisive_wins[winner["pipeline_id"]] = (
                decisive_wins.get(winner["pipeline_id"], 0) + 1
            )
        else:
            too_close += 1

    pipelines = sorted(shares)
    complete = min((len(v) for v in shares.values()), default=0)
    agreement = sorted(
        (
            {
                "pipeline": p,
                **stats.bootstrap_ci(shares[p][:complete], resamples=2000, seed=0),
                "decisive_wins": decisive_wins.get(p, 0),
            }
            for p in pipelines
            if complete
        ),
        key=lambda item: -item["mean"],
    )

    return {
        "n_battles": len(rows),
        "n_queries": len(queries),
        "decisive": decisive,
        "too_close": too_close,
        "unscored": unscored,
        "agreement": agreement,
        "judged": battle_judge.judged_summary(rows),
    }

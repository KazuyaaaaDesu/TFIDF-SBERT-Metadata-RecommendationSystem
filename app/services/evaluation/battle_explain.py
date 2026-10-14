"""Why did the pipelines differ on this query?

The battle's winner says who agreed with whom; this says *where* they
disagreed and *which signal* drove each result. It is read straight off
the lists a battle already returned (ranks, plus the per-signal
``components`` each result carries), so it adds no queries and can be
recomputed from a stored battle.

    contested   papers some pipelines returned and others did not,
                most evenly split first (a 3-vs-3 split says more than
                5-vs-1), then by how far their ranks disagree
    unanimous   papers every pipeline returned, best mean rank first
    pipelines   per pipeline: papers only it returned, and the mix of
                signals (TF-IDF / S-BERT / metadata) behind its list
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

SIGNALS = ("tfidf", "sbert", "metadata")
DEFAULT_LIMIT = 8


def _dominant(components: Mapping[str, float] | None) -> str | None:
    if not components:
        return None

    best = max(SIGNALS, key=lambda signal: components.get(signal) or 0.0)

    return best if (components.get(best) or 0.0) > 0 else None


def explain_differences(
    lists: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    limit: int = DEFAULT_LIMIT,
) -> dict | None:
    """``lists``: pipeline id -> its ranked results (best first), each a
    mapping with ``paper_id`` and optionally ``title``, ``year`` and
    ``components``. Pipelines with empty lists are ignored."""

    lists = {p: list(rows) for p, rows in lists.items() if rows}

    if len(lists) < 2:
        return None

    pipelines = list(lists)
    n_total = len(pipelines)
    papers: dict[int, dict] = {}

    for pipeline, rows in lists.items():
        for rank, row in enumerate(rows, start=1):
            entry = papers.setdefault(
                row["paper_id"],
                {
                    "paper_id": row["paper_id"],
                    "title": row.get("title"),
                    "year": row.get("year"),
                    "ranks": {},
                    "drivers": {},
                },
            )

            entry["ranks"][pipeline] = rank
            entry["drivers"][pipeline] = _dominant(row.get("components"))

    def finish(entry: dict) -> dict:
        ranks = entry["ranks"]
        values = list(ranks.values())

        return {
            "paper_id": entry["paper_id"],
            "title": entry["title"],
            "year": entry["year"],
            "in": [p for p in pipelines if p in ranks],
            "out": [p for p in pipelines if p not in ranks],
            "ranks": ranks,
            "spread": max(values) - min(values),
            "mean_rank": round(sum(values) / len(values), 2),
            "drivers": {p: d for p, d in entry["drivers"].items() if d},
        }

    finished = [finish(entry) for entry in papers.values()]
    contested = sorted(
        (f for f in finished if f["out"]),
        key=lambda f: (
            -min(len(f["in"]), len(f["out"])),
            -f["spread"],
            f["mean_rank"],
            f["paper_id"],
        ),
    )
    unanimous = sorted(
        (f for f in finished if not f["out"]),
        key=lambda f: (f["mean_rank"], f["paper_id"]),
    )

    summaries = []

    for pipeline, rows in lists.items():
        unique = [
            f for f in finished if f["in"] == [pipeline]
        ]
        unique.sort(key=lambda f: f["ranks"][pipeline])
        totals = {signal: 0.0 for signal in SIGNALS}

        for row in rows:
            for signal in SIGNALS:
                totals[signal] += (row.get("components") or {}).get(signal) or 0.0

        grand = sum(totals.values())
        mix = (
            {signal: round(value / grand, 4) for signal, value in totals.items()}
            if grand > 0
            else None
        )

        summaries.append(
            {
                "id": pipeline,
                "unique_count": len(unique),
                "unique": unique[:limit],
                "signal_mix": mix,
                "dominant": max(mix, key=mix.get) if mix else None,
            }
        )

    return {
        "n_pipelines": n_total,
        "union": len(finished),
        "shared_by_all": len(unanimous),
        "contested_count": len(contested),
        "contested": contested[:limit],
        "unanimous": unanimous[:limit],
        "pipelines": summaries,
    }

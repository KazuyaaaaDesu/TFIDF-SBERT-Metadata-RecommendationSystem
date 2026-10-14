"""Recipe sweep: which blend of the three signals works best?

The Lab's bench lets you set TF-IDF / S-BERT / metadata shares by hand.
The sweep answers the question behind it: it scores a whole grid of
blends on many leave-one-out queries (papers whose references are known,
as in the tournament) and shows where on the simplex the quality is.

Speed comes from scoring each query's candidates *once*. A pipeline's
score is a weighted sum of three per-candidate component scores, so one
search with equal weights yields each candidate's components, and every
recipe is then just a different weighted sum and sort, done in memory.

Honesty about the winner: the best of ~60 blends picked on the same
queries it is judged on is optimistic (the winner's curse). So the
queries are split in two. The best blend is chosen on the first half and
re-scored on the second, where it is compared with the six presets using
paired bootstrap intervals. Only that second-half comparison is a
finding; the full-grid heat map is for exploring.
"""

from __future__ import annotations

import random
from typing import Callable, Iterator, Sequence

import numpy as np

from app.services.evaluation import loo_qrels, stats
from app.services.evaluation.tournament import score_ranking
from app.services.recommendation.pipeline_config import PIPELINE_CONFIGS

ALLOWED_STEPS = (5, 10, 20, 25)
EVEN_THIRDS = {"tfidf": 1 / 3, "sbert": 1 / 3, "metadata": 1 / 3}
POOL = 1_000_000
MIN_QUERIES_FOR_SPLIT = 8
SIGNALS = ("tfidf", "sbert", "metadata")


def recipe_grid(step: int) -> list[tuple[int, int, int]]:
    """Every (tfidf, sbert, metadata) in whole percentages of ``step``
    that sums to 100, in a stable order."""

    if step not in ALLOWED_STEPS:
        raise ValueError(f"step must be one of {ALLOWED_STEPS}.")

    return [
        (t, s, 100 - t - s)
        for t in range(0, 101, step)
        for s in range(0, 101 - t, step)
    ]


def preset_recipes() -> dict[str, tuple[float, float, float]]:
    """The six presets as fractional weights."""

    return {
        name: (w["tfidf"], w["sbert"], w["metadata"])
        for name, w in PIPELINE_CONFIGS.items()
    }


class Components:
    """One query's candidates with their three normalised component
    scores, enough to rank under any weights."""

    def __init__(self, ids, tfidf, sbert, metadata):
        self.ids = np.asarray(ids)
        self.parts = np.vstack([tfidf, sbert, metadata])  # 3 x n

    def rank(self, weights: Sequence[float], depth: int) -> list:
        """Top ``depth`` ids under ``weights`` (fractions or percentages:
        only the ratios matter). Ties break by id so a rerun is identical."""

        if self.ids.size == 0:
            return []

        scores = np.asarray(weights, dtype=float) @ self.parts
        order = np.lexsort((self.ids, -scores))[:depth]

        return [self.ids[i].item() for i in order if scores[i] > 0]


def components_for(search, db, query_text: str, excluded) -> Components:
    """Score the candidates once and recover each component.

    ``search`` is ``search_papers``-shaped. With equal weights each
    result's ``components`` are w * s' with w = 1/3, so s' = 3 * component.
    """

    raw = search(
        db=db,
        query=query_text,
        seed_paper_id=None,
        pipeline="custom",
        top_k=POOL,
        custom_weights=dict(EVEN_THIRDS),
    )
    ids, t, s, m = [], [], [], []

    for item in raw:
        paper_id = item["paper"].id

        if paper_id in excluded:
            continue

        parts = item.get("components") or {}
        ids.append(paper_id)
        t.append(3 * (parts.get("tfidf") or 0.0))
        s.append(3 * (parts.get("sbert") or 0.0))
        m.append(3 * (parts.get("metadata") or 0.0))

    return Components(ids, t, s, m)


def _default_search():
    from app.services.recommendation.search_service import search_papers

    return search_papers


def _mean_ci(values: Sequence[float], seed: int) -> dict:
    return stats.bootstrap_ci(values, resamples=2000, seed=seed)


def run_sweep(
    db,
    *,
    n_queries: int,
    k: int,
    step: int,
    min_refs: int = loo_qrels.DEFAULT_MIN_REFS,
    seed: int = 0,
    search=None,
    queries: list[loo_qrels.LooQuery] | None = None,
) -> Iterator[dict]:
    """Yield ``start``, ``progress`` and finally ``done`` events."""

    search = search or _default_search()
    grid = recipe_grid(step)
    presets = preset_recipes()

    if queries is None:
        queries = loo_qrels.build_loo_queries(
            db, n=n_queries, min_refs=min_refs, seed=seed
        )

    yield {
        "event": "start",
        "n_queries": len(queries),
        "grid_size": len(grid),
    }

    names: list[str] = [f"{t}/{s}/{m}" for t, s, m in grid]
    weights: list[Sequence[float]] = [tuple(g) for g in grid]

    for name, w in presets.items():
        names.append(f"preset:{name}")
        weights.append(w)

    columns: list[list[float]] = [[] for _ in names]
    used: list[int] = []
    skipped = 0
    depth = max(k, 20)

    for index, query in enumerate(queries):
        if query.relevance:
            try:
                comps = components_for(
                    search, db, query.query, query.excluded_ids
                )
            except Exception:
                comps = None
        else:
            comps = None

        if comps is None or comps.ids.size == 0:
            skipped += 1
        else:
            for column, w in zip(columns, weights):
                ranked = comps.rank(w, depth)
                column.append(
                    score_ranking(ranked, query.relevance, k)["ndcg"]
                )
            used.append(query.seed_paper_id)

        yield {"event": "progress", "done": index + 1, "total": len(queries)}

    yield {
        "event": "done",
        "result": summarise(
            names=names,
            grid=grid,
            columns=columns,
            used=used,
            skipped=skipped,
            k=k,
            step=step,
            seed=seed,
        ),
    }


def summarise(
    *,
    names: Sequence[str],
    grid: Sequence[tuple[int, int, int]],
    columns: Sequence[Sequence[float]],
    used: Sequence[int],
    skipped: int,
    k: int,
    step: int,
    seed: int,
) -> dict:
    """The sweep's result from per-query nDCG columns (one per recipe)."""

    n = len(used)
    base = {
        "k": k,
        "step": step,
        "n_queries": n,
        "skipped": skipped,
        "metric": f"nDCG@{k}",
    }

    if n == 0:
        return {**base, "grid": [], "top": [], "heldout": None, "reason": "No query could be scored."}

    vectors = {name: np.asarray(col, dtype=float) for name, col in zip(names, columns)}
    cells = [
        {
            "weights": {"tfidf": t, "sbert": s, "metadata": m},
            "mean": float(vectors[f"{t}/{s}/{m}"].mean()),
        }
        for t, s, m in grid
    ]
    top = sorted(cells, key=lambda c: -c["mean"])[:10]
    preset_means = {
        name: float(vectors[f"preset:{name}"].mean()) for name in PIPELINE_CONFIGS
    }

    heldout = None
    reason = None

    if n >= MIN_QUERIES_FOR_SPLIT:
        order = list(range(n))
        random.Random(seed).shuffle(order)
        half = n // 2
        select, confirm = sorted(order[:half]), sorted(order[half:])

        def key(cell):
            w = cell["weights"]
            return f"{w['tfidf']}/{w['sbert']}/{w['metadata']}"

        best_cell = max(cells, key=lambda c: vectors[key(c)][select].mean())
        best = vectors[key(best_cell)][confirm]
        comparisons = []

        for name in PIPELINE_CONFIGS:
            other = vectors[f"preset:{name}"][confirm]
            diff = stats.paired_bootstrap(best, other, resamples=2000, seed=seed)
            comparisons.append(
                {
                    "preset": name,
                    "preset_mean": float(other.mean()),
                    "mean_diff": diff["mean_diff"],
                    "lo": diff["lo"],
                    "hi": diff["hi"],
                    "clear": bool(diff["lo"] > 0),
                    "worse": bool(diff["hi"] < 0),
                }
            )

        strongest = max(comparisons, key=lambda c: c["preset_mean"])
        heldout = {
            "n_select": len(select),
            "n_confirm": len(confirm),
            "chosen": best_cell["weights"],
            "chosen_select_mean": float(vectors[key(best_cell)][select].mean()),
            "chosen_confirm": {
                **stats.bootstrap_ci(best, resamples=2000, seed=seed),
            },
            "comparisons": comparisons,
            "strongest_preset": strongest["preset"],
            "outcome": (
                "better"
                if strongest["clear"]
                else "worse"
                if strongest["worse"]
                else "no_difference"
            ),
        }
    else:
        reason = (
            f"Only {n} scorable queries: too few to split into a "
            f"selection half and a confirmation half, so the grid below "
            f"is exploratory only."
        )

    return {
        **base,
        "grid": cells,
        "top": top,
        "preset_means": preset_means,
        "heldout": heldout,
        "reason": reason,
    }

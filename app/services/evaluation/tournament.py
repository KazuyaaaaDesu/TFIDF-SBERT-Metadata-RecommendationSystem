"""
Tournament runner: a statistically grounded Arena battle.

A single Arena bout asks "what do the pipelines return here?" and
crowns a consensus winner -- the pipeline closest to the others, with
no ground truth and no uncertainty. A tournament instead scores every
pipeline on many queries against known relevance and lets the paired
tests in ``stats`` decide whether any pipeline is actually better.

Relevance comes from leave-one-out citations (``loo_qrels``): the
query is a paper's own text, the relevant set is its resolved
references. The seed paper and its duplicates are removed from every
pipeline's candidates, so no pipeline can score by finding the paper
itself.

Per query each pipeline gets nDCG@k (the pre-declared primary
metric), MRR@k, Recall@20 and Hit@k. Per-query scores are persisted
next to the verdict so any later analysis can be re-run.

The search callable is injectable (same keyword signature as
``search_papers``) so tests can use deterministic results.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Callable, Sequence

from sqlalchemy.orm import Session

from app.models.models import TournamentQueryScore, TournamentRun
from app.services.evaluation import loo_qrels, metrics, stats
from app.services.evaluation.corpus_state import corpus_snapshot
from app.services.evaluation.runner import MAX_TOP_K, _ranked_ids
from app.services.recommendation.pipeline_config import PIPELINE_NAMES

KIND_LOO = "loo_citations"
CUSTOM_PIPELINE = "custom"

RECALL_K = 20
# Per-run ceiling. Runs are durable background jobs saved query by query,
# so a long one is safe (about 0.4 s per pipeline per query: 5,000 queries
# across two pipelines is under an hour), and the statistics scale: the
# bootstrap and tests for 5,000 queries finish in a few seconds.
MAX_QUERIES = 5000
DEFAULT_QUERIES = 60

PRIMARY_METRICS = {
    "ndcg": "nDCG@k",
    "mrr": "MRR@k",
    "recall": f"Recall@{RECALL_K}",
    "hit": "Hit@k",
}
METRIC_KEYS = tuple(PRIMARY_METRICS)

SearchCallable = Callable[..., list[dict]]


def _default_search() -> SearchCallable:
    from app.services.recommendation.search_service import search_papers

    return search_papers


def score_ranking(
    ranked: Sequence,
    relevance: dict[int, int],
    top_k: int,
) -> dict[str, float]:
    """The four per-query metrics for one ranked id list."""

    relevant = set(relevance)

    return {
        "ndcg": metrics.ndcg_at_k(ranked, relevance, top_k),
        "mrr": metrics.mrr_at_k(ranked, relevant, top_k),
        "recall": metrics.recall_at_k(ranked, relevant, RECALL_K),
        "hit": metrics.hit_rate_at_k(ranked, relevant, top_k),
    }


def _validate(
    pipelines: Sequence[str],
    top_k: int,
    primary_metric: str,
    custom_weights,
) -> list[str]:
    names: list[str] = []

    for name in pipelines:
        if name not in PIPELINE_NAMES and name != CUSTOM_PIPELINE:
            raise ValueError(f"Unsupported recommendation pipeline: {name}")

        if name not in names:
            names.append(name)

    if len(names) < 2:
        raise ValueError("A tournament needs at least two pipelines.")

    if CUSTOM_PIPELINE in names and not custom_weights:
        raise ValueError("The 'custom' pipeline requires weights.")

    if (
        isinstance(top_k, bool)
        or not isinstance(top_k, int)
        or not 1 <= top_k <= MAX_TOP_K
    ):
        raise ValueError(f"top_k must be between 1 and {MAX_TOP_K}.")

    if primary_metric not in PRIMARY_METRICS:
        raise ValueError(
            f"primary_metric must be one of {', '.join(METRIC_KEYS)}."
        )

    return names


def score_query(
    db: Session,
    query: loo_qrels.LooQuery,
    names: Sequence[str],
    *,
    top_k: int,
    search: SearchCallable,
    custom_weights: dict[str, float] | None,
) -> tuple[dict[str, dict[str, float]] | None, str | None]:
    """
    Every pipeline's metrics on one query.

    Returns ``(per_pipeline, None)``, or ``(None, reason)`` when the
    query cannot be scored (nothing relevant, or a pipeline errored --
    one bad query must not sink the run). The seed paper and its
    duplicates are removed from each pipeline's candidates.
    """

    # Degenerate queries (nothing relevant) cannot discriminate.
    if not query.relevance:
        return None, "no relevant"

    depth = min(
        MAX_TOP_K * 2,
        max(top_k, RECALL_K) + len(query.excluded_ids),
    )
    per_pipeline: dict[str, dict[str, float]] = {}

    for name in names:
        try:
            raw = search(
                db=db,
                query=query.query,
                seed_paper_id=None,
                pipeline=name,
                top_k=depth,
                custom_weights=(
                    custom_weights if name == CUSTOM_PIPELINE else None
                ),
            )
        except Exception as error:
            return None, f"{name}: {error}"

        ranked = [
            paper_id
            for paper_id in _ranked_ids(raw)
            if paper_id not in query.excluded_ids
        ]
        per_pipeline[name] = score_ranking(ranked, query.relevance, top_k)

    return per_pipeline, None


def assemble_result(
    *,
    names: Sequence[str],
    scores: dict[str, dict[str, list[float]]],
    dropped: list[dict],
    top_k: int,
    primary_metric: str,
    min_refs: int,
    seed: int,
    alpha: float,
    resamples: int,
    label: str | None,
) -> dict:
    """The verdict and summaries for a set of per-query scores.

    Pure function of ``scores`` and the settings, so a stored run can be
    re-analysed identically. Raises ``ValueError`` below two queries.
    """

    names = list(names)
    n_scored = len(scores[names[0]][METRIC_KEYS[0]])

    if n_scored < 2:
        raise ValueError(
            f"Only {n_scored} query could be scored "
            f"({len(dropped)} dropped); a tournament needs at least 2."
        )

    verdict = stats.rank_with_ties(
        {name: scores[name][primary_metric] for name in names},
        alpha=alpha,
        resamples=resamples,
        seed=seed,
    )

    secondary = {
        key: {
            name: stats.bootstrap_ci(
                scores[name][key], resamples=resamples, seed=seed
            )
            for name in names
        }
        for key in METRIC_KEYS
        if key != primary_metric
    }

    return {
        "kind": KIND_LOO,
        "label": label,
        "primary_metric": primary_metric,
        "primary_metric_name": PRIMARY_METRICS[primary_metric],
        "top_k": top_k,
        "recall_k": RECALL_K,
        "pipelines": names,
        "n_queries": n_scored,
        "dropped": dropped,
        "min_refs": min_refs,
        "seed": seed,
        "verdict": verdict,
        "secondary": secondary,
        "run_id": None,
    }


def run_tournament(
    db: Session,
    *,
    pipelines: Sequence[str] | None = None,
    top_k: int = 10,
    n_queries: int = DEFAULT_QUERIES,
    min_refs: int = loo_qrels.DEFAULT_MIN_REFS,
    primary_metric: str = "ndcg",
    seed: int = 0,
    alpha: float = stats.DEFAULT_ALPHA,
    resamples: int = 2000,
    custom_weights: dict[str, float] | None = None,
    label: str | None = None,
    record: bool = True,
    run_search: SearchCallable | None = None,
    queries: list[loo_qrels.LooQuery] | None = None,
) -> dict:
    """
    Run a leave-one-out citation tournament and return its verdict.

    Raises ``ValueError`` for bad arguments and when the repository
    has no usable queries or fewer than two scorable ones.
    """

    names = _validate(
        list(pipelines) if pipelines else list(PIPELINE_NAMES),
        top_k,
        primary_metric,
        custom_weights,
    )

    if not 1 <= n_queries <= MAX_QUERIES:
        raise ValueError(f"n_queries must be between 1 and {MAX_QUERIES}.")

    search = run_search or _default_search()

    pool = (
        queries
        if queries is not None
        else loo_qrels.build_loo_queries(
            db, n=n_queries, min_refs=min_refs, seed=seed
        )
    )

    if not pool:
        raise ValueError(
            "No papers have enough resolved references to build "
            f"queries (need at least {min_refs}). Refresh citations "
            "first."
        )

    scores: dict[str, dict[str, list[float]]] = {
        name: {key: [] for key in METRIC_KEYS} for name in names
    }
    rows: list[dict] = []
    dropped: list[dict] = []

    for query in pool:
        per_pipeline, reason = score_query(
            db,
            query,
            names,
            top_k=top_k,
            search=search,
            custom_weights=custom_weights,
        )

        if per_pipeline is None:
            dropped.append(
                {"seed_paper_id": query.seed_paper_id, "reason": reason}
            )
            continue

        for name, values in per_pipeline.items():
            for key in METRIC_KEYS:
                scores[name][key].append(values[key])

            rows.append(
                {
                    "pipeline_id": name,
                    "seed_paper_id": query.seed_paper_id,
                    "num_relevant": len(query.relevance),
                    **values,
                }
            )

    result = assemble_result(
        names=names,
        scores=scores,
        dropped=dropped,
        top_k=top_k,
        primary_metric=primary_metric,
        min_refs=min_refs,
        seed=seed,
        alpha=alpha,
        resamples=resamples,
        label=label,
    )

    if record:
        result["run_id"] = _persist(
            db, result, rows, custom_weights=custom_weights
        )

    return result


def _persist(
    db: Session,
    result: dict,
    rows: list[dict],
    *,
    custom_weights,
) -> int:
    corpus = corpus_snapshot(db)
    verdict = result["verdict"]

    run = TournamentRun(
        kind=result["kind"],
        label=(result["label"] or None) and str(result["label"])[:120],
        primary_metric=result["primary_metric"],
        top_k=result["top_k"],
        n_queries=result["n_queries"],
        dropped_queries=len(result["dropped"]),
        min_refs=result["min_refs"],
        seed=result["seed"],
        pipelines=json.dumps(result["pipelines"]),
        outcome=verdict["outcome"],
        winner_pipeline_id=verdict["winner"],
        result_json=json.dumps(
            {**result, "custom_weights": custom_weights}
        ),
        corpus_size=corpus["corpus_size"],
        corpus_version=corpus["corpus_version"],
    )
    db.add(run)
    db.flush()

    db.add_all(
        TournamentQueryScore(
            run_id=run.id,
            pipeline_id=row["pipeline_id"],
            seed_paper_id=row["seed_paper_id"],
            num_relevant=row["num_relevant"],
            ndcg=row["ndcg"],
            mrr=row["mrr"],
            recall=row["recall"],
            hit=row["hit"],
        )
        for row in rows
    )
    db.commit()

    return run.id


def run_summary(run: TournamentRun) -> dict:
    """The list-view shape of a stored tournament."""

    return {
        "id": run.id,
        "kind": run.kind,
        "label": run.label,
        "created_at": run.created_at.isoformat(),
        "primary_metric": run.primary_metric,
        "top_k": run.top_k,
        "n_queries": run.n_queries,
        "dropped_queries": run.dropped_queries,
        "pipelines": json.loads(run.pipelines),
        "outcome": run.outcome,
        "status": run.status,
        "winner_pipeline_id": run.winner_pipeline_id,
        "corpus_size": run.corpus_size,
        "corpus_version": run.corpus_version,
    }


def eligible_query_count(db: Session, min_refs: int) -> dict:
    """How many leave-one-out queries the repository can supply.

    One SQL aggregate, so it is instant even on a large library; the
    exact set (which also removes duplicates of the seed) is built
    when a tournament runs and can only be smaller.
    """

    return {
        "min_refs": min_refs,
        "available": loo_qrels.count_eligible(db, min_refs),
        "exact": False,
        "required_n_for_0_05": stats.required_sample_size(0.05, 0.2),
    }


EXPORT_FORMATS = ("csv", "pairwise", "json")

SCORE_COLUMNS = (
    "run_id",
    "pipeline_id",
    "seed_paper_id",
    "num_relevant",
    "ndcg",
    "mrr",
    "recall",
    "hit",
)

PAIR_COLUMNS = (
    "run_id",
    "a",
    "b",
    "mean_diff",
    "ci_lo",
    "ci_hi",
    "p_value",
    "p_adjusted",
    "significant",
    "cliffs_delta",
    "paired_delta",
    "cohens_dz",
    "test",
    "effect_kind",
    "effect_size",
    "effect_label",
    "a_only",
    "b_only",
)


def _csv_text(columns: Sequence[str], rows: Sequence[Sequence]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)

    return buffer.getvalue()


def export_tournament(
    detail: dict,
    fmt: str,
) -> tuple[str, str, str]:
    """
    Serialise one stored tournament (the ``/tournament/{id}`` payload).

    Returns ``(filename, media_type, text)``.

      csv       one row per pipeline x query: the raw per-query
                scores, enough to re-run any test elsewhere
      pairwise  one row per pipeline pair: difference, CI, raw and
                Holm-adjusted p, effect sizes
      json      the whole record -- verdict, secondary metrics,
                dropped queries and per-query scores
    """

    if fmt not in EXPORT_FORMATS:
        raise ValueError(
            f"format must be one of {', '.join(EXPORT_FORMATS)}."
        )

    run_id = detail["run_id"]

    if fmt == "csv":
        rows = [
            [
                run_id,
                row["pipeline_id"],
                row["seed_paper_id"],
                row["num_relevant"],
                row["ndcg"],
                row["mrr"],
                row["recall"],
                row["hit"],
            ]
            for row in detail["query_scores"]
        ]

        return (
            f"tournament-{run_id}-scores.csv",
            "text/csv; charset=utf-8",
            _csv_text(SCORE_COLUMNS, rows),
        )

    if fmt == "pairwise":
        rows = [
            [
                run_id,
                pair["a"],
                pair["b"],
                pair["mean_diff"],
                pair["lo"],
                pair["hi"],
                pair["p_value"],
                pair["p_adjusted"],
                int(bool(pair["significant"])),
                pair["cliffs_delta"],
                pair.get("paired_delta", ""),
                pair["cohens_dz"],
                pair.get("test", "wilcoxon"),
                pair.get("effect_kind", "delta"),
                pair.get("effect_size", pair["cliffs_delta"]),
                pair.get("effect_label", ""),
                pair.get("a_only", ""),
                pair.get("b_only", ""),
            ]
            for pair in detail["verdict"]["pairwise"]
        ]

        return (
            f"tournament-{run_id}-pairwise.csv",
            "text/csv; charset=utf-8",
            _csv_text(PAIR_COLUMNS, rows),
        )

    return (
        f"tournament-{run_id}.json",
        "application/json; charset=utf-8",
        json.dumps(detail, indent=2, allow_nan=False, default=str),
    )

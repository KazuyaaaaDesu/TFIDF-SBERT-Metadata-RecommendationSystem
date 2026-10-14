"""
Judging a battle against ground truth.

The Arena's consensus winner measures agreement between pipelines, not
quality: on recorded battles it never picked S-BERT, the pipeline the
tournament found strongest, and most wins were decided by a margin well
inside noise. This module scores a battle's result lists against actual
relevance instead, from one of two sources:

    "references"  a seed-paper battle: the paper's own resolved references
                  (grade 2) and citers (grade 1), the same ground truth the
                  tournament uses
    "human"       a text battle: results a person ticked as relevant, with
                  the pipeline names hidden until they submitted

One battle is one query, so a judged result is one sample, never a verdict
about the pipelines. It is shown with its scores and a plain "separated /
not separated" flag; claims about which pipeline is better come from many
judged battles (``judged_summary``) or a tournament.

Pure functions: lists of paper ids and a relevance map in, scores out.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence

from app.services.evaluation import metrics, stats

BASIS_REFERENCES = "references"
BASIS_HUMAN = "human"
BASES = (BASIS_REFERENCES, BASIS_HUMAN)

# Leader's nDCG must exceed the runner-up's by this much to be called
# separated on a single query. One query proves little either way.
MIN_JUDGED_MARGIN = 0.1

# Judged battles needed before the aggregate may claim a verdict.
MIN_JUDGED_FOR_VERDICT = 10


def judge_lists(
    lists: Mapping[str, Sequence[int]],
    relevance: Mapping[int, float],
    *,
    k: int,
    basis: str,
    n_relevant: int | None = None,
    excluded: Iterable[int] = (),
) -> dict:
    """
    Score each pipeline's result list against ``relevance``.

    ``relevance`` maps paper id -> grade (> 0 is relevant). ``excluded``
    ids (the seed paper and its duplicates) are removed from every list
    first, so a pipeline cannot score by returning the paper itself.
    ``n_relevant`` is the recall denominator (default: the judged
    relevant count).
    """

    if basis not in BASES:
        raise ValueError(f"basis must be one of {', '.join(BASES)}.")

    if not lists:
        raise ValueError("There are no result lists to judge.")

    gone = set(excluded)
    graded = {int(pid): float(g) for pid, g in relevance.items() if g > 0}
    relevant_ids = set(graded)
    total = n_relevant if n_relevant is not None else len(relevant_ids)

    scores: dict[str, dict] = {}

    for pipeline, ids in lists.items():
        ranked = [pid for pid in ids if pid not in gone][:k]
        hits = [pid for pid in ranked if pid in relevant_ids]

        scores[pipeline] = {
            "ndcg": metrics.ndcg_at_k(ranked, graded, k),
            "hits": len(hits),
            "hit": 1.0 if hits else 0.0,
            "precision": len(hits) / k,
            "mrr": metrics.mrr_at_k(ranked, relevant_ids, k),
            "recall": (len(hits) / total) if total else 0.0,
            "relevant_ids": hits,
            "returned": len(ranked),
        }

    ranking = sorted(
        scores, key=lambda p: (-scores[p]["ndcg"], -scores[p]["hits"], p)
    )
    top = scores[ranking[0]]["ndcg"]
    leaders = [p for p in ranking if scores[p]["ndcg"] == top]
    runner = ranking[len(leaders)] if len(leaders) < len(ranking) else None
    margin = top - scores[runner]["ndcg"] if runner else 0.0

    return {
        "basis": basis,
        "k": k,
        "n_relevant": total,
        "relevance": {str(pid): grade for pid, grade in graded.items()},
        "scores": scores,
        "ranking": ranking,
        "leaders": leaders,
        "leader": leaders[0] if len(leaders) == 1 else None,
        "margin": margin,
        # One query: "separated" is a statement about this query only.
        "separated": len(leaders) == 1 and margin >= MIN_JUDGED_MARGIN,
        "nothing_relevant_found": top == 0.0,
    }


def lists_from_response(response: Mapping) -> dict[str, list[int]]:
    """Each pipeline's ranked paper ids from a stored CompareResponse."""

    return {
        pipeline["id"]: [row["paper_id"] for row in pipeline["results"]]
        for pipeline in response.get("pipelines", [])
    }


def references_for_seed(db, seed_paper_id: int):
    """The seed paper's ground truth, or None if it has none.

    Returns the leave-one-out query for the paper: its resolved references
    (grade 2) and citers (grade 1), plus the ids (itself and duplicates)
    that must not count. A paper with no resolved references in the
    library cannot be judged this way.
    """

    from app.services.evaluation import loo_qrels

    found = loo_qrels.build_loo_queries(
        db, min_refs=1, paper_ids=[seed_paper_id]
    )

    return found[0] if found else None


def judge_seed_battle(db, response: Mapping, seed_paper_id: int) -> dict | None:
    """Judge a seed-paper battle against the seed's own references."""

    truth = references_for_seed(db, seed_paper_id)

    if truth is None:
        return None

    return judge_lists(
        lists_from_response(response),
        truth.relevance,
        k=int(response.get("top_k", 10)),
        basis=BASIS_REFERENCES,
        excluded=truth.excluded_ids,
    )


def judged_summary(rows: Sequence[Mapping]) -> dict:
    """
    Aggregate judged battles: mean quality per pipeline over every battle
    that was judged, with intervals, and a verdict only when there are
    enough battles to support one.

    ``rows`` are dicts with ``judgement_json``. Battles are paired by
    construction (every pipeline answers every query), so the tournament's
    tests apply unchanged.
    """

    judged = []

    for row in rows:
        try:
            data = json.loads(row.get("judgement_json") or "null")
        except ValueError:
            continue

        if data and data.get("scores") and not data.get("nothing_relevant_found"):
            judged.append(data)

    skipped = sum(1 for r in rows if r.get("judgement_json")) - len(judged)
    pipelines = sorted({p for d in judged for p in d["scores"]})
    # Only battles in which every pipeline was scored are comparable.
    complete = [d for d in judged if all(p in d["scores"] for p in pipelines)]
    by_basis: dict[str, int] = {}

    for d in complete:
        by_basis[d["basis"]] = by_basis.get(d["basis"], 0) + 1

    out: dict = {
        "n_judged": len(complete),
        "n_skipped_nothing_relevant": skipped,
        "by_basis": by_basis,
        "min_for_verdict": MIN_JUDGED_FOR_VERDICT,
        "pipelines": [],
        "verdict": None,
    }

    if not complete:
        return out

    vectors = {
        p: [d["scores"][p]["ndcg"] for d in complete] for p in pipelines
    }

    out["pipelines"] = sorted(
        (
            {
                "pipeline": p,
                **stats.bootstrap_ci(vectors[p], resamples=2000, seed=0),
                "hit_rate": sum(d["scores"][p]["hit"] for d in complete) / len(complete),
            }
            for p in pipelines
        ),
        key=lambda row: -row["mean"],
    )

    if len(complete) >= MIN_JUDGED_FOR_VERDICT and len(pipelines) >= 2:
        out["verdict"] = stats.rank_with_ties(vectors, resamples=2000, seed=0)

    return out

"""
Pipeline comparison service ("Pipeline Battle").

Runs every implemented recommendation pipeline against the same
query or seed paper and returns the ranked results side by side,
so the Evaluation page can show which pipelines agree, disagree,
and which papers win across all of them.

For the thesis this is the raw material of the evaluation chapter:
consensus ranking, pairwise agreement, and per-pipeline rank
displacement are exactly the quantities reported when comparing
lexical / semantic / metadata / hybrid configurations.
"""

from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.evaluation.battle_explain import explain_differences
from app.services.recommendation.search_service import (
    search_papers as run_search,
)

PIPELINE_ORDER: tuple[str, ...] = (
    "tfidf",
    "sbert",
    "tfidf_sbert",
    "tfidf_metadata",
    "sbert_metadata",
    "tfidf_sbert_metadata",
)

# Component set per pipeline. Two pipelines agree "independently"
# only to the extent they share no building blocks: a hybrid's
# top-k is partly a re-run of its own components, so its agreement
# with those components carries less evidence than a disjoint
# pipeline's agreement.
PIPELINE_COMPONENTS: dict[str, frozenset[str]] = {
    "tfidf": frozenset({"tfidf"}),
    "sbert": frozenset({"sbert"}),
    "tfidf_sbert": frozenset({"tfidf", "sbert"}),
    "tfidf_metadata": frozenset({"tfidf", "metadata"}),
    "sbert_metadata": frozenset({"sbert", "metadata"}),
    "tfidf_sbert_metadata": frozenset({"tfidf", "sbert", "metadata"}),
}


# A leader must clear the runner-up by this much captured share to count
# as a decisive win. Recorded battles: median margin 0.007, and 9 of 11
# full battles were decided by less than 0.02, i.e. by noise.
MIN_DECISIVE_MARGIN = 0.02


def _independence_weight(
    a: str,
    b: str,
    component_sets: dict[str, frozenset[str]],
) -> float:
    """1 - Jaccard(component sets): how much of pipeline a's evidence
    is not already contained in pipeline b.

    Disjoint pipelines weigh 1.0; a two-signal hybrid weighs 0.5
    against a pipeline built from one of its own components, and the
    three-signal hybrid weighs at most 2/3 against a single-signal
    pipeline, so a pipeline can never be confirmed by its own
    offspring.
    """

    components_a = component_sets[a]
    components_b = component_sets[b]

    union = components_a | components_b
    if not union:
        return 0.0

    return 1.0 - (len(components_a & components_b) / len(union))


class CompareRequest(BaseModel):
    query: str | None = None
    seed_paper_id: int | None = None
    top_k: int = Field(default=10, ge=1, le=25)
    # Lab battles: a custom recipe joins the six presets as a 7th
    # pipeline (weights must be non-negative, not all zero).
    custom_weights: dict[str, float] | None = None
    # Lab experiments: diversification applied to EVERY pipeline's
    # result list before the comparison is assembled.
    mmr_lambda: float | None = Field(default=None, ge=0, le=1)
    mmr_pool: int = Field(default=50, ge=1, le=100)
    # Lab simulations should not pollute the Arena's battle history.
    record_battle: bool = True
    # Research tag for the run being recorded, free text, e.g.
    # "campaign-ml-text-5". Optional because casual use must not be
    # forced to name its runs -- but a formal campaign run cannot be
    # identified without one, and the label cannot be reconstructed
    # from the query afterwards.
    run_label: str | None = Field(default=None, max_length=200)
    # Which of the campaign's subject classes this run belongs to.
    # Optional for the same reason: no preset is enforced here, so a
    # run outside the six classes is still recorded rather than
    # rejected.
    subject_class: str | None = Field(default=None, max_length=100)


class RankedPaper(BaseModel):
    paper_id: int
    title: str | None = None
    year: int | None = None
    score: float
    # The weighted TF-IDF / S-BERT / metadata contributions behind the
    # score (repository battles only); what "explain differences" reads.
    components: dict[str, float] | None = None


class PipelineBattle(BaseModel):
    id: str
    results: list[RankedPaper]


class ConsensusEntry(BaseModel):
    paper_id: int
    title: str | None = None
    year: int | None = None
    votes: int
    avg_rank: float | None = None
    best_rank: int | None = None


class PairwiseAgreement(BaseModel):
    a: str
    b: str
    overlap: int
    mean_rank_gap: float | None = None


class WinnerResult(BaseModel):
    """The pipeline that captured the most independence-weighted
    consensus.

    Metric ("independence_weighted_consensus"): each paper in a
    pipeline's top-k collects votes from the other pipelines, where a
    vote from pipeline Q weighs independence(P, Q) = 1 - Jaccard of
    the two pipelines' component sets. Agreement with a pipeline built
    from the same signals is weak evidence; agreement with a disjoint
    pipeline is strong evidence — so no pipeline can win by having its
    hybrids re-confirm its own output.

    The reported value is the pipeline's captured share (0..1) of its
    maximum possible weighted consensus, which puts pure and hybrid
    pipelines on the same scale. Ties are broken by the lower average
    consensus rank.

    DESCRIPTIVE ONLY. This measures agreement with the other
    pipelines on one query, not quality: it uses no ground truth and
    carries no uncertainty, and it favours whichever pipeline sits
    nearest the centre of the group. For a verdict about which
    pipeline is better, run a tournament (evaluation/tournament.py),
    which scores many queries against known relevance and tests the
    differences.
    """

    pipeline_id: str
    metric: Literal["independence_weighted_consensus"]
    value: float
    avg_consensus_rank: float | None = None

    # How decisive the win is. The consensus share is a close call far
    # more often than not (on recorded battles the median lead over the
    # runner-up was 0.007), so a leader is only a *decisive* leader when
    # it clears the runner-up by MIN_DECISIVE_MARGIN; otherwise the
    # battle is "too close to call" and the pipelines within that margin
    # are listed as contenders. `decisive` is None only on results built
    # before this existed.
    margin: float | None = None
    runner_up: str | None = None
    decisive: bool | None = None
    contenders: list[str] = []
    shares: dict[str, float] = {}
    min_margin: float = 0.02


class CompareResponse(BaseModel):
    query: str | None = None
    seed_paper_id: int | None = None
    top_k: int
    pipelines: list[PipelineBattle]
    consensus: list[ConsensusEntry]
    pairwise: list[PairwiseAgreement]
    winner: WinnerResult | None = None
    # Set by the API once the battle has been recorded.
    battle_id: int | None = None
    # Quality against ground truth, when there is some (a seed-paper
    # battle is scored against that paper's own references).
    judgement: dict | None = None
    # Where the pipelines disagreed and which signal drove each list
    # (see evaluation/battle_explain.py).
    differences: dict | None = None


def _run_one(
    db: Session,
    pipeline: str,
    query: str | None,
    seed_paper_id: int | None,
    top_k: int,
    custom_weights: dict[str, float] | None = None,
    mmr_lambda: float | None = None,
    mmr_pool: int = 50,
) -> tuple[dict[int, int], dict[int, float], list[RankedPaper]]:
    """Run one pipeline; return (rank_map, score_map, ranked list)."""

    results = run_search(
        db=db,
        query=query,
        seed_paper_id=seed_paper_id,
        pipeline=pipeline,
        top_k=top_k,
        custom_weights=custom_weights,
        mmr_lambda=mmr_lambda,
        mmr_pool=mmr_pool,
    )

    ranked: list[RankedPaper] = []
    rank_map: dict[int, int] = {}
    score_map: dict[int, float] = {}

    for position, result in enumerate(results, start=1):
        paper = result["paper"]
        score = float(result["score"])

        ranked.append(
            RankedPaper(
                paper_id=paper.id,
                title=paper.title,
                year=paper.publication_year,
                score=round(score, 6),
                components=result.get("components"),
            )
        )

        rank_map[paper.id] = position
        score_map[paper.id] = score

    return rank_map, score_map, ranked


def compare_pipelines_stream(
    *,
    db: Session,
    query: str | None,
    seed_paper_id: int | None,
    top_k: int,
    custom_weights: dict[str, float] | None = None,
    mmr_lambda: float | None = None,
    mmr_pool: int = 50,
):
    """Run the pipelines one at a time, yielding as each finishes.

    Yields ``("start", [pipeline ids])``, then
    ``("pipeline", PipelineBattle, seconds)`` per pipeline as it
    completes, and last ``("done", CompareResponse)``. The progress a
    caller shows is therefore real: it is the pipelines that have
    actually returned.
    """

    rank_maps: dict[str, dict[int, int]] = {}
    battles: list[PipelineBattle] = []

    pipeline_order = list(PIPELINE_ORDER)

    # The custom recipe's component set derives from its weights:
    # any signal with a positive share is part of the pipeline.
    component_sets = dict(PIPELINE_COMPONENTS)

    if custom_weights is not None:
        if not any(
            (custom_weights.get(signal) or 0) > 0
            for signal in ("tfidf", "sbert", "metadata")
        ):
            raise ValueError(
                "Custom recipe needs at least one signal above zero."
            )

        pipeline_order.append("custom")
        component_sets["custom"] = frozenset(
            signal
            for signal, weight in custom_weights.items()
            if (weight or 0) > 0
        )

    yield ("start", list(pipeline_order))

    for pipeline in pipeline_order:
        started = time.perf_counter()
        rank_map, _score_map, ranked = _run_one(
            db=db,
            pipeline=pipeline,
            query=query,
            seed_paper_id=seed_paper_id,
            top_k=top_k,
            custom_weights=(
                custom_weights if pipeline == "custom" else None
            ),
            mmr_lambda=mmr_lambda,
            mmr_pool=mmr_pool,
        )

        rank_maps[pipeline] = rank_map
        battle = PipelineBattle(id=pipeline, results=ranked)
        battles.append(battle)

        yield ("pipeline", battle, time.perf_counter() - started)

    yield (
        "done",
        _assemble_comparison(
            rank_maps=rank_maps,
            battles=battles,
            component_sets=component_sets,
            query=query,
            seed_paper_id=seed_paper_id,
            top_k=top_k,
        ),
    )


def compare_pipelines(**kwargs) -> CompareResponse:
    """Run the six pipelines, plus an optional custom recipe as a
    seventh "custom" pipeline (the Lab's recipes), and assemble the
    comparison payload.

    ``mmr_lambda`` (opt-in, 0..1) reranks every pipeline's results
    with Maximal Marginal Relevance before assembly, so the Lab can
    battle recipes with diversification on; ``None`` keeps the plain
    score order.
    """

    result = None

    for event in compare_pipelines_stream(**kwargs):
        if event[0] == "done":
            result = event[1]

    assert result is not None

    return result


def _assemble_comparison(
    *,
    rank_maps: dict[str, dict[int, int]],
    battles: list[PipelineBattle],
    component_sets: dict[str, frozenset[str]],
    query: str | None,
    seed_paper_id: int | None,
    top_k: int,
) -> CompareResponse:
    """Assemble consensus ranking, pairwise agreement, and the
    independence-weighted winner from per-pipeline rank maps.
    Shared by the repository battles and the web battles."""

    pipeline_order = list(rank_maps.keys())

    # --------------------------------------------------------
    # Consensus: every paper any pipeline ranked, scored by
    # votes (how many pipelines included it) then avg rank.
    # --------------------------------------------------------

    union_ids: set[int] = set()
    paper_info: dict[int, dict] = {}

    for rank_map in rank_maps.values():
        union_ids.update(rank_map)

    for battle in battles:
        for result in battle.results:
            paper_info.setdefault(
                result.paper_id,
                {
                    "title": result.title,
                    "year": result.year,
                },
            )

    consensus: list[ConsensusEntry] = []

    for paper_id in union_ids:
        voters = [
            pipeline
            for pipeline, rank_map in rank_maps.items()
            if paper_id in rank_map
        ]

        ranks = [rank_maps[p][paper_id] for p in voters]
        avg_rank = round(sum(ranks) / len(ranks), 2)

        consensus.append(
            ConsensusEntry(
                paper_id=paper_id,
                title=paper_info[paper_id]["title"],
                year=paper_info[paper_id]["year"],
                votes=len(voters),
                avg_rank=avg_rank,
                best_rank=min(ranks),
            )
        )

    consensus.sort(
        key=lambda entry: (
            -entry.votes,
            entry.avg_rank or float("inf"),
            entry.paper_id,
        )
    )

    # --------------------------------------------------------
    # Pairwise agreement: overlap@k plus mean absolute rank
    # gap over the papers both pipelines ranked.
    # --------------------------------------------------------

    pairwise: list[PairwiseAgreement] = []

    for i, pipeline_a in enumerate(pipeline_order):
        for pipeline_b in pipeline_order[i + 1:]:
            set_a = set(rank_maps[pipeline_a])
            set_b = set(rank_maps[pipeline_b])

            shared = set_a & set_b

            mean_gap = None
            if shared:
                gaps = [
                    abs(
                        rank_maps[pipeline_a][paper_id]
                        - rank_maps[pipeline_b][paper_id]
                    )
                    for paper_id in shared
                ]
                mean_gap = round(
                    sum(gaps) / len(gaps),
                    2,
                )

            pairwise.append(
                PairwiseAgreement(
                    a=pipeline_a,
                    b=pipeline_b,
                    overlap=len(shared),
                    mean_rank_gap=mean_gap,
                )
            )

    # --------------------------------------------------------
    # Winner: most independence-weighted consensus captured,
    # averaged over the pipeline's own top-k results and
    # normalized by the total weight available to it; ties broken
    # by the lower average consensus rank.
    # --------------------------------------------------------

    winner = _pick_winner(
        rank_maps=rank_maps,
        consensus=consensus,
        component_sets=component_sets,
    )

    return CompareResponse(
        query=query,
        seed_paper_id=seed_paper_id,
        top_k=top_k,
        pipelines=battles,
        consensus=consensus,
        pairwise=pairwise,
        winner=winner,
        differences=explain_differences(
            {
                battle.id: [r.model_dump() for r in battle.results]
                for battle in battles
            }
        ),
    )


def _score_web_hits(*, query: str, hits: list):
    """Vectorize web hits on the fly and score them against the query.

    Returns (papers, tfidf_raw, sbert_raw, meta_raw). The hits become
    transient Paper objects with negative ids (web candidates never
    collide with repository ids), and every component score is the raw
    value: the pipelines min-max normalize and weight them afterwards,
    exactly as they do for repository papers.
    """

    from app.models.models import Paper
    from app.services.text_preparation import build_prepared_text
    from app.services.recommendation.similarity import cosine_similarity
    from app.services.recommendation import (
        tfidf_pipeline,
        sbert_pipeline,
    )
    from app.services.recommendation.metadata_pipeline import (
        score_candidates as metadata_score_candidates,
    )

    papers: list[Paper] = []

    for index, hit in enumerate(hits):
        paper = Paper(
            # Negative ids mark these as web candidates, never
            # colliding with repository paper ids in the UI.
            id=-(index + 1),
            title=hit.title,
            abstract=hit.abstract,
            keywords=None,
            publication_year=hit.publication_year,
        )
        paper.prepared_text = build_prepared_text(
            hit.title,
            hit.abstract,
            None,
        )
        papers.append(paper)

    if not papers:
        return papers, {}, {}, {}

    prepared_query = build_prepared_text(query, None, None)

    query_tfidf = tfidf_pipeline.vectorize_query_or_seed(prepared_query)
    query_sbert = sbert_pipeline.embed_query_or_seed(prepared_query)

    tfidf_raw: dict[int, float] = {}
    sbert_raw: dict[int, float] = {}

    hit_embeddings = sbert_pipeline.embed_texts(
        [paper.prepared_text for paper in papers]
    )

    for paper, hit_embedding in zip(papers, hit_embeddings):
        hit_tfidf = tfidf_pipeline.vectorize_query_or_seed(
            paper.prepared_text
        )
        tfidf_raw[paper.id] = cosine_similarity(query_tfidf, hit_tfidf)

        sbert_raw[paper.id] = cosine_similarity(
            query_sbert,
            hit_embedding,
        )

    meta_raw = metadata_score_candidates(
        query=query,
        seed_paper=None,
        candidates=papers,
    )

    return papers, tfidf_raw, sbert_raw, meta_raw


def compare_web_results(
    *,
    query: str,
    hits: list,
    top_k: int,
    custom_weights: dict[str, float] | None = None,
) -> CompareResponse:
    """Battle the pipelines over WEB hits instead of the repository.

    Each hit is vectorized on the fly with the same stored TF-IDF
    vectorizer and S-BERT model, so the six presets (plus an
    optional custom recipe) rank the same external candidates. The
    response shape matches the repository Arena exactly, so the
    Arena and Lab UIs render it unchanged.
    """

    from app.services.recommendation.pipeline_config import (
        get_pipeline_weights,
    )
    from app.services.recommendation.search_service import (
        min_max_normalize,
    )

    papers, tfidf_raw, sbert_raw, meta_raw = _score_web_hits(
        query=query,
        hits=hits,
    )

    if not papers:
        return CompareResponse(
            query=query,
            seed_paper_id=None,
            top_k=top_k,
            pipelines=[],
            consensus=[],
            pairwise=[],
            winner=None,
        )

    pipeline_order = list(PIPELINE_ORDER)

    component_sets = dict(PIPELINE_COMPONENTS)

    if custom_weights is not None:
        pipeline_order.append("custom")
        component_sets["custom"] = frozenset(
            signal
            for signal, weight in custom_weights.items()
            if (weight or 0) > 0
        )

    def run_pipeline(weights: dict[str, float]) -> list[RankedPaper]:
        norm_tfidf = (
            min_max_normalize(tfidf_raw)
            if weights.get("tfidf", 0) > 0
            else {}
        )
        norm_sbert = (
            min_max_normalize(sbert_raw)
            if weights.get("sbert", 0) > 0
            else {}
        )

        combined: dict[int, float] = {}

        for paper in papers:
            combined[paper.id] = (
                weights.get("tfidf", 0)
                * norm_tfidf.get(paper.id, 0.0)
                + weights.get("sbert", 0)
                * norm_sbert.get(paper.id, 0.0)
                + weights.get("metadata", 0)
                * meta_raw.get(paper.id, 0.0)
            )

        ranked_ids = [
            paper_id
            for paper_id in sorted(
                combined,
                key=combined.get,
                reverse=True,
            )
            if combined[paper_id] > 0
        ][:top_k]

        return [
            RankedPaper(
                paper_id=paper_id,
                title=next(
                    (p.title for p in papers if p.id == paper_id),
                    None,
                ),
                year=next(
                    (p.publication_year for p in papers if p.id == paper_id),
                    None,
                ),
                score=round(float(combined[paper_id]), 6),
            )
            for paper_id in ranked_ids
        ]

    rank_maps: dict[str, dict[int, int]] = {}
    battles: list[PipelineBattle] = []

    for pipeline in pipeline_order:
        weights = (
            custom_weights
            if pipeline == "custom"
            else get_pipeline_weights(pipeline)
        )

        results = run_pipeline(weights)

        battles.append(PipelineBattle(id=pipeline, results=results))
        rank_maps[pipeline] = {
            result.paper_id: position
            for position, result in enumerate(results, start=1)
        }

    return _assemble_comparison(
        rank_maps=rank_maps,
        battles=battles,
        component_sets=component_sets,
        query=query,
        seed_paper_id=None,
        top_k=top_k,
    )


def rank_web_results(
    *,
    query: str,
    hits: list,
    weights: dict[str, float],
    top_k: int,
) -> list[dict]:
    """Rank live web hits with ONE pipeline's weights.

    The same scoring a repository search uses: TF-IDF and S-BERT are
    min-max normalized across the candidate set, metadata passes
    through, and the weighted sum orders the hits (ties by newer year,
    then title). Each row carries the hit, its final score and its
    three component scores, so the UI can show why it ranked where it
    did.
    """

    from app.services.recommendation.search_service import (
        min_max_normalize,
    )

    papers, tfidf_raw, sbert_raw, meta_raw = _score_web_hits(
        query=query,
        hits=hits,
    )

    if not papers:
        return []

    norm_tfidf = (
        min_max_normalize(tfidf_raw) if weights.get("tfidf", 0) > 0 else {}
    )
    norm_sbert = (
        min_max_normalize(sbert_raw) if weights.get("sbert", 0) > 0 else {}
    )

    rows = []

    for paper, hit in zip(papers, hits):
        t = norm_tfidf.get(paper.id, 0.0)
        b = norm_sbert.get(paper.id, 0.0)
        m = meta_raw.get(paper.id, 0.0)
        score = (
            weights.get("tfidf", 0) * t
            + weights.get("sbert", 0) * b
            + weights.get("metadata", 0) * m
        )

        rows.append((score, hit, t, b, m))

    rows.sort(
        key=lambda row: (
            -row[0],
            -(row[1].publication_year or 0),
            (row[1].title or "").lower(),
        )
    )

    ranked = []

    for position, (score, hit, t, b, m) in enumerate(
        [row for row in rows if row[0] > 0][:top_k],
        start=1,
    ):
        ranked.append(
            {
                **hit.to_dict(),
                "rank": position,
                "score": round(float(score), 6),
                "components": {
                    "tfidf": round(float(t), 6),
                    "sbert": round(float(b), 6),
                    "metadata": round(float(m), 6),
                },
            }
        )

    return ranked


def _pick_winner(
    *,
    rank_maps: dict[str, dict[int, int]],
    consensus: list[ConsensusEntry],
    component_sets: dict[str, frozenset[str]],
) -> WinnerResult | None:
    """Pick the winner by independence-weighted consensus share.

    For each pipeline P, every paper in P's top-k collects votes
    from the other pipelines, but a vote from Q weighs
    independence(P, Q) = 1 - Jaccard(P's components, Q's components):
    agreement with a pipeline built from the same signals is weak
    evidence, agreement with a disjoint pipeline is strong evidence.
    The winner is the pipeline with the highest share of its maximum
    possible weighted consensus (captured / available), so hybrids
    are compared on the same scale as pure pipelines. Ties fall to
    the pipeline whose results sit higher in the consensus ranking.
    """

    consensus_positions = {
        entry.paper_id: position
        for position, entry in enumerate(consensus, start=1)
    }

    shares, avg_ranks = consensus_shares(
        rank_maps=rank_maps,
        consensus_positions=consensus_positions,
        consensus_size=len(consensus),
        component_sets=component_sets,
    )

    if not shares:
        return None

    ordered = sorted(
        shares,
        key=lambda pipeline: (-shares[pipeline], avg_ranks[pipeline]),
    )
    leader = ordered[0]
    runner_up = ordered[1] if len(ordered) > 1 else None
    margin = (
        shares[leader] - shares[runner_up] if runner_up is not None else None
    )
    contenders = [
        pipeline
        for pipeline in ordered
        if shares[leader] - shares[pipeline] < MIN_DECISIVE_MARGIN
    ]

    return WinnerResult(
        pipeline_id=leader,
        metric="independence_weighted_consensus",
        value=round(shares[leader], 4),
        avg_consensus_rank=round(avg_ranks[leader], 2),
        margin=round(margin, 4) if margin is not None else None,
        runner_up=runner_up,
        # Several pipelines inside the margin = no decisive leader.
        decisive=(margin is not None and margin >= MIN_DECISIVE_MARGIN),
        contenders=contenders,
        shares={p: round(v, 4) for p, v in shares.items()},
        min_margin=MIN_DECISIVE_MARGIN,
    )


def consensus_shares(
    *,
    rank_maps: dict[str, dict[int, int]],
    consensus_positions: dict[int, int],
    consensus_size: int,
    component_sets: dict[str, frozenset[str]],
) -> tuple[dict[str, float], dict[str, float]]:
    """Each pipeline's independence-weighted consensus share and its
    average consensus rank (the tie-break). Pipelines with an empty
    result list are skipped."""

    pipelines = list(rank_maps.keys())

    independence = {
        (a, b): _independence_weight(a, b, component_sets)
        for a in pipelines
        for b in pipelines
        if a != b
    }

    available = {
        pipeline: sum(
            independence[(pipeline, other)]
            for other in pipelines
            if other != pipeline
        )
        for pipeline in pipelines
    }

    shares: dict[str, float] = {}
    avg_ranks: dict[str, float] = {}

    for pipeline in pipelines:
        ranked_ids = list(rank_maps[pipeline].keys())

        if not ranked_ids:
            continue

        captured = sum(
            sum(
                independence[(pipeline, other)]
                for other in pipelines
                if other != pipeline
                and paper_id in rank_maps[other]
            )
            for paper_id in ranked_ids
        ) / len(ranked_ids)

        total_available = available[pipeline]
        shares[pipeline] = (
            captured / total_available if total_available > 0 else 0.0
        )
        avg_ranks[pipeline] = sum(
            consensus_positions.get(paper_id, consensus_size + 1)
            for paper_id in ranked_ids
        ) / len(ranked_ids)

    return shares, avg_ranks

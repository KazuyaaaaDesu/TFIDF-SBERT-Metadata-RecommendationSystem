"""
Leave-one-out citation qrels.

Ground truth that needs no manual labelling: a paper's own resolved
citation relations are the relevance judgments for a query built from
the paper's text.

For every seed paper with at least ``min_refs`` references that
resolve to *other* papers in the repository:

    query text   = title + abstract + keywords of the seed
    relevant     = resolved references   (paper_citations "cites",
                   grade 2) and resolved citers ("cited_by", grade 1)
    excluded     = the seed and any duplicate of it, which must be
                   removed from the candidate list (the query text
                   would otherwise retrieve the paper itself)

Only ``paper_citations`` rows whose ``matched_paper_id`` points at a
local paper count, so every judgment is a paper a pipeline can
actually return.

Sampling is stratified by publication year and fully determined by
``seed``, so a stored tournament can be re-created.
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.models import Paper, PaperCitation
from app.services.duplicate_detection import (
    _could_be_duplicate,
    _normalize_doi,
    _normalized_title,
    _title_words,
    titles_are_duplicates,
)
from app.services.evaluation.qrels import QUERY_KIND_TEXT, QrelsQuery

DEFAULT_MIN_REFS = 3
GRADE_REFERENCE = 2
GRADE_CITER = 1


@dataclass
class LooQuery:
    seed_paper_id: int
    query: str
    relevance: dict[int, int]
    excluded_ids: frozenset[int] = field(default_factory=frozenset)
    n_refs: int = 0
    year: int | None = None
    title: str = ""

    @property
    def label(self) -> str:
        return f"loo:{self.seed_paper_id}"

    def to_qrels_query(self) -> QrelsQuery:
        """Standard qrels form (drops ``excluded_ids``; callers that
        run pipelines must filter those out of the candidates)."""

        return QrelsQuery(
            kind=QUERY_KIND_TEXT,
            query=self.query,
            relevance=dict(self.relevance),
        )


def seed_query_text(paper: Paper) -> str:
    """Title, abstract and keywords joined into one query string."""

    parts = [paper.title, paper.abstract, paper.keywords]
    text = " ".join(str(part).strip() for part in parts if part)

    return " ".join(text.split())


def duplicate_ids_of(seed: Paper, others: list[Paper]) -> set[int]:
    """Ids of papers that look like the same work as ``seed``.

    Linear in the repository (one comparison per paper), unlike the
    all-pairs grouping in duplicate_detection.
    """

    seed_doi = _normalize_doi(seed.doi)
    seed_title = _normalized_title(seed.title)
    seed_words = _title_words(seed_title)
    found: set[int] = set()

    for other in others:
        if other.id == seed.id:
            continue

        other_doi = _normalize_doi(other.doi)

        if seed_doi and other_doi and seed_doi == other_doi:
            found.add(other.id)
        # The word-overlap screen skips the fuzzy similarity for the
        # overwhelming majority of unrelated titles; without it every
        # seed pays a full comparison against the whole library.
        elif _could_be_duplicate(
            seed_title, seed_words, other.title
        ) and titles_are_duplicates(seed.title, other.title):
            found.add(other.id)

    return found


def _relevance_for(
    rows: list[PaperCitation],
    excluded: set[int],
) -> dict[int, int]:
    relevance: dict[int, int] = {}

    for row in rows:
        target = row.matched_paper_id

        if target is None or target in excluded:
            continue

        grade = GRADE_REFERENCE if row.direction == "cites" else GRADE_CITER
        relevance[target] = max(relevance.get(target, 0), grade)

    return relevance


def build_loo_queries(
    db: Session,
    *,
    n: int | None = None,
    min_refs: int = DEFAULT_MIN_REFS,
    seed: int = 0,
    paper_ids: list[int] | None = None,
) -> list[LooQuery]:
    """
    Build leave-one-out queries, optionally sampling ``n`` of them
    stratified by publication year.

    ``min_refs`` counts distinct resolved *references* (direction
    "cites"), after removing the seed and its duplicates.
    """

    if min_refs < 1:
        raise ValueError("min_refs must be at least 1.")

    if n is not None and n < 1:
        raise ValueError("n must be at least 1.")

    papers = db.query(Paper).order_by(Paper.id).all()
    by_id = {paper.id: paper for paper in papers}

    rows_by_paper: dict[int, list[PaperCitation]] = defaultdict(list)

    for row in (
        db.query(PaperCitation)
        .filter(PaperCitation.matched_paper_id.isnot(None))
        .order_by(PaperCitation.id)
        .all()
    ):
        rows_by_paper[row.paper_id].append(row)

    allowed = set(paper_ids) if paper_ids is not None else None
    queries: list[LooQuery] = []

    for paper_id in sorted(rows_by_paper):
        if allowed is not None and paper_id not in allowed:
            continue

        paper = by_id.get(paper_id)

        if paper is None:
            continue

        text = seed_query_text(paper)

        if not text:
            continue

        excluded = {paper.id} | duplicate_ids_of(paper, papers)
        relevance = _relevance_for(rows_by_paper[paper_id], excluded)
        n_refs = sum(
            1 for grade in relevance.values() if grade == GRADE_REFERENCE
        )

        if n_refs < min_refs:
            continue

        queries.append(
            LooQuery(
                seed_paper_id=paper.id,
                query=text,
                relevance=relevance,
                excluded_ids=frozenset(excluded),
                n_refs=n_refs,
                year=getattr(paper, "publication_year", None),
                title=paper.title or "",
            )
        )

    if n is None or n >= len(queries):
        return queries

    return stratified_sample(queries, n, seed)


def stratified_sample(
    queries: list[LooQuery],
    n: int,
    seed: int,
) -> list[LooQuery]:
    """Round-robin draw across publication years, seeded.

    Each year's queries are shuffled, then years are visited in order
    taking one query at a time until ``n`` are chosen, so no single
    year can dominate. The result is returned in seed-paper-id order.
    """

    rng = random.Random(seed)
    strata: dict[object, list[LooQuery]] = defaultdict(list)

    for query in queries:
        strata[query.year].append(query)

    ordered_keys = sorted(strata, key=lambda key: (key is None, key or 0))

    for key in ordered_keys:
        strata[key].sort(key=lambda q: q.seed_paper_id)
        rng.shuffle(strata[key])

    chosen: list[LooQuery] = []

    while len(chosen) < n and any(strata.values()):
        for key in ordered_keys:
            if strata[key] and len(chosen) < n:
                chosen.append(strata[key].pop())

    return sorted(chosen, key=lambda q: q.seed_paper_id)


def count_eligible(db: Session, min_refs: int = DEFAULT_MIN_REFS) -> int:
    """
    How many papers qualify as queries, in one SQL aggregate.

    A paper qualifies when it has at least ``min_refs`` distinct
    references that resolve to a *different* local paper. This is the
    instant figure for the UI. ``build_loo_queries`` additionally drops
    references that are duplicates of the seed itself and papers with
    no text, so it can come out a little lower -- never higher.
    """

    if min_refs < 1:
        raise ValueError("min_refs must be at least 1.")

    per_paper = (
        db.query(PaperCitation.paper_id)
        .join(Paper, Paper.id == PaperCitation.paper_id)
        .filter(PaperCitation.direction == "cites")
        .filter(PaperCitation.matched_paper_id.isnot(None))
        .filter(PaperCitation.matched_paper_id != PaperCitation.paper_id)
        .filter(Paper.title != "")
        .group_by(PaperCitation.paper_id)
        .having(func.count(func.distinct(PaperCitation.matched_paper_id)) >= min_refs)
    )

    return per_paper.count()

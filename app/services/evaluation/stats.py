"""
Statistical inference for comparing recommendation pipelines.

Pure functions over per-query score vectors, in the style of
``metrics.py``: no database, no I/O, numpy and the standard library
only (scipy is not a project dependency).

A tournament produces a matrix of scores ``scores[pipeline][query]``
(every pipeline scored on the same queries, so the design is paired).
The functions here turn that matrix into a verdict:

    - ``bootstrap_ci``        mean and percentile CI, resampling queries
    - ``paired_bootstrap``    CI for the mean difference of two pipelines
    - ``friedman``            omnibus test across all pipelines
    - ``wilcoxon_signed_rank``  paired test for one pair of pipelines
    - ``holm_adjust``         familywise-error control across pairs
    - ``cliffs_delta``        paired effect size
    - ``required_sample_size``  queries needed for a given power
    - ``bradley_terry``       ratings from pairwise human votes
    - ``rank_with_ties``      winner / tie group / inconclusive verdict
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

import numpy as np

DEFAULT_RESAMPLES = 10_000
DEFAULT_ALPHA = 0.05
DEFAULT_SEED = 20240

# Above this many non-zero pairs the exact Wilcoxon null distribution
# is replaced by the normal approximation.
WILCOXON_EXACT_MAX_N = 50

MIN_QUERIES_FOR_NULL = 10

OUTCOME_WINNER = "winner"
OUTCOME_TIE = "tie"
OUTCOME_INCONCLUSIVE = "inconclusive"


def _as_vector(values: Sequence[float], name: str = "values") -> np.ndarray:
    array = np.asarray(values, dtype=float)

    if array.ndim != 1:
        raise ValueError(f"{name} must be one-dimensional.")

    if array.size and not np.all(np.isfinite(array)):
        raise ValueError(f"{name} must be finite.")

    return array


def _rng(seed: int | None) -> np.random.Generator:
    return np.random.default_rng(DEFAULT_SEED if seed is None else seed)


# ------------------------------------------------------------
# Special functions (chi-square survival, normal CDF)
# ------------------------------------------------------------


def _normal_sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def _gammaincc(a: float, x: float) -> float:
    """Regularised upper incomplete gamma Q(a, x)."""

    if x <= 0:
        return 1.0

    if x < a + 1.0:
        # Series for P(a, x), then complement.
        term = 1.0 / a
        total = term
        n = a

        for _ in range(1000):
            n += 1.0
            term *= x / n
            total += term

            if abs(term) < abs(total) * 1e-15:
                break

        p = total * math.exp(-x + a * math.log(x) - math.lgamma(a))
        return max(0.0, 1.0 - p)

    # Lentz continued fraction for Q(a, x).
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d

    for i in range(1, 1000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        d = tiny if abs(d) < tiny else d
        c = b + an / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        delta = d * c
        h *= delta

        if abs(delta - 1.0) < 1e-15:
            break

    return min(
        1.0,
        math.exp(-x + a * math.log(x) - math.lgamma(a)) * h,
    )


def chi2_sf(x: float, df: int) -> float:
    """Survival function of the chi-square distribution."""

    if df <= 0:
        raise ValueError("df must be positive.")

    return _gammaincc(df / 2.0, x / 2.0)


# ------------------------------------------------------------
# Bootstrap
# ------------------------------------------------------------


def bootstrap_ci(
    values: Sequence[float],
    *,
    confidence: float = 0.95,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int | None = None,
) -> dict:
    """Mean and percentile bootstrap CI, resampling queries."""

    data = _as_vector(values)

    if data.size == 0:
        raise ValueError("values must not be empty.")

    if not 0 < confidence < 1:
        raise ValueError("confidence must be between 0 and 1.")

    mean = float(data.mean())

    if data.size == 1 or float(data.std()) == 0.0:
        return {"mean": mean, "lo": mean, "hi": mean, "n": int(data.size)}

    rng = _rng(seed)
    idx = rng.integers(0, data.size, size=(resamples, data.size))
    means = data[idx].mean(axis=1)
    tail = (1.0 - confidence) / 2.0
    lo, hi = np.quantile(means, [tail, 1.0 - tail])

    return {
        "mean": mean,
        "lo": float(lo),
        "hi": float(hi),
        "n": int(data.size),
    }


def paired_bootstrap(
    a: Sequence[float],
    b: Sequence[float],
    *,
    confidence: float = 0.95,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int | None = None,
) -> dict:
    """Mean difference ``a - b`` with a percentile CI over queries."""

    left = _as_vector(a, "a")
    right = _as_vector(b, "b")

    if left.size != right.size:
        raise ValueError("a and b must have the same length.")

    result = bootstrap_ci(
        left - right,
        confidence=confidence,
        resamples=resamples,
        seed=seed,
    )

    return {
        "mean_diff": result["mean"],
        "lo": result["lo"],
        "hi": result["hi"],
        "n": result["n"],
        "excludes_zero": result["lo"] > 0 or result["hi"] < 0,
    }


# ------------------------------------------------------------
# Rank tests
# ------------------------------------------------------------


def _average_ranks(values: np.ndarray) -> np.ndarray:
    """1-based ranks with ties given their average rank."""

    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(values.size, dtype=float)
    sorted_values = values[order]
    i = 0

    while i < values.size:
        j = i

        while j + 1 < values.size and sorted_values[j + 1] == sorted_values[i]:
            j += 1

        ranks[order[i : j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1

    return ranks


def friedman(scores: Mapping[str, Sequence[float]]) -> dict:
    """
    Friedman omnibus test over ``scores[pipeline][query]``.

    Ties within a query are handled with average ranks and the
    standard tie correction. Returns the statistic, df, p-value and
    each pipeline's mean rank (1 = best).
    """

    names = list(scores)

    if len(names) < 2:
        raise ValueError("Friedman needs at least two pipelines.")

    matrix = np.array(
        [_as_vector(scores[name], name) for name in names]
    ).T  # queries x pipelines

    n, k = matrix.shape

    if n < 2:
        raise ValueError("Friedman needs at least two queries.")

    # Rank so that the best score gets rank 1.
    ranks = np.array([_average_ranks(-row) for row in matrix])
    rank_sums = ranks.sum(axis=0)

    tie_term = 0.0

    for row in matrix:
        _, counts = np.unique(row, return_counts=True)
        tie_term += float(np.sum(counts**3 - counts))

    denominator = n * k * (k + 1) - tie_term / (k - 1)

    if denominator <= 0:
        # Every pipeline tied on every query.
        statistic = 0.0
    else:
        statistic = (
            12.0 * float(np.sum((rank_sums - n * (k + 1) / 2.0) ** 2))
            / (n * k * (k + 1) - tie_term / (k - 1))
        )

    df = k - 1

    return {
        "statistic": statistic,
        "df": df,
        "p_value": chi2_sf(statistic, df),
        "n_queries": n,
        "mean_ranks": {
            name: float(rank_sums[i] / n) for i, name in enumerate(names)
        },
    }


def wilcoxon_signed_rank(
    a: Sequence[float],
    b: Sequence[float],
) -> dict:
    """
    Two-sided paired Wilcoxon signed-rank test.

    Zero differences are dropped. The null distribution is exact
    (dynamic programming over doubled integer ranks, so ties are
    handled exactly) for up to ``WILCOXON_EXACT_MAX_N`` non-zero
    pairs, and a tie-corrected normal approximation beyond that.
    """

    left = _as_vector(a, "a")
    right = _as_vector(b, "b")

    if left.size != right.size:
        raise ValueError("a and b must have the same length.")

    diff = left - right
    diff = diff[diff != 0.0]
    n = int(diff.size)

    if n == 0:
        return {"statistic": 0.0, "p_value": 1.0, "n": 0}

    ranks = _average_ranks(np.abs(diff))
    w_plus = float(ranks[diff > 0].sum())
    total = float(ranks.sum())
    w = min(w_plus, total - w_plus)

    if n <= WILCOXON_EXACT_MAX_N:
        doubled = np.rint(ranks * 2).astype(np.int64)
        size = int(doubled.sum())
        counts = np.zeros(size + 1, dtype=float)
        counts[0] = 1.0

        for r in doubled:
            counts[r:] = counts[r:] + counts[: size + 1 - r].copy()

        counts /= counts.sum()
        cutoff = int(round(w * 2))
        p_value = float(min(1.0, 2.0 * counts[: cutoff + 1].sum()))
    else:
        mean = total / 2.0
        _, tie_counts = np.unique(np.abs(diff), return_counts=True)
        variance = (
            n * (n + 1) * (2 * n + 1) / 24.0
            - float(np.sum(tie_counts**3 - tie_counts)) / 48.0
        )

        if variance <= 0:
            p_value = 1.0
        else:
            z = (abs(w_plus - mean) - 0.5) / math.sqrt(variance)
            p_value = min(1.0, 2.0 * _normal_sf(max(z, 0.0)))

    return {"statistic": w, "p_value": p_value, "n": n}


def holm_adjust(p_values: Sequence[float]) -> list[float]:
    """Holm step-down adjusted p-values, in the input order."""

    m = len(p_values)
    order = sorted(range(m), key=lambda i: p_values[i])
    adjusted = [0.0] * m
    running = 0.0

    for position, index in enumerate(order):
        running = max(running, (m - position) * p_values[index])
        adjusted[index] = min(1.0, running)

    return adjusted


def cliffs_delta(a: Sequence[float], b: Sequence[float]) -> float:
    """
    Cliff's delta between two samples: P(a > b) - P(a < b).

    Ranges over [-1, 1]; |d| < 0.147 is conventionally negligible,
    < 0.33 small, < 0.474 medium.
    """

    left = _as_vector(a, "a")
    right = _as_vector(b, "b")

    if left.size == 0 or right.size == 0:
        raise ValueError("Samples must not be empty.")

    greater = (left[:, None] > right[None, :]).sum()
    less = (left[:, None] < right[None, :]).sum()

    return float((greater - less) / (left.size * right.size))


def paired_dominance(a: Sequence[float], b: Sequence[float]) -> float:
    """
    Paired Cliff's delta: P(a beats b on a query) - P(b beats a), over the
    SAME queries (ties count for neither).

    Cliff's delta between the two score lists treats them as independent
    samples and compares every query of one with every other query of the
    other, so a big gap in query difficulty swamps a small but consistent
    advantage. These pipelines answer the same queries, so the right
    question is "how often is a better than b on a given query?". On real
    data one pipeline that wins on 49% of queries and loses on 25% scored
    an unpaired delta of 0.13 ("negligible") against a paired 0.24
    ("small"). Same Romano thresholds (0.147 / 0.33 / 0.474).
    """

    left = _as_vector(a, "a")
    right = _as_vector(b, "b")

    if left.size != right.size:
        raise ValueError("a and b must have the same length.")

    if left.size == 0:
        raise ValueError("Samples must not be empty.")

    return float((np.sum(left > right) - np.sum(left < right)) / left.size)


def paired_cohens_dz(
    a: Sequence[float], b: Sequence[float]
) -> float | None:
    """Cohen's d_z: mean paired difference over its standard deviation.

    ``None`` when the differences are constant and non-zero (the
    ratio is undefined, and infinity is not valid JSON)."""

    diff = _as_vector(a, "a") - _as_vector(b, "b")

    if diff.size < 2:
        return 0.0

    sd = float(diff.std(ddof=1))

    if sd == 0.0:
        return 0.0 if float(diff.mean()) == 0.0 else None

    return float(diff.mean() / sd)


# ------------------------------------------------------------
# Binary (0/1) metrics: hit rate
# ------------------------------------------------------------
#
# A hit-rate score is 0 or 1 per query. Rank-based tools fit it badly
# (nearly every difference is a tie, and Cliff's delta degenerates into
# the plain difference of the two hit rates, which the usual 0.15 / 0.33 /
# 0.47 labels then call "negligible" for a nine-point gap). The right
# tools are McNemar's exact test for a paired pair of yes/no outcomes,
# and Cohen's h for the size of the difference between two proportions.


def is_binary(values: Sequence[float]) -> bool:
    """True when every value is exactly 0 or 1 (and there is at least one)."""

    data = _as_vector(values)

    return bool(data.size) and bool(np.all((data == 0.0) | (data == 1.0)))


def mcnemar_exact(a: Sequence[float], b: Sequence[float]) -> dict:
    """
    Exact two-sided McNemar test on paired 0/1 outcomes.

    Only the discordant queries carry information: ``a_only`` (a hit,
    b missed) and ``b_only``. Under "no difference" each discordant query
    is equally likely to go either way, so the p-value is the two-sided
    binomial tail of ``min(a_only, b_only)`` out of ``a_only + b_only``
    at probability 1/2.
    """

    left = _as_vector(a, "a")
    right = _as_vector(b, "b")

    if left.size != right.size:
        raise ValueError("a and b must have the same length.")

    a_only = int(np.sum((left == 1.0) & (right == 0.0)))
    b_only = int(np.sum((left == 0.0) & (right == 1.0)))
    n = a_only + b_only

    if n == 0:
        return {"p_value": 1.0, "a_only": 0, "b_only": 0, "n_discordant": 0}

    tail = sum(math.comb(n, k) for k in range(min(a_only, b_only) + 1))

    return {
        # int / int true division stays exact for huge counts; a float
        # product (2.0 * tail) would overflow beyond ~1000 discordant pairs.
        "p_value": min(1.0, (2 * tail) / (2**n)),
        "a_only": a_only,
        "b_only": b_only,
        "n_discordant": n,
    }


def cohens_h(p1: float, p2: float) -> float:
    """Cohen's h: the difference of two proportions on the arcsine scale
    (0.2 small, 0.5 medium, 0.8 large)."""

    p1 = min(1.0, max(0.0, p1))
    p2 = min(1.0, max(0.0, p2))

    return 2.0 * math.asin(math.sqrt(p1)) - 2.0 * math.asin(math.sqrt(p2))


def h_label(h: float) -> str:
    """Cohen's conventions: 0.2 small, 0.5 medium, 0.8 large. Between 0.1
    and 0.2 the effect is real but below "small", so it is called "very
    small", not "negligible": a nine-point hit-rate gap (h about 0.2) must
    not be written off, and two near-identical gaps must not land on
    opposite sides of one cutoff."""

    size = abs(h)

    if size < 0.1:
        return "negligible"
    if size < 0.2:
        return "very small"
    if size < 0.5:
        return "small"
    if size < 0.8:
        return "medium"

    return "large"


def cliffs_label(delta: float) -> str:
    size = abs(delta)

    if size < 0.147:
        return "negligible"
    if size < 0.33:
        return "small"
    if size < 0.474:
        return "medium"

    return "large"


# ------------------------------------------------------------
# Power
# ------------------------------------------------------------


def _normal_ppf(p: float) -> float:
    """Inverse normal CDF (Acklam's rational approximation)."""

    if not 0 < p < 1:
        raise ValueError("p must be in (0, 1).")

    a = [-3.969683028665376e01, 2.209460984245205e02,
         -2.759285104469687e02, 1.383577518672690e02,
         -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02,
         -1.556989798598866e02, 6.680131188771972e01,
         -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01,
         -2.400758277161838e00, -2.549732539343734e00,
         4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01,
         2.445134137142996e00, 3.754408661907416e00]
    low, high = 0.02425, 1 - 0.02425

    if p < low:
        q = math.sqrt(-2 * math.log(p))
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        )

    if p > high:
        return -_normal_ppf(1 - p)

    q = p - 0.5
    r = q * q

    return (
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )


def required_sample_size(
    effect: float,
    sd: float,
    *,
    alpha: float = DEFAULT_ALPHA,
    power: float = 0.8,
) -> int:
    """
    Queries needed to detect a mean paired difference ``effect`` when
    the per-query differences have standard deviation ``sd``
    (two-sided paired z-approximation):

        n = ((z_{1-alpha/2} + z_{power}) * sd / effect) ** 2

    e.g. effect 0.05 with sd 0.2 -> 126 queries.
    """

    if effect <= 0:
        raise ValueError("effect must be positive.")

    if sd < 0:
        raise ValueError("sd must not be negative.")

    if sd == 0:
        return 2

    z = _normal_ppf(1 - alpha / 2) + _normal_ppf(power)

    return max(2, math.ceil((z * sd / effect) ** 2))


# ------------------------------------------------------------
# Bradley-Terry
# ------------------------------------------------------------


def bradley_terry(
    votes: Sequence[tuple[str, str]],
    *,
    iterations: int = 500,
    tolerance: float = 1e-9,
) -> dict[str, float]:
    """
    Maximum-likelihood Bradley-Terry strengths from pairwise votes.

    ``votes`` is a sequence of ``(winner, loser)``. Use ``(a, b)``
    twice with ``(b, a)`` twice style half-votes for ties if needed.
    Strengths are normalised to a geometric mean of 1 (log-ratings
    centred on 0). Uses the standard MM (Zermelo) iteration, with a
    tiny pseudo-count so undefeated or winless items stay finite.
    """

    items = sorted({name for pair in votes for name in pair})

    if not items:
        return {}

    index = {name: i for i, name in enumerate(items)}
    k = len(items)
    wins = np.zeros((k, k))

    for winner, loser in votes:
        if winner == loser:
            raise ValueError("A vote needs two different items.")

        wins[index[winner], index[loser]] += 1.0

    wins += 0.01 * (1 - np.eye(k))  # regularise
    games = wins + wins.T
    strength = np.ones(k)

    for _ in range(iterations):
        denom = (games / (strength[:, None] + strength[None, :])).sum(axis=1)
        updated = wins.sum(axis=1) / denom
        updated /= math.exp(float(np.log(updated).mean()))

        if float(np.max(np.abs(updated - strength))) < tolerance:
            strength = updated
            break

        strength = updated

    return {name: float(strength[index[name]]) for name in items}


def bradley_terry_ci(
    votes: Sequence[tuple[str, str]],
    *,
    confidence: float = 0.95,
    resamples: int = 500,
    seed: int | None = None,
) -> dict[str, dict[str, float]]:
    """Bootstrap (over votes) intervals for Bradley-Terry strengths."""

    point = bradley_terry(votes)

    if not point:
        return {}

    rng = _rng(seed)
    pool = list(votes)
    samples: dict[str, list[float]] = {name: [] for name in point}

    for _ in range(resamples):
        picks = rng.integers(0, len(pool), size=len(pool))
        fitted = bradley_terry([pool[i] for i in picks])

        for name in point:
            if name in fitted:
                samples[name].append(fitted[name])

    tail = (1.0 - confidence) / 2.0
    out = {}

    for name, value in point.items():
        draws = samples[name] or [value]
        lo, hi = np.quantile(draws, [tail, 1.0 - tail])
        out[name] = {"rating": value, "lo": float(lo), "hi": float(hi)}

    return out


# ------------------------------------------------------------
# Verdict
# ------------------------------------------------------------


def rank_with_ties(
    scores: Mapping[str, Sequence[float]],
    *,
    alpha: float = DEFAULT_ALPHA,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int | None = None,
    min_queries: int | None = None,
    min_effect: float = 0.05,
) -> dict:
    """
    Rank pipelines by mean score and decide a verdict.

    1. Friedman omnibus test. Not significant -> everyone is one tie
       group and the outcome is ``tie`` ("no detectable difference").
    2. Otherwise Wilcoxon signed-rank on every pair, Holm-adjusted.
    3. Tie groups: pipelines are chained into a group while the
       better one is not significantly better than the next-ranked
       member. The outcome is ``winner`` only when the top mean is
       significantly better than every other pipeline.
    4. Fewer than ``min_queries`` queries (default: the sample size
       needed to detect ``min_effect`` given the observed spread of
       paired differences) forces ``inconclusive`` unless a winner
       is nevertheless significant after correction -- a significant
       result needs no apology, a null result on a thin sample does.

    Returns the ranking, per-pipeline CIs, the pairwise matrix and
    the verdict. Every number is derived from ``scores`` and ``seed``
    alone, so a stored run can be re-analysed identically.
    """

    names = list(scores)

    if len(names) < 2:
        raise ValueError("A tournament needs at least two pipelines.")

    vectors = {name: _as_vector(scores[name], name) for name in names}
    n = {v.size for v in vectors.values()}

    if len(n) != 1:
        raise ValueError("Every pipeline needs a score for every query.")

    n_queries = n.pop()

    if n_queries < 2:
        return {
            "outcome": OUTCOME_INCONCLUSIVE,
            "reason": "Need at least two queries.",
            "n_queries": n_queries,
            "ranking": [],
            "tie_groups": [],
            "winner": None,
            "omnibus": None,
            "pairwise": [],
            "required_n": None,
        }

    ranking = sorted(names, key=lambda name: -float(vectors[name].mean()))
    intervals = {
        name: bootstrap_ci(vectors[name], resamples=resamples, seed=seed)
        for name in names
    }

    # Hit rate is a 0/1 score per query: it gets the tests built for that
    # (McNemar's exact test, Cohen's h) instead of rank tests and Cliff's
    # delta, whose usual size labels do not mean anything for 0/1 data. The
    # Friedman omnibus needs no change: on binary data with its tie
    # correction it is exactly Cochran's Q.
    binary = all(is_binary(v) for v in vectors.values())

    omnibus = friedman(vectors)

    # All unordered pairs, reported best-first.
    pair_rows = []

    for i, first in enumerate(ranking):
        for second in ranking[i + 1 :]:
            boot = paired_bootstrap(
                vectors[first], vectors[second],
                resamples=resamples, seed=seed,
            )
            # `cliffs_delta` (unpaired) is kept so stored runs and exports
            # stay comparable; the label is read from the paired version.
            delta = cliffs_delta(vectors[first], vectors[second])
            paired = paired_dominance(vectors[first], vectors[second])
            row = {
                "a": first,
                "b": second,
                "mean_diff": boot["mean_diff"],
                "lo": boot["lo"],
                "hi": boot["hi"],
                "cliffs_delta": delta,
                "paired_delta": paired,
                "cohens_dz": paired_cohens_dz(vectors[first], vectors[second]),
            }

            if binary:
                test = mcnemar_exact(vectors[first], vectors[second])
                h = cohens_h(
                    float(vectors[first].mean()), float(vectors[second].mean())
                )
                row.update(
                    test="mcnemar",
                    p_value=test["p_value"],
                    a_only=test["a_only"],
                    b_only=test["b_only"],
                    cohens_h=h,
                    effect_size=h,
                    effect_kind="h",
                    effect_label=h_label(h),
                )
            else:
                test = wilcoxon_signed_rank(vectors[first], vectors[second])
                row.update(
                    test="wilcoxon",
                    p_value=test["p_value"],
                    effect_size=paired,
                    effect_kind="delta",
                    effect_label=cliffs_label(paired),
                )

            pair_rows.append(row)

    adjusted = holm_adjust([row["p_value"] for row in pair_rows])

    for row, adj in zip(pair_rows, adjusted):
        row["p_adjusted"] = adj
        row["significant"] = bool(adj < alpha)

    def significant(first: str, second: str) -> bool:
        for row in pair_rows:
            if (row["a"], row["b"]) == (first, second):
                return row["significant"] and row["mean_diff"] > 0

        return False

    omnibus_significant = omnibus["p_value"] < alpha

    # Tie groups, scanning down the ranking.
    groups: list[list[str]] = []

    if not omnibus_significant:
        groups = [list(ranking)]
    else:
        current = [ranking[0]]

        for name in ranking[1:]:
            if significant(current[0], name):
                groups.append(current)
                current = [name]
            else:
                current.append(name)

        groups.append(current)

    top_group = groups[0]
    leader = ranking[0]
    beats_all = omnibus_significant and all(
        significant(leader, other) for other in ranking[1:]
    )

    # Power / sample size from the observed spread of the closest
    # pair of differences (leader vs runner-up).
    lead_diff = vectors[ranking[0]] - vectors[ranking[1]]
    sd = float(lead_diff.std(ddof=1)) if n_queries > 1 else 0.0
    required_n = required_sample_size(min_effect, sd)
    # The smallest gap between the top two this many queries can reliably
    # detect at the observed spread (80% power, alpha 0.05): the honest
    # statement of what a null result rules out.
    detectable = (
        (_normal_ppf(1 - alpha / 2) + _normal_ppf(0.8)) * sd / math.sqrt(n_queries)
        if n_queries > 0
        else None
    )
    # The observed spread of a handful of queries is itself noisy, so
    # a hard floor stops a lucky-small SD from certifying a null.
    needed = (
        min_queries
        if min_queries is not None
        else max(required_n, MIN_QUERIES_FOR_NULL)
    )

    if beats_all:
        outcome = OUTCOME_WINNER
        winner = leader
        reason = "Top mean is significantly better than every other pipeline."
    elif n_queries < needed:
        outcome = OUTCOME_INCONCLUSIVE
        winner = None
        reason = (
            f"{n_queries} queries is below the {needed} needed to detect "
            f"a {min_effect:g} difference."
        )
    else:
        outcome = OUTCOME_TIE
        winner = None
        reason = (
            "No detectable difference between the pipelines."
            if not omnibus_significant
            else "The top pipelines are not statistically separable."
        )

    return {
        "outcome": outcome,
        "reason": reason,
        "winner": winner,
        "n_queries": n_queries,
        "alpha": alpha,
        "ranking": [
            {"pipeline": name, **intervals[name]} for name in ranking
        ],
        "tie_groups": groups,
        "top_group": top_group,
        "omnibus": omnibus,
        "binary": binary,
        "pairwise_test": "McNemar exact" if binary else "Wilcoxon signed-rank",
        "pairwise": pair_rows,
        "required_n": required_n,
        "detectable_gap": detectable,
        "min_effect": min_effect,
        "seed": DEFAULT_SEED if seed is None else seed,
        "resamples": resamples,
    }

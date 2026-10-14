/**
 * TOURNAMENT DEFAULTS PER METRIC
 *
 * Each metric is a different kind of number, and the number of queries
 * needed to tell two pipelines apart depends on how much it varies from
 * query to query:
 *
 *   nDCG@k    graded, fairly smooth                 SD of paired gaps ~ 0.20
 *   MRR@k     one reciprocal rank: lumpy            ~ 0.30
 *   Recall@20 a share of the relevant set           ~ 0.25
 *   Hit@k     0 or 1 per query: the noisiest        ~ 0.45
 *
 * The queries needed to detect a mean gap of 0.05 at 80% power (two-sided
 * alpha 0.05) is n = ((z_{1-a/2} + z_{power}) * sd / gap)^2, the same
 * formula as stats.required_sample_size on the server (nDCG: 126).
 *
 * `recommendedSettings` turns that into the three settings a run needs.
 * These are starting minimums, not guarantees: the verdict itself uses the
 * observed spread.
 */

export type MetricId = "ndcg" | "mrr" | "recall" | "hit";

/** z for two-sided alpha 0.05 plus z for 80% power. */
const Z_SUM = 1.959964 + 0.841621;

/** The server's per-run limit on queries (see tournament.MAX_QUERIES). */
export const MAX_QUERIES = 5000;

/** The gap the recommendation is sized to detect. */
export const TARGET_GAP = 0.05;

export interface MetricProfile {
  label: string;
  /** Typical SD of the per-query paired differences. */
  sd: number;
  /** Top-k to score at; fixed metrics ignore the box. */
  topK: number;
  /** Recall is always measured at 20, whatever Top-k says. */
  topKFixed: boolean;
  /** Minimum resolved references for a paper to be a query. */
  minRefs: number;
  why: string;
}

export const METRIC_PROFILE: Record<MetricId, MetricProfile> = {
  ndcg: {
    label: "nDCG@k",
    sd: 0.2,
    topK: 10,
    topKFixed: false,
    minRefs: 3,
    why: "Graded and smooth, so it needs the fewest queries.",
  },
  mrr: {
    label: "MRR@k",
    sd: 0.3,
    topK: 10,
    topKFixed: false,
    minRefs: 3,
    why: "Only the first relevant hit counts, so scores are lumpy and need more queries.",
  },
  recall: {
    label: "Recall@20",
    sd: 0.25,
    topK: 20,
    topKFixed: true,
    minRefs: 5,
    why: "Always measured at 20. Needs 5+ references per query, or recall jumps in coarse steps.",
  },
  hit: {
    label: "Hit@k",
    sd: 0.45,
    topK: 10,
    topKFixed: false,
    minRefs: 3,
    why: "A 0/1 score per query is the noisiest: a 0.05 gap needs far more queries than one run allows.",
  },
};

/** Queries needed to detect `gap` given per-query SD `sd`. */
export function requiredQueries(sd: number, gap: number = TARGET_GAP): number {
  if (gap <= 0 || sd <= 0) return 2;
  return Math.max(2, Math.ceil((Z_SUM * sd / gap) ** 2));
}

/** The smallest mean gap `queries` queries can reliably detect. */
export function detectableGap(sd: number, queries: number): number {
  return (Z_SUM * sd) / Math.sqrt(Math.max(1, queries));
}

export interface Recommendation {
  queries: number;
  topK: number;
  minRefs: number;
  /** Queries a full-power run would want (may exceed MAX_QUERIES). */
  required: number;
  /** What `queries` can detect (smaller is better). */
  gap: number;
  /** True when `required` could not be met (server cap or too few papers). */
  short: boolean;
  /** Why it is short, in a sentence; empty when it is not. */
  shortReason: string;
}

/**
 * Settings to start from for `metric`. `available` is how many papers can
 * act as queries right now (null while unknown).
 */
export function recommendedSettings(
  metric: MetricId,
  available: number | null,
): Recommendation {
  const profile = METRIC_PROFILE[metric];
  const required = requiredQueries(profile.sd);
  const ceiling = Math.min(MAX_QUERIES, available ?? MAX_QUERIES);
  const queries = Math.max(2, Math.min(required, ceiling));
  const short = queries < required;

  let shortReason = "";
  if (short) {
    shortReason =
      available != null && available < Math.min(required, MAX_QUERIES)
        ? `only ${available} papers qualify as queries`
        : `one run is capped at ${MAX_QUERIES} queries`;
  }

  return {
    queries,
    topK: profile.topK,
    minRefs: profile.minRefs,
    required,
    gap: detectableGap(profile.sd, queries),
    short,
    shortReason,
  };
}

/** One line for the UI: what is recommended, and what it can detect. */
export function describeRecommendation(
  metric: MetricId,
  rec: Recommendation,
): string {
  const p = METRIC_PROFILE[metric];
  const base = `${p.label}: ${rec.queries} queries${
    p.topKFixed ? "" : `, top-${rec.topK}`
  }, min refs ${rec.minRefs}`;

  return rec.short
    ? `${base}. ${rec.required} would detect a ${TARGET_GAP} gap, but ${rec.shortReason}; this run detects gaps of about ${rec.gap.toFixed(2)} or more.`
    : `${base}. Enough to detect a ${TARGET_GAP} gap (typical SD ${p.sd}).`;
}


/** Seconds one query costs per pipeline (measured: ~2.4 s for six). */
export const SECONDS_PER_PIPELINE_QUERY = 0.4;

/** Rough wall-clock estimate for a run, as words ("about 8 min"). */
export function estimateRuntime(queries: number, pipelines: number): string {
  const seconds = Math.max(1, queries * pipelines * SECONDS_PER_PIPELINE_QUERY);
  if (seconds < 90) return `about ${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `about ${Math.round(minutes)} min`;
  return `about ${(minutes / 60).toFixed(1)} h`;
}

/**
 * TOURNAMENT INTERPRETATION
 *
 * Reads a finished tournament's tables (leaderboard, pairwise tests,
 * secondary metrics) and writes up what they say, in the style the reader
 * needs: plain language, a thesis results paragraph, full technical detail,
 * an executive summary, the caveats, or just the tables with a reading
 * guide under each.
 *
 * Everything is derived from the numbers by fixed rules. There is no model
 * in the loop, so nothing can be invented: every figure in the text is a
 * figure in the result, and a claim is only made when the test supports it.
 * The output is Markdown (tables included), so it can be copied or saved
 * as-is, or rendered for pasting into a document.
 */

import type { TournamentMetric, TournamentResult } from "../api";

export type InterpretationStyle =
  | "plain"
  | "thesis"
  | "technical"
  | "executive"
  | "caveats"
  | "tables";

export const INTERPRETATION_STYLES: {
  id: InterpretationStyle;
  label: string;
  blurb: string;
}[] = [
  { id: "plain", label: "Plain language", blurb: "No jargon: who won, how sure, what to do." },
  { id: "thesis", label: "Thesis results", blurb: "A results paragraph with the statistics in APA form." },
  { id: "technical", label: "Technical", blurb: "Every test, number and setting, for reproducing the run." },
  { id: "executive", label: "Executive", blurb: "The decision in a few bullets." },
  { id: "caveats", label: "Caveats", blurb: "What limits how far the result can be trusted." },
  { id: "tables", label: "Tables", blurb: "The tables, each with a note on how to read it." },
];

type NameOf = (pipelineId: string) => string;

const METRIC_NAMES: Record<TournamentMetric, string> = {
  ndcg: "nDCG",
  mrr: "MRR",
  recall: "Recall",
  hit: "Hit rate",
};

// ---------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------

const f = (value: number, digits = 3) => value.toFixed(digits);

/** APA style: no leading zero, "p < .001". */
const apaP = (p: number) =>
  p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`;

const plainP = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

const apaNum = (value: number, digits = 2) =>
  value.toFixed(digits).replace(/^(-?)0\./, "$1.");

const signed = (value: number, digits = 3) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Percentage points, one decimal ("+9.3 pp"). */
const pp = (value: number) => `${signed(value * 100, 1)} pp`;

type Pair = TournamentResult["verdict"]["pairwise"][number];

/** The size label for a pair: the server's, else derived from Cliff's delta. */
function pairEffect(p: Pair): string {
  return p.effect_label ?? effectLabel(p.paired_delta ?? p.cliffs_delta);
}

/** The delta the label was read from: paired when the run has it. */
function deltaValue(p: Pair): number {
  return p.effect_kind === "h"
    ? (p.effect_size ?? p.cohens_h ?? 0)
    : (p.effect_size ?? p.paired_delta ?? p.cliffs_delta);
}

const deltaName = (p: Pair) =>
  p.paired_delta !== undefined || p.effect_kind === "delta"
    ? "paired Cliff's \u03b4"
    : "Cliff's \u03b4";

/** "Cohen's h = .20" or "Cliff's \u03b4 = .45" (APA drops the leading zero). */
function effectStat(p: Pair, apa: boolean): string {
  const h = p.effect_kind === "h";
  const value = deltaValue(p);
  return `${h ? "Cohen's h" : deltaName(p)} = ${apa ? apaNum(value) : f(value, 2)}`;
}

function effectLabel(delta: number): string {
  const d = Math.abs(delta);
  if (d < 0.147) return "negligible";
  if (d < 0.33) return "small";
  if (d < 0.474) return "medium";
  return "large";
}

function listOf(items: string[], conj = "and"): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conj} ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------
// Facts shared by every style
// ---------------------------------------------------------------

interface Facts {
  r: TournamentResult;
  name: NameOf;
  metric: string; // "nDCG@10"
  metricShort: string; // "nDCG"
  k: number;
  alpha: number;
  nQueries: number;
  dropped: number;
  outcome: "winner" | "tie" | "inconclusive";
  ranking: TournamentResult["verdict"]["ranking"];
  leader: TournamentResult["verdict"]["ranking"][number];
  runner: TournamentResult["verdict"]["ranking"][number] | undefined;
  omnibusP: number | null;
  omnibusSig: boolean;
  pairs: TournamentResult["verdict"]["pairwise"];
  topGroup: string[];
  groups: string[][];
  leaderVsRunner: TournamentResult["verdict"]["pairwise"][number] | undefined;
  beatenByLeader: string[];
  minEffect: number;
  /** 0/1 metric (hit rate): McNemar's exact test, Cohen's h, percentage points. */
  binary: boolean;
  testName: string;
  requiredN: number | null;
  /** Smallest top-two gap this run could reliably detect (null if unknown). */
  detectableGap: number | null;
  underpowered: boolean;
  /** Other metrics: where the leader stands. */
  agreement: { metric: string; leaderFirst: boolean; first: string }[];
}

function pairFor(
  pairs: Facts["pairs"],
  a: string,
  b: string,
): Facts["pairs"][number] | undefined {
  return pairs.find((p) => p.a === a && p.b === b);
}

function analyse(r: TournamentResult, name: NameOf): Facts {
  const v = r.verdict;
  const ranking = v.ranking;
  const leader = ranking[0];
  const runner = ranking[1];
  const metricShort = METRIC_NAMES[r.primary_metric] ?? r.primary_metric;
  const metric =
    r.primary_metric === "recall" ? "Recall@20" : `${metricShort}@${r.top_k}`;
  const alpha = v.alpha ?? 0.05;
  const omnibusP = v.omnibus ? v.omnibus.p_value : null;
  const beatenByLeader = v.pairwise
    .filter((p) => p.a === leader?.pipeline && p.significant && p.mean_diff > 0)
    .map((p) => p.b);

  const agreement: Facts["agreement"] = Object.entries(r.secondary).map(
    ([key, byPipeline]) => {
      const ordered = Object.entries(byPipeline).sort(
        (a, b) => b[1].mean - a[1].mean,
      );
      const label =
        key === "recall"
          ? "Recall@20"
          : `${METRIC_NAMES[key as TournamentMetric] ?? key}@${r.top_k}`;
      return {
        metric: label,
        leaderFirst: ordered[0]?.[0] === leader?.pipeline,
        first: ordered[0]?.[0] ?? "",
      };
    },
  );

  return {
    r,
    name,
    metric,
    metricShort,
    k: r.top_k,
    alpha,
    nQueries: r.n_queries,
    dropped: r.dropped.length,
    outcome: v.outcome,
    ranking,
    leader,
    runner,
    omnibusP,
    omnibusSig: omnibusP != null && omnibusP < alpha,
    pairs: v.pairwise,
    topGroup: v.top_group ?? [],
    groups: v.tie_groups,
    leaderVsRunner: runner ? pairFor(v.pairwise, leader.pipeline, runner.pipeline) : undefined,
    beatenByLeader,
    minEffect: v.min_effect ?? 0.05,
    binary: v.binary === true || v.pairwise.some((p) => p.test === "mcnemar"),
    testName:
      v.pairwise_test ??
      (v.pairwise.some((p) => p.test === "mcnemar")
        ? "McNemar exact"
        : "Wilcoxon signed-rank"),
    requiredN: v.required_n,
    detectableGap: v.detectable_gap ?? null,
    underpowered: v.required_n != null && r.n_queries < v.required_n,
    agreement,
  };
}

// ---------------------------------------------------------------
// Tables (Markdown)
// ---------------------------------------------------------------

function groupLabel(facts: Facts, id: string): string {
  const index = facts.groups.findIndex((g) => g.includes(id));
  const tied = index >= 0 && facts.groups[index].length > 1;
  return tied ? `G${index + 1}` : "—";
}

function leaderboardTable(x: Facts): string {
  const rows = x.ranking.map(
    (row, i) =>
      `| ${i + 1} | ${x.name(row.pipeline)} | ${f(row.mean)} | [${f(row.lo)}, ${f(row.hi)}] | ${groupLabel(x, row.pipeline)} |`,
  );
  return [
    `| Rank | Pipeline | Mean ${x.metric} | 95% CI | Group |`,
    "|--:|:--|--:|:-:|:-:|",
    ...rows,
  ].join("\n");
}

function pairwiseTable(x: Facts): string {
  if (x.binary) {
    const rows = x.pairs.map(
      (p) =>
        `| ${x.name(p.a)} vs ${x.name(p.b)} | ${pp(p.mean_diff)} | [${pp(p.lo)}, ${pp(p.hi)}] | ${p.a_only ?? "\u2014"} / ${p.b_only ?? "\u2014"} | ${f(p.p_adjusted)} | ${signed(p.effect_size ?? p.cohens_h ?? 0, 2)} (${pairEffect(p)}) | ${p.significant ? "yes" : "no"} |`,
    );
    return [
      `| Comparison | \u0394 hit rate | 95% CI of \u0394 | Only first / only second hit | Holm p | Cohen's h | Significant |`,
      "|:--|--:|:-:|:-:|--:|:-:|:-:|",
      ...rows,
    ].join("\n");
  }

  const rows = x.pairs.map(
    (p) =>
      `| ${x.name(p.a)} vs ${x.name(p.b)} | ${signed(p.mean_diff)} | [${signed(p.lo)}, ${signed(p.hi)}] | ${f(p.p_adjusted)} | ${signed(deltaValue(p), 2)} (${pairEffect(p)}) | ${p.significant ? "yes" : "no"} |`,
  );
  const paired = x.pairs.some((p) => p.paired_delta !== undefined);
  return [
    `| Comparison | \u0394 mean | 95% CI of \u0394 | Holm p | ${paired ? "Paired \u03b4" : "Cliff's \u03b4"} | Significant |`,
    "|:--|--:|:-:|--:|:-:|:-:|",
    ...rows,
  ].join("\n");
}

function metricsTable(x: Facts): string | null {
  const keys = Object.keys(x.r.secondary);
  if (!keys.length) return null;
  const labels = keys.map((key) =>
    key === "recall"
      ? "Recall@20"
      : `${METRIC_NAMES[key as TournamentMetric] ?? key}@${x.k}`,
  );
  const rows = x.ranking.map((row) => {
    const cells = keys.map((key) => {
      const cell = x.r.secondary[key]?.[row.pipeline];
      return cell ? `${f(cell.mean)} [${f(cell.lo)}, ${f(cell.hi)}]` : "—";
    });
    return `| ${x.name(row.pipeline)} | ${cells.join(" | ")} |`;
  });
  return [
    `| Pipeline | ${labels.join(" | ")} |`,
    `|:--|${labels.map(() => "--:|").join("")}`,
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------
// Sentences shared across styles
// ---------------------------------------------------------------

/** The headline finding, one sentence. */
function headline(x: Facts): string {
  const lead = x.name(x.leader.pipeline);

  if (x.outcome === "winner") {
    return `${lead} is the best pipeline on ${x.metric}: it scores higher than every other pipeline, and the differences are statistically reliable.`;
  }

  if (x.outcome === "tie") {
    return x.topGroup.length > 1
      ? `No single pipeline is demonstrably best on ${x.metric}. ${listOf(x.topGroup.map(x.name))} lead, but the data cannot tell them apart.`
      : `No pipeline is demonstrably better than the others on ${x.metric}.`;
  }

  return `This tournament cannot say which pipeline is best on ${x.metric}: ${x.nQueries} queries is too few to tell the pipelines apart.`;
}

/** How the leader compares to the runner-up, with the test behind it. */
function leaderGap(x: Facts, apa: boolean): string | null {
  const p = x.leaderVsRunner;
  if (!p || !x.runner) return null;
  const fp = apa ? apaP(p.p_adjusted) : plainP(p.p_adjusted);
  const lead = x.name(x.leader.pipeline);
  const other = x.name(x.runner.pipeline);

  if (x.binary) {
    const diff = `${f(Math.abs(p.mean_diff) * 100, 1)} percentage points`;
    const ci = `[${signed(p.lo * 100, 1)}, ${signed(p.hi * 100, 1)}] pp`;
    return `${lead} leads ${other} by ${diff} of hit rate (95% CI of the difference ${ci}; Holm-adjusted ${fp}, McNemar exact), a ${pairEffect(p)} effect (${effectStat(p, apa)}). ${lead} alone hit on ${p.a_only ?? 0} queries and ${other} alone on ${p.b_only ?? 0}.`;
  }

  const diff = apa ? apaNum(Math.abs(p.mean_diff), 3) : f(Math.abs(p.mean_diff));
  const ci = apa
    ? `[${apaNum(p.lo, 3)}, ${apaNum(p.hi, 3)}]`
    : `[${f(p.lo)}, ${f(p.hi)}]`;

  return `${lead} leads ${other} by ${diff} ${x.metricShort} (95% CI of the difference ${ci}; Holm-adjusted ${fp}), a ${pairEffect(p)} effect (${effectStat(p, apa)}).`;
}

/** The same comparison with no statistics vocabulary, for plain language. */
function simpleGap(x: Facts): string | null {
  const p = x.leaderVsRunner;
  if (!p || !x.runner) return null;
  const lead = x.name(x.leader.pipeline);
  const other = x.name(x.runner.pipeline);
  const reliable = p.significant
    ? "statistically reliable"
    : "not reliable enough to rule out chance";

  if (x.binary) {
    return `${lead} finds a relevant paper in the top ${x.k} for ${pct(x.leader.mean)} of queries, against ${pct(x.runner.mean)} for ${other}: a ${pairEffect(p)} difference that is ${reliable}.`;
  }

  return `${lead} scores ${f(Math.abs(p.mean_diff))} higher than ${other}: a ${pairEffect(p)} difference that is ${reliable}.`;
}

/** Is the gap big enough to matter, not just to be detectable? */
function practical(x: Facts): string | null {
  const p = x.leaderVsRunner;
  if (!p || !p.significant) return null;
  const gap = Math.abs(p.mean_diff);
  const shown = x.binary ? `${f(gap * 100, 1)} percentage points` : f(gap);
  const bar = x.binary ? `${f(x.minEffect * 100, 0)} points` : `${x.minEffect}`;

  return gap >= x.minEffect
    ? `The gap of ${shown} is at or above the ${bar} difference this tournament was sized to detect, so it is large enough to matter in practice.`
    : `The gap of ${shown} is statistically reliable but below ${bar}, so it is small in practical terms.`;
}

function agreementNote(x: Facts): string | null {
  if (!x.agreement.length) return null;
  const disagree = x.agreement.filter((a) => !a.leaderFirst);

  if (!disagree.length) {
    return `${x.name(x.leader.pipeline)} also scores highest on ${listOf(x.agreement.map((a) => a.metric))}, so the other measures agree with the verdict.`;
  }

  // "X is ahead on A, B and C" once per pipeline, not once per metric.
  const byLeader = new Map<string, string[]>();
  for (const a of disagree) {
    byLeader.set(a.first, [...(byLeader.get(a.first) ?? []), a.metric]);
  }

  return `The other measures do not all agree: ${listOf(
    [...byLeader].map(
      ([first, metrics]) => `${x.name(first)} is ahead on ${listOf(metrics)}`,
    ),
  )}. Treat the result as specific to ${x.metric}.`;
}

/** What a null result rules out: the smallest top-two gap this run could see. */
function gapNote(x: Facts): string {
  if (x.detectableGap == null) return "";
  const gap = x.binary
    ? `${f(x.detectableGap * 100, 1)} percentage points`
    : f(x.detectableGap, 3);
  return `At the observed spread this run could reliably detect a gap of about ${gap} or more between the top two pipelines (80% power); a smaller real difference would be below what it can resolve.`;
}

function powerNote(x: Facts): string {
  if (x.requiredN == null) return "";
  const base = x.underpowered
    ? `With ${x.nQueries} queries (about ${x.requiredN} are needed to detect a ${x.minEffect} difference at the observed spread), small real differences could be missed.`
    : `${x.nQueries} queries is enough to detect a ${x.minEffect} difference at the observed spread (about ${x.requiredN} needed).`;
  return `${base} ${gapNote(x)}`.trim();
}

function nextStep(x: Facts): string {
  if (x.outcome === "winner") {
    return x.underpowered
      ? `Use ${x.name(x.leader.pipeline)}, and repeat with another seed to confirm.`
      : `Use ${x.name(x.leader.pipeline)}.`;
  }
  if (x.outcome === "tie") {
    return "Treat the top group as equivalent and choose on other grounds (speed, simplicity). More queries would only help if a small difference matters.";
  }
  return `Run again with at least ${x.requiredN ?? "more"} queries (gather more literature to unlock them).`;
}

// ---------------------------------------------------------------
// Styles
// ---------------------------------------------------------------

function plain(x: Facts): string {
  const lines: string[] = [`## What this tournament found`, "", headline(x), ""];

  lines.push(
    `**How it was tested.** ${x.nQueries} papers were used as test questions. For each one, the pipelines tried to find the papers it actually cites, and were scored on ${x.metric} (higher is better).`,
    "",
  );

  lines.push(`**How the pipelines rank.**`, "");
  x.ranking.forEach((row, i) =>
    lines.push(`${i + 1}. ${x.name(row.pipeline)}: ${f(row.mean, 2)}`),
  );
  lines.push("");

  const gap = simpleGap(x);
  if (gap && x.outcome !== "inconclusive") lines.push(`**Top two.** ${gap}`, "");

  if (x.outcome === "tie" && x.topGroup.length > 1) {
    lines.push(
      `**Why no winner.** ${listOf(x.topGroup.map(x.name))} score so close together that the difference could easily be chance.`,
      "",
    );
  }

  const meaning = practical(x);
  if (meaning) lines.push(`**Does it matter?** ${meaning}`, "");

  const agree = agreementNote(x);
  if (agree) lines.push(`**Other measures.** ${agree}`, "");

  lines.push(`**What to do.** ${nextStep(x)}`);
  return lines.join("\n");
}

function thesis(x: Facts): string {
  const v = x.r.verdict;
  const lines: string[] = ["## Results", ""];

  const intro = `A leave-one-out citation tournament compared ${x.ranking.length} recommendation pipelines on ${x.nQueries} query papers${x.dropped ? ` (${x.dropped} further ${x.dropped === 1 ? "query was dropped because it" : "queries were dropped because they"} could not be scored)` : ""}. Each query was a paper's title, abstract and keywords, and its resolved references and citers served as the relevant set. The primary metric, ${x.metric}, was fixed before the run. Means are reported with 95% percentile bootstrap confidence intervals over queries (${v.resamples ?? "—"} resamples, seed ${x.r.seed}).`;
  lines.push(intro, "");

  const omni = v.omnibus
    ? `${x.binary ? "A Friedman test on the binary hit outcomes (equivalent to Cochran's Q)" : "A Friedman test"} ${x.omnibusSig ? "indicated" : "did not indicate"} a difference among the pipelines, χ²(${v.omnibus.df}, N = ${v.omnibus.n_queries}) = ${apaNum(v.omnibus.statistic)}, ${apaP(v.omnibus.p_value)}.`
    : "";

  const top = `${x.name(x.leader.pipeline)} obtained the highest mean ${x.metric} (M = ${apaNum(x.leader.mean, 3)}, 95% CI [${apaNum(x.leader.lo, 3)}, ${apaNum(x.leader.hi, 3)}])${x.runner ? `, followed by ${x.name(x.runner.pipeline)} (M = ${apaNum(x.runner.mean, 3)}, 95% CI [${apaNum(x.runner.lo, 3)}, ${apaNum(x.runner.hi, 3)}])` : ""}.`;
  lines.push([omni, top].filter(Boolean).join(" "), "");

  if (x.omnibusSig) {
    const gap = leaderGap(x, true);
    const sigCount = x.pairs.filter((p) => p.significant).length;
    lines.push(
      `Post hoc ${x.binary ? "McNemar exact tests on paired hit/miss outcomes" : "paired Wilcoxon signed-rank tests"} with Holm correction found ${sigCount} of ${x.pairs.length} pairwise differences significant at α = ${apaNum(x.alpha)}. ${gap ?? ""}`.trim(),
      "",
    );
  }

  if (x.outcome === "winner") {
    lines.push(
      `${x.name(x.leader.pipeline)} outperformed every other pipeline (${listOf(x.beatenByLeader.map(x.name))}), and is therefore reported as the best pipeline on ${x.metric}.`,
      "",
    );
  } else if (x.outcome === "tie") {
    lines.push(
      `No pipeline was significantly better than every other. The pipelines ${listOf(x.topGroup.map(x.name))} could not be separated after correction, so no single best pipeline is claimed.`,
      "",
    );
  } else {
    lines.push(
      `The result is inconclusive: ${powerNote(x) || "too few queries could be scored to separate the pipelines."}`,
      "",
    );
  }

  const agree = agreementNote(x);
  if (agree) lines.push(agree, "");

  lines.push("**Table 1.** Mean " + `${x.metric} by pipeline with 95% bootstrap confidence intervals.`, "", leaderboardTable(x), "");
  lines.push(
    x.binary
      ? "**Table 2.** Pairwise comparisons (McNemar exact test on paired hit/miss outcomes, Holm-adjusted p; Cohen's h effect size; differences in percentage points)."
      : `**Table 2.** Pairwise comparisons (paired Wilcoxon signed-rank, Holm-adjusted p; ${x.pairs.some((p) => p.paired_delta !== undefined) ? "paired Cliff's δ" : "Cliff's δ"} effect size).`,
    "",
    pairwiseTable(x),
  );

  return lines.join("\n");
}

function technical(x: Facts): string {
  const v = x.r.verdict;
  const lines: string[] = [
    "## Technical summary",
    "",
    "**Settings**",
    "",
    `- Design: leave-one-out citation retrieval; query = a paper's title + abstract + keywords; relevance = resolved references (grade 2) and citers (grade 1); the seed paper and its duplicates are excluded.`,
    `- Queries scored: ${x.nQueries}${x.dropped ? ` (${x.dropped} dropped)` : ""}; min refs ${x.r.min_refs}; top-k ${x.k}.`,
    `- Primary metric: ${x.metric} (pre-declared). Secondary: ${x.agreement.map((a) => a.metric).join(", ") || "none"}.`,
    `- Pipelines (${x.ranking.length}): ${x.ranking.map((r) => x.name(r.pipeline)).join(", ")}.`,
    `- Inference: percentile bootstrap over queries (${v.resamples ?? "—"} resamples, seed ${x.r.seed}); α = ${x.alpha}.`,
    "",
    "**Omnibus**",
    "",
  ];

  if (v.omnibus) {
    lines.push(
      `- Friedman${x.binary ? " (on 0/1 outcomes: Cochran's Q)" : ""} χ²(${v.omnibus.df}) = ${f(v.omnibus.statistic, 3)}, ${plainP(v.omnibus.p_value)}, n = ${v.omnibus.n_queries}: ${x.omnibusSig ? "reject the null of no difference" : "no detectable difference"}.`,
      `- Mean ranks (1 = best): ${Object.entries(v.omnibus.mean_ranks)
        .sort((a, b) => a[1] - b[1])
        .map(([id, rank]) => `${x.name(id)} ${f(rank, 2)}`)
        .join("; ")}.`,
    );
  } else {
    lines.push("- Not computed.");
  }

  lines.push(
    "",
    x.binary
      ? "**Pairwise** (exact two-sided McNemar test on paired hit/miss outcomes, Holm-adjusted across all pairs; effect size Cohen's h)"
      : "**Pairwise** (two-sided Wilcoxon signed-rank on paired per-query scores, Holm-adjusted across all pairs)",
    "",
    pairwiseTable(x),
    "",
    `- Significant pairs: ${x.pairs.filter((p) => p.significant).length} of ${x.pairs.length}.`,
    `- Tie groups (best first): ${x.groups.map((g) => `{${g.map(x.name).join(", ")}}`).join(" > ")}.`,
    `- Verdict: **${x.outcome}**${v.winner ? ` (${x.name(v.winner)})` : ""}. ${v.reason}`,
    "",
    "**Leaderboard**",
    "",
    leaderboardTable(x),
  );

  const metrics = metricsTable(x);
  if (metrics) lines.push("", "**Secondary metrics**", "", metrics);

  lines.push(
    "",
    "**Power**",
    "",
    `- Observed spread of the leader–runner-up differences implies ${x.requiredN ?? "—"} queries to detect ${x.minEffect}; used ${x.nQueries} (${x.underpowered ? "below" : "meets"} that).`,
  );

  return lines.join("\n");
}

function executive(x: Facts): string {
  const lines: string[] = ["## Summary", ""];
  lines.push(`- **Result:** ${headline(x)}`);

  if (x.outcome !== "inconclusive" && x.leaderVsRunner) {
    lines.push(
      `- **Margin:** ${x.name(x.leader.pipeline)} ${f(x.leader.mean, 2)} vs ${x.runner ? `${x.name(x.runner.pipeline)} ${f(x.runner.mean, 2)}` : "—"} on ${x.metric}${x.leaderVsRunner.significant ? " (reliable)" : " (not reliable)"}.`,
    );
  }

  lines.push(`- **Confidence:** ${confidence(x)}`);
  lines.push(`- **Recommendation:** ${nextStep(x)}`);
  return lines.join("\n");
}

function confidence(x: Facts): string {
  if (x.outcome === "inconclusive") return "Low: too little data.";
  if (x.outcome === "tie") return "Moderate: the data show the leaders are close, which is itself a finding.";
  const caveat = x.underpowered ? " Slightly limited by sample size." : "";
  const split = x.agreement.some((a) => !a.leaderFirst) ? " Other metrics disagree." : "";
  return `${x.omnibusSig ? "High" : "Moderate"}: reliable on ${x.metric} across ${x.nQueries} queries.${caveat}${split}`;
}

function caveats(x: Facts): string {
  const out: string[] = ["## Caveats and limits", ""];
  const add = (title: string, body: string) => out.push(`- **${title}.** ${body}`);

  add(
    "What is measured",
    "Success means recovering a paper's own references and citers. That is objective and needs no manual labels, but it is not the same as what a researcher would find useful.",
  );

  add(
    "Sample size",
    (x.requiredN != null
      ? x.underpowered
        ? `${x.nQueries} queries is below the ~${x.requiredN} needed to detect a ${x.minEffect} difference at the observed spread, so real but small differences may be missed.`
        : `${x.nQueries} queries meets the ~${x.requiredN} needed to detect a ${x.minEffect} difference at the observed spread. Smaller differences than that are still invisible.`
      : `${x.nQueries} queries were scored.`) +
      (x.detectableGap != null ? ` ${gapNote(x)}` : ""),
  );

  if (x.binary) {
    add(
      "Hit rate is coarse",
      `A query only counts whether a relevant paper appears in the top ${x.k}. It ignores where it appears and how many relevant papers were found, and it is the noisiest of the four measures, so it separates close pipelines poorly. Use nDCG for fine comparisons.`,
    );
  }

  add(
    "Several comparisons",
    `${x.pairs.length} pairwise tests were run; Holm correction keeps false positives in check but makes each individual test stricter, which is why close pipelines often come out tied.`,
  );

  if (x.dropped > 0) {
    add(
      "Dropped queries",
      `${x.dropped} ${x.dropped === 1 ? "query was" : "queries were"} dropped (${listOf(
        Array.from(new Set(x.r.dropped.map((d) => d.reason.split(":")[0]))).slice(0, 3),
      )}). If drops were not random, they could bias the comparison.`,
    );
  }

  if (x.agreement.some((a) => !a.leaderFirst)) {
    add(
      "Metrics disagree",
      `${x.name(x.leader.pipeline)} does not lead on every metric. The verdict applies to ${x.metric} only, the metric chosen in advance.`,
    );
  }

  add(
    "Library effects",
    "Queries and relevant papers come from the same library. Works the library holds because they are widely cited are easier to retrieve, so absolute scores may be higher than for a random paper; the comparison between pipelines is the part to trust.",
  );

  add(
    "Reproducibility",
    `Seed ${x.r.seed} fixes which papers were sampled and the bootstrap. A different seed samples different queries; if the verdict is the same across seeds, it is robust.`,
  );

  return out.join("\n");
}

function tables(x: Facts): string {
  const lines: string[] = [
    "## Leaderboard",
    "",
    leaderboardTable(x),
    "",
    `**How to read it.** Higher ${x.metric} is better. The interval is where the true mean plausibly lies. Pipelines sharing a G-label cannot be told apart statistically${x.groups.some((g) => g.length > 1) ? ` (here: ${x.groups.filter((g) => g.length > 1).map((g) => listOf(g.map(x.name))).join("; ")})` : " (there are none here)"}. Overlapping intervals are only a hint; the pairwise table is the test.`,
    "",
    "## Pairwise comparisons",
    "",
    pairwiseTable(x),
    "",
    x.binary
      ? `**How to read it.** Δ is the first pipeline's hit rate minus the second's, in percentage points. "Only first / only second hit" counts the queries where exactly one of the two found a relevant paper in the top ${x.k}: those are the only queries that can show a difference, and the McNemar test asks whether they split evenly. "Holm p" is the corrected p-value; below ${x.alpha} counts as significant. Cohen's h is the size of the effect between two proportions (negligible under 0.1, very small under 0.2, small under 0.5, medium under 0.8, large above). ${x.pairs.filter((p) => p.significant).length} of ${x.pairs.length} pairs are significant.`
      : `**How to read it.** Δ is the first pipeline minus the second, so a positive Δ favours the first. "Holm p" is the corrected p-value; below ${x.alpha} counts as significant. ${x.pairs.some((p) => p.paired_delta !== undefined) ? "Paired δ is how often the first pipeline beats the second on the same query minus how often it loses (ties count for neither)" : "Cliff's δ is the size of the effect"} (negligible under 0.15, small under 0.33, medium under 0.47, large above). ${x.pairs.filter((p) => p.significant).length} of ${x.pairs.length} pairs are significant.`,
  ];

  const metrics = metricsTable(x);
  if (metrics) {
    lines.push(
      "",
      "## Other metrics",
      "",
      metrics,
      "",
      `**How to read it.** These did not decide the verdict. ${agreementNote(x) ?? ""}`.trim(),
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------

/** Markdown for `style`, or a short note when the run has no verdict yet. */
export function interpret(
  result: TournamentResult,
  style: InterpretationStyle,
  nameOf: NameOf = (id) => id,
): string {
  const v = result.verdict;

  if (!v || !v.ranking || v.ranking.length < 2) {
    return "## Nothing to interpret yet\n\nThis tournament has no verdict. Finish a run with at least two pipelines and two scored queries.";
  }

  const facts = analyse(result, nameOf);
  const title = result.label ? `*${result.label}*\n\n` : "";
  const builders: Record<InterpretationStyle, (x: Facts) => string> = {
    plain,
    thesis,
    technical,
    executive,
    caveats,
    tables,
  };

  return title + builders[style](facts);
}

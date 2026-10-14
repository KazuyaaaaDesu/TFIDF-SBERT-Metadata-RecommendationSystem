/**
 * Interpretation of a battle series: the pooled board written up in the
 * same six styles as the tournament's interpretation box.
 *
 * The text is generated from the numbers by fixed rules, so every figure
 * in it is on the board. Two things are kept apart throughout, because
 * the board mixes them:
 *
 *   agreement   mean independence-weighted consensus share: who the
 *               pipelines agree with. It uses no ground truth.
 *   quality     mean nDCG against references or ticks, only for the
 *               battles that were judged. This is the evidence.
 */

import type { SeriesSummary } from "../api";
import { INTERPRETATION_STYLES, type InterpretationStyle } from "./tournamentInterpretation.ts";

export { INTERPRETATION_STYLES };

type NameOf = (id: string) => string;
type Agreement = SeriesSummary["agreement"][number];
type Quality = SeriesSummary["judged"]["pipelines"][number];

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const f3 = (v: number) => v.toFixed(3);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const overlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) =>
  a.lo <= b.hi && b.lo <= a.hi;

interface Facts {
  s: SeriesSummary;
  name: NameOf;
  top: Agreement | null;
  second: Agreement | null;
  /** Pipelines whose agreement interval overlaps the leader's. */
  tiedWithTop: Agreement[];
  qTop: Quality | null;
  qSecond: Quality | null;
  qTied: Quality[];
  verdictWinner: string | null;
  hasVerdict: boolean;
  judgedN: number;
  decisiveShare: number;
}

function analyse(s: SeriesSummary, name: NameOf): Facts {
  const [top = null, second = null] = s.agreement;
  const [qTop = null, qSecond = null] = s.judged.pipelines;
  const scored = s.decisive + s.too_close;

  return {
    s,
    name,
    top,
    second,
    tiedWithTop: top ? s.agreement.filter((r) => r !== top && overlap(r, top)) : [],
    qTop,
    qSecond,
    qTied: qTop ? s.judged.pipelines.filter((r) => r !== qTop && overlap(r, qTop)) : [],
    verdictWinner: s.judged.verdict?.winner ?? null,
    hasVerdict: Boolean(s.judged.verdict),
    judgedN: s.judged.n_judged,
    decisiveShare: scored ? s.decisive / scored : 0,
  };
}

function agreementLine(x: Facts): string {
  if (!x.top) return "No battle in the series had a recorded margin, so there is no agreement board.";

  const tied = x.tiedWithTop.map((r) => x.name(r.pipeline));

  return tied.length
    ? `${x.name(x.top.pipeline)} had the highest mean consensus share (${pct(x.top.mean)}), but its interval overlaps ${list(tied)}, so the pipelines cannot be told apart on agreement.`
    : `${x.name(x.top.pipeline)} had the highest mean consensus share (${pct(x.top.mean)}) and its interval clears every other pipeline.`;
}

function qualityLine(x: Facts): string {
  if (x.judgedN === 0) {
    return "None of the battles was judged, so there is no evidence about quality. Use seed-paper battles (scored against references) or judge text battles by hand.";
  }

  if (x.verdictWinner) {
    return `${x.name(x.verdictWinner)} is significantly better than every other pipeline on ${plural(x.judgedN, "judged battle")} (mean nDCG ${f3(x.qTop!.mean)}).`;
  }

  if (x.hasVerdict) {
    return `On ${plural(x.judgedN, "judged battle")} no pipeline is significantly better than all the others. ${x.name(x.qTop!.pipeline)} has the highest mean nDCG (${f3(x.qTop!.mean)}), which is a lead, not a result.`;
  }

  return `Only ${plural(x.judgedN, "battle")} ${x.judgedN === 1 ? "was" : "were"} judged, and a verdict needs ${x.s.judged.min_for_verdict}. ${x.name(x.qTop!.pipeline)} leads on mean nDCG (${f3(x.qTop!.mean)}) so far; that is a hint only.`;
}

function verdictsLine(x: Facts): string {
  const { s } = x;
  const scored = s.decisive + s.too_close;

  if (!scored) return "";

  return `${plural(s.decisive, "battle")} had a decisive leader and ${s.too_close} ${s.too_close === 1 ? "was" : "were"} too close to call (${pct(x.decisiveShare, 0)} decisive).`;
}

function agreementTable(x: Facts): string {
  const rows = x.s.agreement.map(
    (r, i) =>
      `| ${i + 1} | ${x.name(r.pipeline)} | ${pct(r.mean)} | ${pct(r.lo)} to ${pct(r.hi)} | ${r.decisive_wins} |`,
  );

  return ["| Rank | Pipeline | Mean consensus share | 95% interval | Decisive wins |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function qualityTable(x: Facts): string {
  const rows = x.s.judged.pipelines.map(
    (r, i) =>
      `| ${i + 1} | ${x.name(r.pipeline)} | ${f3(r.mean)} | ${r.lo.toFixed(2)} to ${r.hi.toFixed(2)} | ${pct(r.hit_rate, 0)} |`,
  );

  return ["| Rank | Pipeline | Mean nDCG | 95% interval | Hit rate |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function heading(x: Facts): string {
  return `**${x.s.label}**: ${plural(x.s.n_battles, "battle")} over ${plural(x.s.n_queries, "distinct query", "distinct queries")}.`;
}

function plain(x: Facts): string {
  return [
    "## What this series shows",
    "",
    heading(x),
    "",
    verdictsLine(x),
    "",
    `**Agreement.** ${agreementLine(x)} Agreement means the pipelines returned similar papers; it does not mean those papers are good.`,
    "",
    `**Quality.** ${qualityLine(x)}`,
  ].join("\n");
}

function thesis(x: Facts): string {
  const bits: string[] = [
    `Across ${plural(x.s.n_battles, "battle")} on ${plural(x.s.n_queries, "distinct query", "distinct queries")} (run label "${x.s.label}"), `,
  ];

  if (x.top) {
    bits.push(
      `${x.name(x.top.pipeline)} captured the highest mean independence-weighted consensus share (M = ${pct(x.top.mean)}, 95% bootstrap CI [${pct(x.top.lo)}, ${pct(x.top.hi)}])`,
      x.tiedWithTop.length ? `, with overlapping intervals for ${list(x.tiedWithTop.map((r) => x.name(r.pipeline)))}. ` : ", with no overlapping interval. ",
    );
  } else {
    bits.push("no consensus margins were recorded. ");
  }

  if (x.s.decisive + x.s.too_close) {
    bits.push(`A decisive leader (margin of at least two percentage points) emerged in ${x.s.decisive} of ${x.s.decisive + x.s.too_close} battles. `);
  }

  bits.push(
    x.judgedN
      ? `Against relevance judgements (${plural(x.judgedN, "battle")}), ${x.name(x.qTop!.pipeline)} reached the highest mean nDCG (M = ${f3(x.qTop!.mean)}, 95% CI [${x.qTop!.lo.toFixed(2)}, ${x.qTop!.hi.toFixed(2)}]); ${
          x.verdictWinner
            ? `it was significantly better than every other pipeline after correction for multiple comparisons.`
            : x.hasVerdict
              ? `no pipeline was significantly better than all others after correction for multiple comparisons.`
              : `too few battles were judged for a formal comparison.`
        }`
      : "No battle was judged against relevance data, so no claim about quality is made.",
  );

  return ["## Results", "", bits.join(""), "", "*Consensus share measures agreement among pipelines on each query and is not a measure of accuracy.*"].join("\n");
}

function technical(x: Facts): string {
  const { s } = x;

  return [
    "## Technical notes",
    "",
    `- Series label: \`${s.label}\`; ${s.n_battles} recorded battles, ${s.n_queries} distinct queries.`,
    `- Scored battles: ${s.decisive + s.too_close} (decisive ${s.decisive}, too close ${s.too_close}); ${s.unscored} without a stored margin.`,
    "- Agreement: per battle, each pipeline's independence-weighted consensus share (independence = 1 minus Jaccard of component sets). Series value is the mean over battles; 95% percentile bootstrap, 2000 resamples, seed 0.",
    "- A leader is decisive when it exceeds the runner-up's share by at least 0.02.",
    s.judged.n_judged
      ? `- Quality: nDCG@k per judged battle (${s.judged.n_judged} battles: ${Object.entries(s.judged.by_basis).map(([k, v]) => `${v} ${k}`).join(", ")}); bootstrap intervals as above. Verdict: Friedman omnibus, Wilcoxon signed-rank pairs, Holm correction, minimum ${s.judged.min_for_verdict} battles.`
      : "- Quality: no judged battles.",
    s.judged.n_skipped_nothing_relevant ? `- ${s.judged.n_skipped_nothing_relevant} judged battles found nothing relevant and are excluded.` : "",
    "",
    agreementTable(x),
    x.judgedN ? `\n${qualityTable(x)}` : "",
  ].filter((l) => l !== "").join("\n");
}

function executive(x: Facts): string {
  return [
    "## In short",
    "",
    `- ${plural(x.s.n_battles, "battle")} over ${plural(x.s.n_queries, "query", "queries")}; ${x.s.decisive} decisive, ${x.s.too_close} too close to call.`,
    `- Agreement: ${x.top ? `${x.name(x.top.pipeline)} highest (${pct(x.top.mean)})${x.tiedWithTop.length ? ", not clearly ahead" : ", clearly ahead"}.` : "no data."}`,
    `- Quality: ${x.verdictWinner ? `${x.name(x.verdictWinner)} is better.` : x.judgedN ? "no proven winner yet." : "not measured."}`,
    `- Next: ${x.judgedN < x.s.judged.min_for_verdict ? `judge more battles (${x.judgedN} of ${x.s.judged.min_for_verdict} needed); sampled seed papers are judged automatically.` : x.verdictWinner ? "use the Tournament to confirm on a larger set." : "add more queries or run a tournament; the gap is small."}`,
  ].join("\n");
}

function caveats(x: Facts): string {
  const items = [
    "Consensus share rewards pipelines that resemble the group. A pipeline can score low because it is different, not because it is wrong.",
    x.s.n_queries < 20 ? `Only ${x.s.n_queries} distinct queries: intervals are wide and a different set could rank the pipelines differently.` : "",
    x.tiedWithTop.length ? "The leader's interval overlaps other pipelines, so the order is not reliable." : "",
    x.s.unscored ? `${x.s.unscored} battles have no stored margin and are not in the agreement board.` : "",
    x.judgedN && x.judgedN < x.s.judged.min_for_verdict ? `Only ${x.judgedN} judged battles; fewer than ${x.s.judged.min_for_verdict} cannot support a verdict.` : "",
    !x.judgedN ? "Nothing here is judged against relevance, so none of it is evidence of quality." : "",
    x.s.judged.by_basis.references ? "References-based judging counts only papers present in this repository, and a paper's references are not all the relevant work." : "",
    x.s.judged.by_basis.human ? "Hand judging reflects one person's view of relevance." : "",
    x.s.judged.n_skipped_nothing_relevant ? `${x.s.judged.n_skipped_nothing_relevant} judged battles found nothing relevant and are excluded from the quality board.` : "",
  ].filter(Boolean);

  return ["## What limits this result", "", ...items.map((i) => `- ${i}`)].join("\n");
}

function tables(x: Facts): string {
  return [
    "## Tables",
    "",
    "### Agreement",
    "",
    agreementTable(x),
    "",
    "**How to read it.** Mean consensus share is how much of the possible weighted agreement a pipeline captured, averaged over battles. Intervals that overlap mean the order between those pipelines is not established. This is agreement, not quality.",
    ...(x.judgedN
      ? [
          "",
          "### Quality (judged battles)",
          "",
          qualityTable(x),
          "",
          "**How to read it.** Mean nDCG is the quality of each pipeline's list against the relevant papers, averaged over judged battles. Hit rate is the share of battles where at least one relevant paper appeared.",
        ]
      : []),
  ].join("\n");
}

/** Markdown for `style`, or a short note when the series has nothing scored. */
export function interpretSeries(
  summary: SeriesSummary,
  style: InterpretationStyle,
  nameOf: NameOf = (id) => id,
): string {
  if (summary.n_battles === 0) {
    return "## Nothing to interpret yet\n\nThis series has no recorded battles.";
  }

  const builders: Record<InterpretationStyle, (x: Facts) => string> = {
    plain,
    thesis,
    technical,
    executive,
    caveats,
    tables,
  };

  return builders[style](analyse(summary, nameOf));
}

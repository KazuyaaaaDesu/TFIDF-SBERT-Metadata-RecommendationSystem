/**
 * Plain-language reading of a recipe sweep, written from its numbers.
 * Only the held-out comparison is a finding; everything else is labelled
 * exploratory, because the best of many blends picked and judged on the
 * same queries is optimistic.
 */

import type { SweepResult, SweepWeights } from "../api";

const SIGNAL_NAMES: Record<keyof SweepWeights, string> = {
  tfidf: "TF-IDF",
  sbert: "S-BERT",
  metadata: "metadata",
};

export function recipeText(w: SweepWeights): string {
  return `${w.tfidf}/${w.sbert}/${w.metadata}`;
}

/** The signal carrying the most weight, or null for an even three-way split. */
export function dominantSignal(w: SweepWeights): string | null {
  const entries = Object.entries(w) as [keyof SweepWeights, number][];
  const max = Math.max(...entries.map(([, v]) => v));
  const top = entries.filter(([, v]) => v === max);

  return top.length === 1 ? SIGNAL_NAMES[top[0][0]] : null;
}

export function readSweep(
  result: SweepResult,
  presetName: (id: string) => string = (id) => id,
): string[] {
  const lines: string[] = [];
  const best = result.top[0];

  if (!best) return ["No query could be scored, so there is nothing to read."];

  const lead = dominantSignal(best.weights);

  lines.push(
    `On ${result.n_queries} queries, the highest ${result.metric} on the grid was ${best.mean.toFixed(3)} at ${recipeText(best.weights)} (TF-IDF/S-BERT/metadata)${lead ? `, a ${lead}-led blend` : ""}. That number is exploratory: it is the best of ${result.grid.length} blends scored on the same queries, so it is optimistic.`,
  );

  const spread = best.mean - Math.min(...result.grid.map((c) => c.mean));

  lines.push(
    spread < 0.02
      ? "The whole grid sits within 0.02 of each other: the blend barely matters on these queries."
      : `Across the grid the ${result.metric} ranges over ${spread.toFixed(3)}, so the blend does matter here.`,
  );

  const held = result.heldout;

  if (!held) {
    lines.push(result.reason ?? "Too few queries for a held-out check.");

    return lines;
  }

  const strongest = presetName(held.strongest_preset);
  const confirm = held.chosen_confirm;
  const gap = held.comparisons.find((c) => c.preset === held.strongest_preset);

  lines.push(
    `Honest check: the blend ${recipeText(held.chosen)} was picked on ${held.n_select} queries and then scored on the other ${held.n_confirm}, where it reached ${confirm.mean.toFixed(3)} (95% CI ${confirm.lo.toFixed(3)} to ${confirm.hi.toFixed(3)}).`,
  );

  if (gap) {
    const diff = `${gap.mean_diff >= 0 ? "+" : ""}${gap.mean_diff.toFixed(3)} (95% CI ${gap.lo.toFixed(3)} to ${gap.hi.toFixed(3)})`;

    lines.push(
      held.outcome === "better"
        ? `It beat the strongest preset, ${strongest}, by ${diff}: a real improvement on this set.`
        : held.outcome === "worse"
          ? `It was worse than the strongest preset, ${strongest}: ${diff}. Picking a blend on one half did not carry over.`
          : `Against the strongest preset, ${strongest}, the difference was ${diff}, which includes zero: no detectable improvement. A custom blend is not shown to beat the presets.`,
    );
  }

  return lines;
}

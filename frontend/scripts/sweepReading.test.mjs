/** Unit tests for the recipe sweep's plain-language reading. */

import assert from "node:assert/strict";
import test from "node:test";

import { dominantSignal, readSweep, recipeText } from "../src/utils/sweepReading.ts";

const cell = (t, s, m, mean) => ({ weights: { tfidf: t, sbert: s, metadata: m }, mean });

const base = (over = {}) => ({
  k: 10, step: 10, n_queries: 30, skipped: 0, metric: "nDCG@10",
  grid: [cell(0, 100, 0, 0.42), cell(100, 0, 0, 0.3), cell(40, 40, 20, 0.38)],
  top: [cell(0, 100, 0, 0.42)],
  heldout: null, reason: "Only 5 scorable queries: exploratory.", ...over,
});

const held = (outcome, lo, hi, diff) => ({
  n_select: 15, n_confirm: 15, chosen: { tfidf: 10, sbert: 90, metadata: 0 }, chosen_select_mean: 0.44,
  chosen_confirm: { mean: 0.41, lo: 0.35, hi: 0.47, n: 15 },
  comparisons: [{ preset: "sbert", preset_mean: 0.4, mean_diff: diff, lo, hi, clear: outcome === "better", worse: outcome === "worse" }],
  strongest_preset: "sbert", outcome,
});

test("recipe text and dominant signal", () => {
  assert.equal(recipeText({ tfidf: 10, sbert: 90, metadata: 0 }), "10/90/0");
  assert.equal(dominantSignal({ tfidf: 10, sbert: 90, metadata: 0 }), "S-BERT");
  assert.equal(dominantSignal({ tfidf: 34, sbert: 33, metadata: 33 }), "TF-IDF");
  assert.equal(dominantSignal({ tfidf: 50, sbert: 50, metadata: 0 }), null);
});

test("the grid best is always called exploratory and optimistic", () => {
  const text = readSweep(base()).join(" ");
  assert.match(text, /exploratory/);
  assert.match(text, /optimistic/);
});

test("without a held-out split it says why", () => {
  assert.match(readSweep(base()).join(" "), /Only 5 scorable queries/);
});

test("no detectable difference is not called an improvement", () => {
  const text = readSweep(base({ heldout: held("no_difference", -0.02, 0.04, 0.01) })).join(" ");
  assert.match(text, /includes zero/);
  assert.match(text, /not shown to beat the presets/);
  assert.ok(!/real improvement/.test(text));
});

test("better and worse outcomes are reported as such", () => {
  assert.match(readSweep(base({ heldout: held("better", 0.01, 0.05, 0.03) })).join(" "), /real improvement/);
  assert.match(readSweep(base({ heldout: held("worse", -0.05, -0.01, -0.03) })).join(" "), /was worse than the strongest preset/);
});

test("a flat grid says the blend barely matters", () => {
  const flat = base({ grid: [cell(0, 100, 0, 0.42), cell(100, 0, 0, 0.41)] });
  assert.match(readSweep(flat).join(" "), /barely matters/);
});

test("nothing scorable", () => {
  assert.match(readSweep(base({ top: [], grid: [] })).join(" "), /nothing to read/);
});

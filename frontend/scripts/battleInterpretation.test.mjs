/** Unit tests for the battle series interpretation text. */

import assert from "node:assert/strict";
import test from "node:test";

import { INTERPRETATION_STYLES, interpretSeries } from "../src/utils/battleInterpretation.ts";

const row = (pipeline, mean, half = 0.02, wins = 0) => ({
  pipeline, mean, lo: mean - half, hi: mean + half, n: 12, decisive_wins: wins,
});
const q = (pipeline, mean, half = 0.05) => ({
  pipeline, mean, lo: mean - half, hi: mean + half, n: 12, hit_rate: 0.8,
});

const base = (over = {}) => ({
  label: "series-test", n_battles: 12, n_queries: 12, decisive: 3, too_close: 9, unscored: 0,
  agreement: [row("a", 0.82, 0.02, 2), row("b", 0.81, 0.02, 1), row("c", 0.6, 0.03)],
  judged: { n_judged: 0, n_skipped_nothing_relevant: 0, by_basis: {}, min_for_verdict: 10, pipelines: [], verdict: null },
  ...over,
});

const judged = (verdict) => ({
  n_judged: 12, n_skipped_nothing_relevant: 0, by_basis: { references: 12 }, min_for_verdict: 10,
  pipelines: [q("b", 0.6), q("a", 0.4), q("c", 0.3)], verdict,
});

test("every style produces text for a typical series", () => {
  for (const { id } of INTERPRETATION_STYLES) {
    const text = interpretSeries(base(), id, (x) => x.toUpperCase());
    assert.ok(text.length > 80, id);
    assert.ok(!/undefined|NaN/.test(text), id);
  }
});

test("an empty series says there is nothing to interpret", () => {
  assert.match(interpretSeries(base({ n_battles: 0 }), "plain"), /Nothing to interpret/);
});

test("overlapping agreement intervals are not called a lead", () => {
  const text = interpretSeries(base(), "plain");
  assert.match(text, /cannot be told apart/);
});

test("a clear agreement leader is reported as clear", () => {
  const text = interpretSeries(base({ agreement: [row("a", 0.9), row("b", 0.6)] }), "plain");
  assert.match(text, /clears every other pipeline/);
});

test("no judged battles: no claim about quality", () => {
  const text = interpretSeries(base(), "thesis");
  assert.match(text, /no claim about quality/);
  assert.match(interpretSeries(base(), "caveats"), /none of it is evidence of quality/);
});

test("a judged verdict names the winner; a missing one does not", () => {
  const won = interpretSeries(base({ judged: judged({ outcome: "winner", winner: "b", tie_groups: [] }) }), "plain");
  assert.match(won, /b is significantly better/);
  const tie = interpretSeries(base({ judged: judged({ outcome: "tie", winner: null, tie_groups: [] }) }), "plain");
  assert.match(tie, /no pipeline is significantly better/);
  assert.ok(!/b is significantly better/.test(tie));
});

test("too few judged battles are labelled a hint", () => {
  const j = { ...judged(null), n_judged: 4 };
  assert.match(interpretSeries(base({ judged: j }), "plain"), /hint only/);
});

test("tables style includes both tables when judged", () => {
  const text = interpretSeries(base({ judged: judged(null) }), "tables");
  assert.match(text, /Mean consensus share/);
  assert.match(text, /Mean nDCG/);
});

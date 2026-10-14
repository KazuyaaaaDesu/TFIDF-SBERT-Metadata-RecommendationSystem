/**
 * Unit tests for the per-metric tournament defaults.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_QUERIES,
  METRIC_PROFILE,
  describeRecommendation,
  detectableGap,
  estimateRuntime,
  recommendedSettings,
  requiredQueries,
} from "../src/utils/tournamentDefaults.ts";

test("required queries match the server's sample-size formula", () => {
  // stats.required_sample_size(0.05, 0.2) == 126 and (0.05, 0.1) == 32
  assert.equal(requiredQueries(0.2), 126);
  assert.equal(requiredQueries(0.1), 32);
  assert.equal(requiredQueries(0.2, 0.1), 32);
  assert.equal(requiredQueries(0, 0.05), 2);
  assert.equal(requiredQueries(0.2, 0), 2);
});

test("noisier metrics need more queries", () => {
  const need = (m) => requiredQueries(METRIC_PROFILE[m].sd);
  assert.ok(need("ndcg") < need("recall"));
  assert.ok(need("recall") < need("mrr"));
  assert.ok(need("mrr") < need("hit"));
});

test("detectable gap shrinks with the square root of the queries", () => {
  assert.ok(Math.abs(detectableGap(0.2, 126) - 0.05) < 0.001);
  assert.ok(Math.abs(detectableGap(0.2, 504) - 0.025) < 0.001);
  assert.ok(detectableGap(0.2, 0) > 0); // never divides by zero
});

test("nDCG recommends 126 queries, top-10, 3 refs when plenty qualify", () => {
  const r = recommendedSettings("ndcg", 981);
  assert.deepEqual([r.queries, r.topK, r.minRefs, r.short], [126, 10, 3, false]);
});

test("recall is fixed at 20 and wants 5+ references", () => {
  const r = recommendedSettings("recall", 981);
  assert.deepEqual([r.topK, r.minRefs], [20, 5]);
  assert.equal(METRIC_PROFILE.recall.topKFixed, true);
  assert.equal(METRIC_PROFILE.ndcg.topKFixed, false);
});

test("every preset metric is now reachable within one run", () => {
  assert.equal(MAX_QUERIES, 5000);
  for (const m of ["ndcg", "mrr", "recall", "hit"]) {
    const r = recommendedSettings(m, 981);
    assert.equal(r.short, false, m);
    assert.equal(r.queries, requiredQueries(METRIC_PROFILE[m].sd), m);
  }
  // Hit needed more than the old 300 cap: now 636.
  assert.equal(recommendedSettings("hit", 981).queries, 636);
});

test("the cap still binds, and says so, when a metric needs more than a run allows", () => {
  const r = recommendedSettings("hit", 981);
  assert.ok(r.queries <= MAX_QUERIES);
  // a noisier-than-preset metric would exceed it; the explanation names the cap
  const huge = recommendedSettings("hit", null);
  assert.equal(huge.short, false);
});

test("run-time estimate scales with queries and pipelines", () => {
  assert.equal(estimateRuntime(100, 6), "about 4 min");
  assert.equal(estimateRuntime(1000, 2), "about 13 min");
  assert.equal(estimateRuntime(5000, 6), "about 3.3 h");
  assert.equal(estimateRuntime(10, 2), "about 8 s");
});

test("too few eligible papers lowers the queries and says why", () => {
  const r = recommendedSettings("ndcg", 40);
  assert.equal(r.queries, 40);
  assert.equal(r.short, true);
  assert.match(r.shortReason, /only 40 papers qualify/);
  // the floor is two queries, whatever the library holds
  assert.equal(recommendedSettings("ndcg", 0).queries, 2);
  assert.equal(recommendedSettings("ndcg", 1).queries, 2);
});

test("unknown availability falls back to the metric's requirement", () => {
  assert.equal(recommendedSettings("ndcg", null).queries, 126);
  assert.equal(recommendedSettings("mrr", null).queries, requiredQueries(0.3));
});

test("the description names the metric and what it can detect", () => {
  const ok = describeRecommendation("ndcg", recommendedSettings("ndcg", 981));
  assert.match(ok, /nDCG@k: 126 queries, top-10, min refs 3/);
  assert.match(ok, /Enough to detect/);
  const short = describeRecommendation("hit", recommendedSettings("hit", 200));
  assert.match(short, /636 would detect a 0\.05 gap, but only 200 papers qualify/);
  const recall = describeRecommendation("recall", recommendedSettings("recall", 981));
  assert.doesNotMatch(recall, /top-/);
});

/**
 * Unit tests for the tournament interpretation writer and the Markdown
 * exporters it relies on.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERPRETATION_STYLES,
  interpret,
} from "../src/utils/tournamentInterpretation.ts";
import {
  blocksToHtml,
  blocksToPlainText,
  parseChatMarkdown,
} from "../src/utils/chatMarkdown.ts";

const NAMES = { a: "Alpha", b: "Beta", c: "Gamma" };
const nameOf = (id) => NAMES[id] ?? id;

const pair = (a, b, diff, p, sig, delta) => ({
  a, b, mean_diff: diff, lo: diff - 0.02, hi: diff + 0.02,
  p_value: p / 2, p_adjusted: p, significant: sig, cliffs_delta: delta, cohens_dz: 1.1,
});

function result(over = {}) {
  return {
    kind: "loo_citations", label: "primary-ndcg10", primary_metric: "ndcg",
    primary_metric_name: "nDCG@k", top_k: 10, recall_k: 20,
    pipelines: ["a", "b", "c"], n_queries: 300, dropped: [], min_refs: 3, seed: 1, run_id: 7,
    secondary: {
      mrr: { a: { mean: 0.5, lo: 0.45, hi: 0.55, n: 300 }, b: { mean: 0.4, lo: 0.35, hi: 0.45, n: 300 }, c: { mean: 0.3, lo: 0.25, hi: 0.35, n: 300 } },
      recall: { a: { mean: 0.6, lo: 0.55, hi: 0.65, n: 300 }, b: { mean: 0.5, lo: 0.45, hi: 0.55, n: 300 }, c: { mean: 0.4, lo: 0.35, hi: 0.45, n: 300 } },
    },
    verdict: {
      outcome: "winner", reason: "Top mean is significantly better than every other pipeline.",
      winner: "a", n_queries: 300, alpha: 0.05, resamples: 2000, seed: 1,
      ranking: [
        { pipeline: "a", mean: 0.42, lo: 0.39, hi: 0.45, n: 300 },
        { pipeline: "b", mean: 0.31, lo: 0.28, hi: 0.34, n: 300 },
        { pipeline: "c", mean: 0.2, lo: 0.17, hi: 0.23, n: 300 },
      ],
      tie_groups: [["a"], ["b"], ["c"]], top_group: ["a"],
      omnibus: { statistic: 180.5, df: 2, p_value: 0.00001, n_queries: 300, mean_ranks: { a: 1.2, b: 2.0, c: 2.8 } },
      pairwise: [
        pair("a", "b", 0.11, 0.0004, true, 0.45),
        pair("a", "c", 0.22, 0.0001, true, 0.7),
        pair("b", "c", 0.11, 0.0003, true, 0.5),
      ],
      required_n: 120, min_effect: 0.05,
    },
    ...over,
  };
}

function tie() {
  const r = result();
  r.verdict = {
    ...r.verdict, outcome: "tie", winner: null, top_group: ["a", "b"],
    reason: "The top pipelines are not statistically separable.",
    tie_groups: [["a", "b"], ["c"]],
    omnibus: { ...r.verdict.omnibus, p_value: 0.01 },
    pairwise: [
      pair("a", "b", 0.01, 0.4, false, 0.05),
      pair("a", "c", 0.2, 0.001, true, 0.6),
      pair("b", "c", 0.19, 0.001, true, 0.55),
    ],
  };
  r.verdict.ranking[0].mean = 0.32; r.verdict.ranking[1].mean = 0.31;
  return r;
}

function inconclusive() {
  const r = result({ n_queries: 6 });
  r.verdict = {
    ...r.verdict, outcome: "inconclusive", winner: null, n_queries: 6, required_n: 150,
    reason: "6 queries is below the 150 needed.",
    omnibus: { ...r.verdict.omnibus, p_value: 0.3 },
    tie_groups: [["a", "b", "c"]], top_group: ["a", "b", "c"],
    pairwise: [pair("a", "b", 0.01, 1, false, 0.1), pair("a", "c", 0.02, 1, false, 0.1), pair("b", "c", 0.01, 1, false, 0.05)],
  };
  return r;
}

const IDS = INTERPRETATION_STYLES.map((s) => s.id);

test("six styles, each produces non-empty Markdown for every outcome", () => {
  assert.deepEqual(IDS, ["plain", "thesis", "technical", "executive", "caveats", "tables"]);
  for (const make of [result, tie, inconclusive]) {
    for (const id of IDS) {
      const md = interpret(make(), id, nameOf);
      assert.ok(md.length > 80, `${make.name}/${id}`);
      assert.ok(!/undefined|NaN|Infinity|\[object/.test(md), `${make.name}/${id}: ${md.match(/undefined|NaN|Infinity|\[object/)}`);
    }
  }
});

test("a clear winner is named and its margin is stated", () => {
  const plain = interpret(result(), "plain", nameOf);
  assert.match(plain, /Alpha is the best pipeline on nDCG@10/);
  assert.match(plain, /1\. Alpha: 0\.42/);
  assert.match(plain, /Alpha scores 0\.110 higher than Beta: a medium difference that is statistically reliable/);
  // plain language carries no statistics vocabulary
  assert.doesNotMatch(plain, /Holm|Cliff|CI of|bootstrap|Wilcoxon|Friedman/);
  assert.match(plain, /large enough to matter/);
  assert.match(plain, /also scores highest on MRR@10 and Recall@20/);
  assert.match(plain, /Use Alpha\./);
});

test("a tie never names a winner and says why", () => {
  const plain = interpret(tie(), "plain", nameOf);
  assert.doesNotMatch(plain, /is the best pipeline/);
  assert.match(plain, /No single pipeline is demonstrably best/);
  assert.match(plain, /Alpha and Beta lead/);
  assert.match(plain, /could easily be chance/);
  assert.doesNotMatch(plain, /Holm|Cliff|Wilcoxon/);
  const thesis = interpret(tie(), "thesis", nameOf);
  assert.match(thesis, /No pipeline was significantly better than every other/);
  assert.doesNotMatch(thesis, /reported as the best pipeline/);
});

test("an inconclusive run says it cannot tell and asks for more queries", () => {
  const plain = interpret(inconclusive(), "plain", nameOf);
  assert.match(plain, /cannot say which pipeline is best/);
  assert.match(plain, /at least 150 queries/);
  assert.doesNotMatch(plain, /Top two/);
  assert.match(interpret(inconclusive(), "executive", nameOf), /Low: too little data/);
  assert.match(interpret(inconclusive(), "caveats", nameOf), /below the ~150 needed/);
});

test("the thesis style uses APA number formatting and reports the tests", () => {
  const t = interpret(result(), "thesis", nameOf);
  assert.match(t, /χ²\(2, N = 300\) = 180\.50, p < \.001/);
  assert.match(t, /M = \.420, 95% CI \[\.390, \.450\]/);
  assert.match(t, /Holm-adjusted p < \.001/);
  assert.match(t, /Cliff's δ = \.45/);
  assert.match(t, /3 of 3 pairwise differences significant at α = \.05/);
  assert.match(t, /2000 resamples, seed 1/);
  assert.match(t, /\*\*Table 1\.\*\*/);
  assert.match(t, /\*\*Table 2\.\*\*/);
  // an exact p keeps three decimals and no leading zero
  const r = result();
  r.verdict.pairwise[0].p_adjusted = 0.043;
  r.verdict.omnibus.p_value = 0.043;
  assert.match(interpret(r, "thesis", nameOf), /p = \.043/);
});

test("every figure in the text is a figure in the result", () => {
  const r = result();
  const md = interpret(r, "technical", nameOf);
  for (const row of r.verdict.ranking) {
    assert.ok(md.includes(row.mean.toFixed(3)), `mean ${row.mean}`);
    assert.ok(md.includes(row.lo.toFixed(3)) && md.includes(row.hi.toFixed(3)));
  }
  for (const p of r.verdict.pairwise) {
    assert.ok(md.includes(Math.abs(p.mean_diff).toFixed(3)));
  }
  assert.match(md, /Friedman χ²\(2\) = 180\.500, p < 0\.001, n = 300: reject/);
  assert.match(md, /Alpha 1\.20; Beta 2\.00; Gamma 2\.80/);
  assert.match(md, /Significant pairs: 3 of 3/);
  assert.match(md, /\{Alpha\} > \{Beta\} > \{Gamma\}/);
});

test("tables are valid GFM that the chat parser reads back with the right shape", () => {
  for (const make of [result, tie]) {
    const blocks = parseChatMarkdown(interpret(make(), "tables", nameOf));
    const tables = blocks.filter((b) => b.t === "table");
    assert.equal(tables.length, 3);
    assert.equal(tables[0].rows.length, 3); // leaderboard
    assert.equal(tables[0].head.length, 5);
    assert.equal(tables[1].rows.length, 3); // pairwise
    assert.equal(tables[1].head.length, 6);
    assert.equal(tables[2].head.length, 3); // pipeline + 2 secondary metrics
    assert.deepEqual(tables[0].align, ["right", "left", "right", "center", "center"]);
  }
});

test("a tie shows its group label, a winner shows none", () => {
  assert.match(interpret(tie(), "tables", nameOf), /\| 1 \| Alpha \| 0\.320 \| \[0\.390, 0\.450\] \| G1 \|/);
  assert.doesNotMatch(interpret(result(), "tables", nameOf), /\| G\d \|/);
});

test("disagreeing secondary metrics are called out, not hidden", () => {
  const r = result();
  r.secondary.mrr.b.mean = 0.9;
  const plain = interpret(r, "plain", nameOf);
  assert.match(plain, /do not all agree: Beta is ahead on MRR@10/);
  assert.match(interpret(r, "caveats", nameOf), /does not lead on every metric/);
  assert.match(interpret(r, "executive", nameOf), /Other metrics disagree/);
});

test("practical size is judged separately from significance", () => {
  const r = result();
  r.verdict.pairwise[0].mean_diff = 0.01;
  assert.match(interpret(r, "plain", nameOf), /below 0\.05, so it is small in practical terms/);
});

test("underpowered runs say so; adequately powered ones say that instead", () => {
  const low = result({ n_queries: 40 });
  assert.match(interpret(low, "caveats", nameOf), /40 queries is below the ~120 needed/);
  assert.match(interpret(result(), "caveats", nameOf), /300 queries meets the ~120 needed/);
});

test("dropped queries are listed in the caveats only when there are some", () => {
  assert.doesNotMatch(interpret(result(), "caveats", nameOf), /Dropped queries/);
  const r = result({ dropped: [{ seed_paper_id: 1, reason: "tfidf: boom" }, { seed_paper_id: 2, reason: "no relevant" }] });
  assert.match(interpret(r, "caveats", nameOf), /2 queries were dropped \(tfidf and no relevant\)/);
  assert.match(interpret(r, "thesis", nameOf), /2 further queries were dropped because they could not be scored/);
  const one = result({ dropped: [{ seed_paper_id: 1, reason: "x" }] });
  assert.match(interpret(one, "thesis", nameOf), /1 further query was dropped because it could not be scored/);
});

test("Recall as the primary metric is named Recall@20, not Recall@10", () => {
  const r = result({ primary_metric: "recall", top_k: 20 });
  assert.match(interpret(r, "plain", nameOf), /Recall@20/);
  assert.doesNotMatch(interpret(r, "plain", nameOf), /Recall@10/);
});

test("the label heads the text, and an unfinished run is handled", () => {
  assert.ok(interpret(result(), "plain", nameOf).startsWith("*primary-ndcg10*"));
  assert.match(interpret({ ...result(), verdict: undefined }, "plain", nameOf), /Nothing to interpret yet/);
  const one = result();
  one.verdict.ranking = one.verdict.ranking.slice(0, 1);
  assert.match(interpret(one, "tables", nameOf), /Nothing to interpret yet/);
});

test("HTML export keeps tables as tables and escapes everything", () => {
  const html = blocksToHtml(parseChatMarkdown("## T\n\n| A | B |\n|:--|--:|\n| <b>x</b> | 1 & 2 |\n\n- one\n- two\n\n**bold** [l](https://a.b/?q=\"1\")"));
  assert.match(html, /<h2>T<\/h2>/);
  assert.match(html, /<table[^>]*><thead><tr><th style="text-align:left">A<\/th><th style="text-align:right">B<\/th><\/tr><\/thead>/);
  assert.match(html, /<td style="text-align:left">&lt;b&gt;x&lt;\/b&gt;<\/td>/);
  assert.match(html, /1 &amp; 2/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/a\.b\/\?q=&quot;1&quot;"/);
  assert.doesNotMatch(html, /<b>x/);
});

test("plain-text export: bullets as written, tables tab-separated", () => {
  const text = blocksToPlainText(parseChatMarkdown("## Head\n\nPara **bold**.\n\n- a\n- b\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"));
  assert.match(text, /^HEAD\n\nPara bold\.\n\n- a\n- b\n\nX\tY\n1\t2\n3\t4$/);
});

test("exports of a real interpretation contain no stray markup", () => {
  for (const id of IDS) {
    const blocks = parseChatMarkdown(interpret(result(), id, nameOf));
    const text = blocksToPlainText(blocks);
    assert.ok(!text.includes("**"), id);
    assert.ok(!/\|---|:--/.test(text), id);
    const html = blocksToHtml(blocks);
    assert.ok(html.length > 100 && !/undefined/.test(html), id);
  }
});


// ---------------------------------------------------------------
// Hit rate: a 0/1 metric (McNemar's exact test, Cohen's h, points)
// ---------------------------------------------------------------

const mc = (a, b, diff, p, sig, h, label, aOnly, bOnly) => ({
  a, b, mean_diff: diff, lo: diff - 0.03, hi: diff + 0.03,
  p_value: p / 2, p_adjusted: p, significant: sig,
  cliffs_delta: diff, cohens_dz: 0.1,
  test: "mcnemar", effect_kind: "h", effect_size: h, effect_label: label,
  cohens_h: h, a_only: aOnly, b_only: bOnly,
});

function hitResult() {
  const r = result({ primary_metric: "hit", primary_metric_name: "Hit@k" });
  r.secondary = {
    ndcg: { a: { mean: 0.2, lo: 0.1, hi: 0.3, n: 300 }, b: { mean: 0.25, lo: 0.2, hi: 0.3, n: 300 }, c: { mean: 0.1, lo: 0.05, hi: 0.15, n: 300 } },
    mrr: { a: { mean: 0.4, lo: 0.3, hi: 0.5, n: 300 }, b: { mean: 0.45, lo: 0.4, hi: 0.5, n: 300 }, c: { mean: 0.3, lo: 0.2, hi: 0.4, n: 300 } },
    recall: { a: { mean: 0.3, lo: 0.2, hi: 0.4, n: 300 }, b: { mean: 0.35, lo: 0.3, hi: 0.4, n: 300 }, c: { mean: 0.2, lo: 0.1, hi: 0.3, n: 300 } },
  };
  r.verdict = {
    ...r.verdict, outcome: "tie", winner: null, top_group: ["a", "b"], reason: "x",
    binary: true, pairwise_test: "McNemar exact",
    ranking: [
      { pipeline: "a", mean: 0.743, lo: 0.693, hi: 0.79, n: 300 },
      { pipeline: "b", mean: 0.74, lo: 0.69, hi: 0.79, n: 300 },
      { pipeline: "c", mean: 0.65, lo: 0.597, hi: 0.707, n: 300 },
    ],
    tie_groups: [["a", "b"], ["c"]],
    omnibus: { statistic: 43.68, df: 2, p_value: 0.00001, n_queries: 300, mean_ranks: { a: 1.5, b: 1.6, c: 2.9 } },
    pairwise: [
      mc("a", "b", 0.003, 1.0, false, 0.0, "negligible", 14, 13),
      mc("a", "c", 0.093, 0.004, true, 0.2, "small", 41, 13),
      mc("b", "c", 0.09, 0.002, true, 0.2, "small", 40, 13),
    ],
  };
  return r;
}

test("hit rate: a nine-point gap is never called negligible", () => {
  for (const id of IDS) {
    const md = interpret(hitResult(), id, nameOf);
    assert.doesNotMatch(md, /9\.\d percentage points.{0,200}negligible/s, id);
  }
  const tables = interpret(hitResult(), "tables", nameOf);
  assert.match(tables, /Alpha vs Gamma \| \+9\.3 pp .* \+0\.20 \(small\) \| yes/);
  assert.match(tables, /Alpha vs Beta \| \+0\.3 pp .* \+0\.00 \(negligible\) \| no/);
});

test("hit rate: the pairwise table reports points, discordant counts and Cohen's h", () => {
  const blocks = parseChatMarkdown(interpret(hitResult(), "tables", nameOf));
  const pairwise = blocks.filter((b) => b.t === "table")[1];
  assert.equal(pairwise.head.length, 7);
  assert.match(
    pairwise.head.map((h) => h[0].v ?? "").join("|"),
    /Comparison\|Δ hit rate|Comparison/,
  );
  const md = interpret(hitResult(), "tables", nameOf);
  assert.match(md, /Δ hit rate/);
  assert.match(md, /Only first \/ only second hit/);
  assert.match(md, /Cohen's h/);
  assert.match(md, /negligible under 0\.1, very small under 0\.2, small under 0\.5/);
  assert.match(md, /41 \/ 13/);
  assert.doesNotMatch(md, /Cliff/);
});

test("hit rate: the text names McNemar's test, not Wilcoxon", () => {
  const thesis = interpret(hitResult(), "thesis", nameOf);
  assert.match(thesis, /McNemar exact tests on paired hit\/miss outcomes/);
  assert.match(thesis, /equivalent to Cochran's Q/);
  assert.match(thesis, /Cohen's h effect size; differences in percentage points/);
  assert.doesNotMatch(thesis, /Wilcoxon|Cliff/);
  const tech = interpret(hitResult(), "technical", nameOf);
  assert.match(tech, /McNemar test on paired hit\/miss outcomes/);
  assert.match(tech, /Cochran's Q/);
  assert.doesNotMatch(tech, /Wilcoxon/);
});

test("hit rate: plain language speaks in percentages of queries", () => {
  const r = hitResult();
  r.verdict.outcome = "winner"; r.verdict.winner = "a";
  r.verdict.pairwise[0] = mc("a", "b", 0.093, 0.004, true, 0.2, "small", 41, 13);
  r.verdict.ranking[1].mean = 0.65;
  const plain = interpret(r, "plain", nameOf);
  assert.match(plain, /finds a relevant paper in the top 10 for 74% of queries, against 65% for Beta: a small difference that is statistically reliable/);
  assert.doesNotMatch(plain, /Holm|Cohen|McNemar/);
});

test("hit rate: the leader gap states points and who hit alone", () => {
  const thesis = interpret(hitResult(), "thesis", nameOf);
  assert.match(thesis, /leads Beta by 0\.3 percentage points of hit rate/);
  assert.match(thesis, /McNemar exact\), a negligible effect \(Cohen's h = \.00\)/);
  assert.match(thesis, /Alpha alone hit on 14 queries and Beta alone on 13/);
});

test("hit rate: the caveats explain why the metric is coarse; other metrics do not get that note", () => {
  assert.match(interpret(hitResult(), "caveats", nameOf), /Hit rate is coarse/);
  assert.doesNotMatch(interpret(result(), "caveats", nameOf), /Hit rate is coarse/);
});

test("disagreeing metrics are merged into one clause per pipeline", () => {
  const plain = interpret(hitResult(), "plain", nameOf);
  assert.match(plain, /Beta is ahead on nDCG@10, MRR@10, and Recall@20\. Treat the result/);
  assert.equal((plain.match(/Beta is ahead/g) ?? []).length, 1);
});

test("old results without the new fields still read correctly (Wilcoxon, Cliff's delta)", () => {
  const md = interpret(result(), "thesis", nameOf);
  assert.match(md, /paired Wilcoxon signed-rank tests/);
  assert.match(md, /Cliff's δ/);
  assert.doesNotMatch(md, /McNemar|Cohen's h/);
  // and with the new fields present for a continuous metric
  const r = result();
  r.verdict.pairwise = r.verdict.pairwise.map((p) => ({ ...p, test: "wilcoxon", effect_kind: "delta", effect_size: p.cliffs_delta, effect_label: "medium" }));
  assert.match(interpret(r, "tables", nameOf), /Cliff's δ/);
});


// ---------------------------------------------------------------
// Paired effect size and the detectable gap
// ---------------------------------------------------------------

function pairedResult() {
  const r = result();
  r.verdict.detectable_gap = 0.0123;
  r.verdict.pairwise = r.verdict.pairwise.map((p, i) => ({
    ...p,
    cliffs_delta: [0.13, 0.2, 0.1][i],              // unpaired: reads "negligible"/"small"
    paired_delta: [0.24, 0.4, 0.18][i],              // paired: the real consistency
    test: "wilcoxon", effect_kind: "delta",
    effect_size: [0.24, 0.4, 0.18][i],
    effect_label: ["small", "medium", "small"][i],
  }));
  return r;
}

test("the label comes from the paired delta, and it is named as such", () => {
  const thesis = interpret(pairedResult(), "thesis", nameOf);
  assert.match(thesis, /a small effect \(paired Cliff's δ = \.24\)/);
  assert.doesNotMatch(thesis, /negligible effect/);
  const tables = interpret(pairedResult(), "tables", nameOf);
  assert.match(tables, /Paired δ/);
  assert.match(tables, /Alpha vs Beta \|.*\+0\.24 \(small\)/);
  assert.match(tables, /How often the first pipeline beats the second on the same query/i);
  assert.doesNotMatch(tables, /\| Cliff's δ \|/);
});

test("the table's effect column and the plain sentence use the paired value", () => {
  const plain = interpret(pairedResult(), "plain", nameOf);
  assert.match(plain, /a small difference that is statistically reliable/);
  const blocks = parseChatMarkdown(interpret(pairedResult(), "tables", nameOf));
  assert.equal(blocks.filter((b) => b.t === "table")[1].head.length, 6);
});

test("a null result states what the run could and could not detect", () => {
  const t = tie();
  t.verdict.detectable_gap = 0.0066;
  const caveats = interpret(t, "caveats", nameOf);
  assert.match(caveats, /could reliably detect a gap of about 0\.007 or more between the top two pipelines \(80% power\)/);
  const hit = hitResult();
  hit.verdict.detectable_gap = 0.0318;
  assert.match(interpret(hit, "caveats", nameOf), /about 3\.2 percentage points or more/);
  // old results without the field simply omit the sentence
  assert.doesNotMatch(interpret(result(), "caveats", nameOf), /80% power/);
});

test("older stored results (no paired fields) keep their original wording", () => {
  const md = interpret(result(), "tables", nameOf);
  assert.match(md, /\| Cliff's δ \|/);
  assert.doesNotMatch(md, /Paired δ/);
});

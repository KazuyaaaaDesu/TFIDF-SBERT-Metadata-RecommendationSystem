import test from "node:test";
import assert from "node:assert/strict";
import {
  blendRecommendations,
  isSameWork,
  seedWebQuery,
} from "../src/utils/blendRecommendations.ts";

const local = (id, score, extra = {}) => ({
  paper: { id, title: `Local ${id}`, doi: null, publication_year: 2020, ...extra },
  score,
});
const web = (title, score, extra = {}) => ({
  title,
  score,
  doi: null,
  publication_year: 2021,
  source: "openalex",
  ...extra,
});

test("interleaves by score rescaled to each list's best", () => {
  const rows = blendRecommendations({
    local: [local(1, 0.8), local(2, 0.4)],
    web: [web("A", 0.5), web("B", 0.45)],
    topK: 10,
  });
  assert.deepEqual(
    rows.map((r) => (r.origin === "local" ? `L${r.result.paper.id}` : r.web.title)),
    ["L1", "A", "B", "L2"],
  );
});

test("respects topK and ties favour local then original order", () => {
  const rows = blendRecommendations({
    local: [local(1, 1)],
    web: [web("A", 1), web("B", 1)],
    topK: 2,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].origin, "local");
  assert.equal(rows[1].web.title, "A");
});

test("dedupes by DOI (local wins) and by title+year", () => {
  const rows = blendRecommendations({
    local: [local(1, 1, { doi: "10.1/ABC" }), local(2, 0.5, { title: "Deep  Learning!" })],
    web: [
      web("Different", 1, { doi: "https://doi.org/10.1/abc" }),
      web("deep learning", 1, { publication_year: 2020 }),
      web("Other year", 1),
      web("deep learning", 0.9, { publication_year: 2015 }),
    ],
    topK: 10,
  });
  const webTitles = rows.filter((r) => r.origin === "web").map((r) => r.web.title);
  assert.deepEqual(webTitles, ["Other year", "deep learning"]);
  assert.equal(rows.filter((r) => r.origin === "local").length, 2);
});

test("keeps list order when local scores are not monotone (MMR)", () => {
  const rows = blendRecommendations({
    local: [local(1, 0.5), local(2, 0.9)],
    web: [],
    topK: 5,
  });
  assert.deepEqual(rows.map((r) => r.result.paper.id), [1, 2]);
});

test("handles empty and zero-score input", () => {
  assert.deepEqual(blendRecommendations({ local: [], web: [], topK: 5 }), []);
  const rows = blendRecommendations({ local: [], web: [web("A", 0)], topK: 5 });
  assert.equal(rows[0].blendScore, 0);
  assert.equal(blendRecommendations({ local: [local(1, 1)], web: [], topK: 0 }).length, 0);
});

test("isSameWork requires matching years when both present", () => {
  assert.equal(
    isSameWork({ doi: null, title: "X y", publication_year: 2019 }, { doi: null, title: "x-y", publication_year: 2020 }),
    false,
  );
});

test("seedWebQuery uses title plus first keywords", () => {
  assert.equal(
    seedWebQuery({ title: " T ", keywords: "a; b, c\nd, e" }),
    "T a b c d",
  );
  assert.equal(seedWebQuery({ title: "T", keywords: null }), "T");
});

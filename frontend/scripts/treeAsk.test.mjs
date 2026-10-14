/**
 * Unit tests for the tree's patience.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BURST_WINDOW_MS,
  FREE_ASKS,
  brushOffChance,
  grumpyLine,
  recentAsks,
  registerAsk,
} from "../src/utils/treeAsk.ts";

test("the first few asks are always answered", () => {
  for (let n = 1; n <= FREE_ASKS; n++) assert.equal(brushOffChance(n), 0);
});

test("impatience grows with every extra ask, and is capped", () => {
  let last = 0;

  for (let n = FREE_ASKS + 1; n <= 12; n++) {
    const p = brushOffChance(n);

    assert.ok(p > 0 && p <= 0.7);
    assert.ok(p >= last, `${n}`);
    last = p;
  }

  assert.equal(brushOffChance(50), 0.7);
});

test("asks outside the window are forgotten", () => {
  const now = 1_000_000;
  const times = [now - BURST_WINDOW_MS - 1, now - BURST_WINDOW_MS + 5, now - 100];

  assert.deepEqual(recentAsks(times, now), [now - BURST_WINDOW_MS + 5, now - 100]);
});

test("slow, patient asking is never brushed off", () => {
  let times = [];
  let now = 0;

  for (let i = 0; i < 40; i++) {
    now += BURST_WINDOW_MS + 1000;
    const out = registerAsk(times, now, () => 0);

    assert.equal(out.brushOff, false);
    times = out.times;
  }
});

test("rapid asking is eventually brushed off, and sometimes answered", () => {
  let brushed = 0;
  let answered = 0;
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  for (let run = 0; run < 400; run++) {
    let times = [];

    for (let i = 0; i < 10; i++) {
      const out = registerAsk(times, run * 1_000_000 + i * 500, rand);

      times = out.times;
      if (i < FREE_ASKS) assert.equal(out.brushOff, false);
      if (i >= FREE_ASKS) out.brushOff ? brushed++ : answered++;
    }
  }

  assert.ok(brushed > answered * 0.3, `${brushed} brushed vs ${answered} answered`);
  assert.ok(answered > 0, "the tree should sometimes still answer");
});

test("a brushed-off ask still counts, so pestering keeps the tree grumpy", () => {
  const first = registerAsk([], 0, () => 0.99);
  const second = registerAsk(first.times, 100, () => 0.99);

  assert.equal(second.times.length, 2);
});

test("grumpy lines are short, in the tree's voice, and species flavored", () => {
  const seen = new Set();

  for (const species of ["crimson", "oak", "birch", "elm", "redwood", "beanstalk", "rosevine", "ghost"]) {
    for (let i = 0; i < 60; i++) {
      const line = grumpyLine(species, Math.random);

      assert.ok(line.length > 8 && line.length <= 64, line);
      seen.add(line);
    }
  }

  assert.ok(seen.size >= 14, `only ${seen.size} different lines`);
  assert.ok([...seen].some((l) => /bother me/i.test(l)));
});

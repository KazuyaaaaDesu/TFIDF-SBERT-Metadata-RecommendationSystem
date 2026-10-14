/**
 * Unit tests for the garden's height milestones.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cheatsCrossed,
  milestonesCrossed,
} from "../src/utils/gardenMilestones.ts";

const KNOWLEDGE = [100, 300, 1000];
const CHEATS = [250, 650, 1000];
const crossed = (a, b) =>
  milestonesCrossed(a, b, KNOWLEDGE, CHEATS).map((m) => `${m.kind}@${m.at}`);

test("nothing fires until a milestone is actually reached", () => {
  assert.deepEqual(crossed(0, 99), []);
  assert.deepEqual(crossed(101, 249), []);
  assert.deepEqual(crossed(301, 649), []);
});

test("a milestone fires the moment its height is reached, not before", () => {
  assert.deepEqual(crossed(99, 100), ["knowledge@100"]);
  assert.deepEqual(crossed(249, 250), ["cheat@250"]);
  assert.deepEqual(crossed(299, 300), ["knowledge@300"]);
  assert.deepEqual(crossed(649, 650), ["cheat@650"]);
});

test("each milestone fires once: standing on it does not repeat it", () => {
  assert.deepEqual(crossed(100, 150), []);
  assert.deepEqual(crossed(250, 251), []);
});

test("a big jump reports everything crossed, lowest first", () => {
  assert.deepEqual(crossed(0, 700), [
    "knowledge@100",
    "cheat@250",
    "knowledge@300",
    "cheat@650",
  ]);
});

test("the ancient crown unlocks the last knowledge stage and the last cheat together", () => {
  assert.deepEqual(crossed(900, 1000), ["knowledge@1000", "cheat@1000"]);
});

test("shrinking, resetting or staying put fires nothing", () => {
  assert.deepEqual(crossed(700, 0), []);
  assert.deepEqual(crossed(500, 500), []);
  assert.deepEqual(crossed(Number.NaN, 500), []);
});

test("indexes follow each ladder", () => {
  const found = milestonesCrossed(0, 1000, KNOWLEDGE, CHEATS);

  assert.deepEqual(
    found.filter((m) => m.kind === "cheat").map((m) => m.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    found.filter((m) => m.kind === "knowledge").map((m) => m.index),
    [0, 1, 2],
  );
});

/* ---- cheatsCrossed: the word that unlocks is the one at its own rung ---- */

const SET = [
  { word: "first", effect: "the first charm" },
  { word: "second", effect: "the second charm" },
  { word: "third", effect: "the third charm" },
];
const LADDER = [250, 450, 650];
const unlocked = (before, after, set = SET) =>
  cheatsCrossed(before, after, LADDER, set).map(
    (m) => `${m.height}:${m.word}`,
  );

test("a single rung crossed alone brings its OWN word, not the lowest", () => {
  /* Indexing the filtered list instead of the ladder paired the 450 ft
     crossing with the 250 ft word. */
  assert.deepEqual(unlocked(300, 460), ["450:second"]);
  assert.deepEqual(unlocked(460, 700), ["650:third"]);
});

test("a big jump reports every rung lowest first, each with its own word", () => {
  assert.deepEqual(unlocked(0, 1000), [
    "250:first",
    "450:second",
    "650:third",
  ]);
});

test("standing on a rung, shrinking, resetting or a bad height fires nothing", () => {
  assert.deepEqual(unlocked(250, 251), []);
  assert.deepEqual(unlocked(700, 0), []);
  assert.deepEqual(unlocked(500, 500), []);
  assert.deepEqual(unlocked(Number.NaN, 500), []);
});

test("a rung with no word comes back empty rather than borrowing one", () => {
  const short = SET.slice(0, 1);

  assert.deepEqual(unlocked(0, 700, short), ["250:first", "450:", "650:"]);
  assert.deepEqual(unlocked(0, 700, []), ["250:", "450:", "650:"]);
});

/** Unit tests for right-click menu placement. */

import assert from "node:assert/strict";
import test from "node:test";

import { placeMenu } from "../src/utils/menuPosition.ts";

const base = { width: 200, height: 300, viewportWidth: 1000, viewportHeight: 700 };

test("opens at the pointer when it fits", () => {
  assert.deepEqual(placeMenu({ ...base, x: 100, y: 100 }), { left: 100, top: 100, maxHeight: null });
});

test("flips to the left of the pointer near the right edge", () => {
  const p = placeMenu({ ...base, x: 950, y: 100 });
  assert.equal(p.left, 750);
  assert.equal(p.top, 100);
});

test("flips above the pointer near the bottom edge", () => {
  const p = placeMenu({ ...base, x: 100, y: 650 });
  assert.equal(p.top, 350);
});

test("flips both ways in the bottom-right corner", () => {
  const p = placeMenu({ ...base, x: 990, y: 690 });
  assert.deepEqual([p.left, p.top], [790, 390]);
});

test("never leaves the margin on any side", () => {
  for (const [x, y] of [[-50, -50], [0, 0], [1000, 700], [5000, 5000], [500, 350]]) {
    const p = placeMenu({ ...base, x, y });
    assert.ok(p.left >= 8 && p.top >= 8, `${x},${y}`);
    assert.ok(p.left + base.width <= 1000 - 8, `${x},${y}`);
    assert.ok(p.top + base.height <= 700 - 8, `${x},${y}`);
  }
});

test("a menu that fits neither side is pinned inside the window", () => {
  const p = placeMenu({ x: 300, y: 300, width: 200, height: 500, viewportWidth: 1000, viewportHeight: 600 });
  assert.ok(p.top >= 8 && p.top + 500 <= 600 - 8);
});

test("a menu taller than the window scrolls instead of being cut off", () => {
  const p = placeMenu({ x: 100, y: 400, width: 200, height: 900, viewportWidth: 1000, viewportHeight: 600 });
  assert.equal(p.maxHeight, 584);
  assert.equal(p.top, 8);
});

test("a menu wider than the window is squeezed to fit", () => {
  const p = placeMenu({ x: 100, y: 100, width: 2000, height: 100, viewportWidth: 800, viewportHeight: 600 });
  assert.equal(p.left, 8);
});

test("a custom margin is honoured", () => {
  const p = placeMenu({ ...base, x: 0, y: 0, margin: 20 });
  assert.deepEqual([p.left, p.top], [20, 20]);
});

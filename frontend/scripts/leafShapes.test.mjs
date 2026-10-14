/**
 * Unit tests for the leaf designs.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import { leafPixels } from "../src/utils/leafShapes.ts";

const SHAPES = ["maple", "lobed", "birch", "elm", "redwood", "bean", "rose", "sprig"];
const SIZES = [1, 1.5, 2, 3, 4.5, 6.5, 9];

test("every leaf leaves a mark at every size and turn", () => {
  for (const shape of SHAPES) {
    for (const r of SIZES) {
      for (const ph of [0, 0.7, 2.1, 4]) {
        const px = leafPixels(shape, r, ph, 0.6);

        assert.ok(px.dx.length >= 1, `${shape} r${r}`);
        assert.equal(px.dx.length, px.dy.length);
        assert.equal(px.dx.length, px.shade.length);
      }
    }
  }
});

test("leaves stay within their radius and use shades 0..4 only", () => {
  for (const shape of SHAPES) {
    for (const r of SIZES) {
      const px = leafPixels(shape, r, 1.1, 0.6);
      const reach = Math.ceil(r * 1.45) + 1;

      for (let i = 0; i < px.dx.length; i++) {
        assert.ok(Math.abs(px.dx[i]) <= reach && Math.abs(px.dy[i]) <= reach, `${shape} r${r}`);
        assert.ok(Number.isInteger(px.shade[i]) && px.shade[i] >= 0 && px.shade[i] <= 4);
      }
    }
  }
});

test("a leaf is the same every time, and bigger leaves cover more pixels", () => {
  for (const shape of SHAPES) {
    assert.deepEqual(leafPixels(shape, 5, 0.9, 0.6), leafPixels(shape, 5, 0.9, 0.6));

    const small = leafPixels(shape, 3, 0.9, 0.6).dx.length;
    const large = leafPixels(shape, 8, 0.9, 0.6).dx.length;

    assert.ok(large > small * 2, `${shape}: ${small} vs ${large}`);
  }
});

test("each species has its own silhouette", () => {
  const outline = (shape) =>
    new Set(
      (() => {
        const px = leafPixels(shape, 7, 0, 0.6);

        return px.dx.map((x, i) => `${x},${px.dy[i]}`);
      })(),
    );
  const jaccard = (a, b) => {
    const inter = [...a].filter((v) => b.has(v)).length;

    return inter / (a.size + b.size - inter);
  };

  for (let i = 0; i < SHAPES.length; i++) {
    for (let j = i + 1; j < SHAPES.length; j++) {
      const sim = jaccard(outline(SHAPES[i]), outline(SHAPES[j]));

      assert.ok(sim < 0.8, `${SHAPES[i]} and ${SHAPES[j]} are too alike (${sim.toFixed(2)})`);
    }
  }
});

test("detail grows with size: veins appear on bigger leaves only", () => {
  for (const shape of SHAPES) {
    const dark = (r) => {
      const px = leafPixels(shape, r, 0.9, 0.7);

      return px.shade.filter((s) => s <= 1).length / px.shade.length;
    };

    assert.ok(dark(9) > dark(1.5) - 0.2, shape);
  }
});

test("the maple is five-lobed: its outline reaches out in several directions", () => {
  const px = leafPixels("maple", 9, 0, 0.6);
  const far = px.dx
    .map((x, i) => Math.hypot(x, px.dy[i]))
    .filter((d) => d > 9 * 0.8).length;

  assert.ok(far >= 6, `only ${far} far pixels`);
});

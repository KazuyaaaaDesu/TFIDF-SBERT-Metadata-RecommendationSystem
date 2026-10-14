/** Unit tests for the blend triangle's geometry. */

import assert from "node:assert/strict";
import test from "node:test";

import { barycentric, blendFromPoint } from "../src/utils/blend.ts";

const A = [50, 0];   // TF-IDF
const B = [0, 100];  // S-BERT
const C = [100, 100]; // metadata

test("corners are pure signals", () => {
  assert.deepEqual(blendFromPoint(A, A, B, C), { tfidf: 100, sbert: 0, metadata: 0 });
  assert.deepEqual(blendFromPoint(B, A, B, C), { tfidf: 0, sbert: 100, metadata: 0 });
  assert.deepEqual(blendFromPoint(C, A, B, C), { tfidf: 0, sbert: 0, metadata: 100 });
});

test("the centroid is an even-ish split that sums to 100", () => {
  const mid = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
  const blend = blendFromPoint(mid, A, B, C);
  assert.equal(blend.tfidf + blend.sbert + blend.metadata, 100);
  for (const v of Object.values(blend)) assert.ok(v >= 30 && v <= 35, String(v));
});

test("an edge midpoint has no weight on the opposite corner", () => {
  const ab = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  assert.deepEqual(blendFromPoint(ab, A, B, C), { tfidf: 50, sbert: 50, metadata: 0 });
});

test("points outside the triangle land on its boundary", () => {
  const far = blendFromPoint([-200, -200], A, B, C);
  assert.equal(far.tfidf + far.sbert + far.metadata, 100);
  assert.ok(Object.values(far).every((v) => v >= 0 && v <= 100));
  const below = blendFromPoint([50, 500], A, B, C);
  assert.equal(below.tfidf, 0);
});

test("every result is a multiple of the step and sums to 100", () => {
  for (let x = -20; x <= 120; x += 7) {
    for (let y = -20; y <= 120; y += 9) {
      const b = blendFromPoint([x, y], A, B, C, 5);
      assert.equal(b.tfidf + b.sbert + b.metadata, 100, `${x},${y}`);
      assert.ok(b.tfidf % 5 === 0 && b.sbert % 5 === 0 && b.metadata % 5 === 0, `${x},${y}`);
      assert.ok(b.metadata >= 0);
    }
  }
});

test("barycentric weights sum to one and invert the corners", () => {
  const [a, b, c] = barycentric([50, 50], A, B, C);
  assert.ok(Math.abs(a + b + c - 1) < 1e-9);
  assert.deepEqual(barycentric(A, A, B, C).map((v) => Math.round(v) || 0), [1, 0, 0]);
});

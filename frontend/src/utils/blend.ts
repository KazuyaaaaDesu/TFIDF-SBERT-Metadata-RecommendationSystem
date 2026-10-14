/**
 * Geometry of the blend triangle: a point inside the triangle is a mix of
 * its three corners (TF-IDF, S-BERT, metadata). Dragging the dot turns a
 * pointer position into a blend of whole percentages that sum to 100.
 */

export type Point = readonly [number, number];

export interface Blend {
  tfidf: number;
  sbert: number;
  metadata: number;
}

/** Barycentric weights of `p` in triangle (a, b, c); they sum to 1. */
export function barycentric(p: Point, a: Point, b: Point, c: Point): [number, number, number] {
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);

  if (Math.abs(den) < 1e-9) return [1 / 3, 1 / 3, 1 / 3];

  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / den;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / den;

  return [wa, wb, 1 - wa - wb];
}

/**
 * The blend at point `p`, snapped to `step` percent. A point outside the
 * triangle lands on its nearest edge or corner (negative weights are cut
 * to zero and the rest rescaled).
 */
export function blendFromPoint(p: Point, a: Point, b: Point, c: Point, step = 5): Blend {
  let w = barycentric(p, a, b, c).map((v) => Math.max(0, v));
  const sum = w[0] + w[1] + w[2];

  w = sum > 0 ? w.map((v) => v / sum) : [1 / 3, 1 / 3, 1 / 3];

  let tfidf = Math.round((w[0] * 100) / step) * step;
  let sbert = Math.round((w[1] * 100) / step) * step;

  // Keep the total at 100: the third share absorbs rounding, and if that
  // would be negative the larger of the other two gives it back.
  if (tfidf + sbert > 100) {
    if (tfidf >= sbert) tfidf = 100 - sbert;
    else sbert = 100 - tfidf;
  }

  return { tfidf, sbert, metadata: 100 - tfidf - sbert };
}

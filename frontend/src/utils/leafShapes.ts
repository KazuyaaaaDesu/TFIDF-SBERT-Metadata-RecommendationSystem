/**
 * Leaf sprites that look like the real leaves.
 *
 *   maple    palmate, five pointed lobes with sinuses between them
 *   lobed    the oak's: long, rounded lobes along a midrib, narrow at the stem
 *   birch    ovate with a drawn-out point, a toothed edge, a broad base
 *   elm      oval and lopsided at the base, toothed, with parallel side veins
 *   redwood  a flat spray: a twig with short needles set along both sides
 *   bean     a broad heart-shaped leaflet with a pointed tip and side veins
 *   rose     a rose bloom seen from the front: scalloped petals round a spiral
 *   sprig    a rose's compound leaf: three oval leaflets on one stalk
 *
 * A leaf is worked out once as a list of pixels around its center, each with
 * a shade index into a five-step color ramp (0 darkest .. 4 lightest). Detail
 * scales with size: at 1-2 px a leaf is just its silhouette; veins, teeth and
 * lobe tips show up from about 3 px, and the stem from 4.
 *
 * Pure and dependency-free, so it runs under `node --test`.
 */

export type LeafShape =
  | "maple"
  | "lobed"
  | "birch"
  | "elm"
  | "redwood"
  | "bean"
  | "rose"
  | "sprig";

export interface LeafPixels {
  dx: number[];
  dy: number[];
  /** Shade index 0..4 into the ramp. */
  shade: number[];
}

interface Hit {
  /** Distance outside (<0 means inside) the leaf's edge, in pixels. */
  inside: boolean;
  /** 0 body, 1 vein, 2 stem. */
  kind: 0 | 1 | 2;
  /** Darkening near the outline (0..1). */
  rim: number;
}

const MISS: Hit = { inside: false, kind: 0, rim: 0 };
/* ------------------------------------------------------------ */
/* One shape at a time, in the leaf's own frame:                  */
/*   a runs along the leaf from the stem (a<0) toward the tip    */
/*   b runs across it. Units are pixels; r is the leaf's "radius".*/
/* ------------------------------------------------------------ */

const MAPLE_WIDTH = [0.4, 0.36, 0.36, 0.32, 0.32];
const width0 = (i: number) => MAPLE_WIDTH[i] * 0.4;

function mapleAt(a: number, b: number, r: number): Hit {
  /* The palmate junction sits a little behind the center. */
  const ox = -0.12 * r;
  const x = a - ox;
  const d = Math.hypot(x, b);
  const theta = Math.atan2(b, x);
  const R = r * 1.22;
  const lobes: [number, number, number][] = [
    [0, 1.0, 0.4],
    [1.02, 0.95, 0.36],
    [-1.02, 0.95, 0.36],
    [2.0, 0.6, 0.32],
    [-2.0, 0.6, 0.32],
  ];
  const detailed = r >= 2.6;
  let edge = R * 0.4;
  let bestLobe = 0;
  let best = -1;

  for (let i = 0; i < lobes.length; i++) {
    const [ang, len, width] = lobes[i];
    const diff = Math.abs(Math.atan2(Math.sin(theta - ang), Math.cos(theta - ang)));

    if (diff < width * 1.15) {
      const k = 1 - Math.pow(diff / (width * 1.15), 1.7);
      /* teeth along the lobe edge */
      const tooth = detailed ? 1 + 0.06 * Math.sin(diff * 26 + i) : 1;
      const e = R * (0.4 + (len - 0.4) * k) * tooth;

      if (e > edge) {
        edge = e;
        bestLobe = i;
        best = diff;
      }
    }
  }

  if (d > edge) {
    /* the stem trails behind the junction */
    if (r >= 3.8 && (theta > 2.9 || theta < -2.9)) {
      if (d < R * 0.62 && Math.abs(b) < 0.5) return { inside: true, kind: 2, rim: 0 };
    }

    return MISS;
  }

  const rim = clamp01((d - edge * 0.72) / (edge * 0.28));
  let kind: 0 | 1 = 0;

  if (r >= 4.8 && best >= 0 && best < width0(bestLobe)) {
    /* veins run out the middle of each lobe */
    const [ang] = lobes[bestLobe];
    const across = Math.abs(Math.sin(theta - ang)) * d;

    if (across < 0.42 && d < edge * 0.88 && d > R * 0.1) kind = 1;
  }

  return { inside: true, kind, rim };
}

function lobedAt(a: number, b: number, r: number): Hit {
  /* long leaf, narrow at the stem, widest two-thirds out, rounded tip */
  const L = r * 2.55;
  const t = (a + L / 2) / L;

  if (t < 0 || t > 1) return MISS;

  const body = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.85);
  const detailed = r >= 2.6;
  /* rounded lobes: wide bumps with narrow sinuses, four a side */
  const lobing = detailed
    ? 0.58 + 0.42 * Math.pow(Math.abs(Math.cos(Math.PI * (3.6 * t + 0.35))), 0.55)
    : 1;
  const half = r * 0.56 * body * (t < 0.14 ? t / 0.14 : 1) * lobing;

  if (Math.abs(b) > half) {
    if (r >= 3.8 && t < 0.07 && Math.abs(b) < 0.5) return { inside: true, kind: 2, rim: 0 };

    return MISS;
  }

  const kind: 0 | 1 = r >= 3 && Math.abs(b) < 0.4 && t > 0.05 && t < 0.93 ? 1 : 0;
  const rim = clamp01((Math.abs(b) - half * 0.7) / Math.max(0.5, half * 0.3));

  return { inside: true, kind, rim };
}

function birchAt(a: number, b: number, r: number): Hit {
  const L = r * 2.15;
  const t = (a + L / 2) / L;

  if (t < 0 || t > 1) return MISS;

  /* broad base, long tapering tip */
  const body = 1.15 * Math.pow(1 - t, 0.85) * Math.min(1, Math.pow(t / 0.16, 0.6));
  const teeth =
    r >= 2.8 ? 1 + 0.11 * (((t * L * 0.9) % 1) - 0.5) * 2 * (t > 0.08 ? 1 : 0) : 1;
  const half = r * 0.8 * body * teeth;

  if (Math.abs(b) > half) {
    if (r >= 3.8 && t < 0.06 && Math.abs(b) < 0.5) return { inside: true, kind: 2, rim: 0 };

    return MISS;
  }

  let kind: 0 | 1 = 0;

  if (r >= 3) {
    if (Math.abs(b) < 0.4 && t > 0.05 && t < 0.9) kind = 1;
  }

  return { inside: true, kind, rim: clamp01((Math.abs(b) - half * 0.72) / Math.max(0.5, half * 0.28)) };
}

function elmAt(a: number, b: number, r: number): Hit {
  const L = r * 2.2;
  const t = (a + L / 2) / L;

  if (t < 0 || t > 1) return MISS;

  const body = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.72) * (1 - 0.3 * t * t * t);
  /* lopsided base: one side runs lower and fuller than the other */
  const side = b >= 0 ? 1 : 0.8 + (t < 0.22 ? 0.35 * (1 - t / 0.22) : 0);
  const teeth =
    r >= 2.8 ? 1 + 0.09 * Math.sin(t * L * 3.1 + (b >= 0 ? 0 : 1.6)) : 1;
  const half = r * 0.74 * body * side * teeth;

  if (Math.abs(b) > half) {
    if (r >= 3.8 && t < 0.06 && Math.abs(b) < 0.5) return { inside: true, kind: 2, rim: 0 };

    return MISS;
  }

  let kind: 0 | 1 = 0;

  if (r >= 3) {
    if (Math.abs(b) < 0.4 && t > 0.04 && t < 0.94) kind = 1;
    /* parallel side veins, straight and evenly spaced */
    else if (r >= 4.5 && t > 0.12 && t < 0.86) {
      const along = (t * L) % 2.8;
      const slant = Math.abs(b) - along * 0.8;

      if (Math.abs(slant) < 0.3 && Math.abs(b) < half * 0.82) kind = 1;
    }
  }

  return { inside: true, kind, rim: clamp01((Math.abs(b) - half * 0.74) / Math.max(0.5, half * 0.26)) };
}

function redwoodAt(a: number, b: number, r: number): Hit {
  /* a frond: a thin twig with short flat needles slanting forward */
  const L = r * 2.3;
  const t = (a + L / 2) / L;

  if (t < 0 || t > 1.02) return MISS;

  if (Math.abs(b) < 0.42) return { inside: true, kind: r >= 2.6 ? 1 : 0, rim: 0 };

  /* needles come off every ~1.1 px, longest in the middle of the twig */
  const pitch = r >= 3 ? 1.1 : 1.4;
  const lenAt = r * 0.74 * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, t)));
  const slant = 0.75;
  const row = Math.abs(b);
  const along = a - slant * row;
  const phase = ((along / pitch) % 1 + 1) % 1;

  if (row <= lenAt && phase < (r >= 3 ? 0.68 : 0.8) && t - slant * row / L > 0.02) {
    return { inside: true, kind: 0, rim: clamp01(row / lenAt) };
  }

  return MISS;
}

function beanAt(a: number, b: number, r: number): Hit {
  /* a heart-shaped leaflet: broad shoulders at the base, a drawn-out tip */
  const L = r * 2.3;
  const t = (a + L / 2) / L;

  if (t < 0 || t > 1) return MISS;

  const body = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.82);
  const shoulders = 1 + 0.2 * Math.max(0, 1 - t / 0.26);
  const taper = 1 - 0.5 * Math.pow(t, 2.4);
  const half = r * 0.98 * body * shoulders * taper;
  /* a small notch where the stalk meets the blade */
  const notch = t < 0.07 && Math.abs(b) < 0.45;

  if (Math.abs(b) > half || notch) {
    if (r >= 3.8 && t < 0.06 && Math.abs(b) < 0.5) return { inside: true, kind: 2, rim: 0 };

    return MISS;
  }

  let kind: 0 | 1 = 0;

  if (r >= 3) {
    if (Math.abs(b) < 0.4 && t > 0.05 && t < 0.93) kind = 1;
    /* side veins sweep forward from the midrib */
    else if (r >= 4.5 && t > 0.14 && t < 0.88) {
      const along = (t * L) % 3;
      const slant = Math.abs(b) - along * 0.7;

      if (Math.abs(slant) < 0.28 && Math.abs(b) < half * 0.84) kind = 1;
    }
  }

  return { inside: true, kind, rim: clamp01((Math.abs(b) - half * 0.74) / Math.max(0.5, half * 0.26)) };
}

function roseAt(a: number, b: number, r: number): Hit {
  /* a bloom: five scallops round the edge, petals wound in a spiral */
  const R = r * 1.02;
  const d = Math.hypot(a, b);
  const theta = Math.atan2(b, a);
  const edge = R * (r >= 2.4 ? 0.88 + 0.12 * Math.cos(5 * theta) : 0.96);

  if (d > edge) return MISS;

  let kind: 0 | 1 = 0;

  if (r >= 2.6) {
    if (d < R * 0.2) kind = 1;
    else {
      /* the winding petal edges */
      const turn = d / (R * 0.3) + (theta / (Math.PI * 2)) * 1.6;
      const f = turn - Math.floor(turn);

      if (f < 0.16 && d > R * 0.2) kind = 1;
    }
  }

  return { inside: true, kind, rim: clamp01((d - edge * 0.7) / Math.max(0.5, edge * 0.3)) };
}

/** An oval leaflet centered `(ca, cb)`, pointing `phi`, half-length `len`, half-width `wid`. */
function leaflet(a: number, b: number, ca: number, cb: number, phi: number, len: number, wid: number) {
  const da = a - ca;
  const db = b - cb;
  const u = (da * Math.cos(phi) + db * Math.sin(phi)) / len;
  const v = (-da * Math.sin(phi) + db * Math.cos(phi)) / wid;
  /* pointed at the tip: narrower toward +u */
  const pinch = u > 0 ? 1 - 0.45 * u : 1;
  const inside = u >= -1 && u <= 1 && Math.abs(v) <= Math.max(0, pinch) * Math.sqrt(Math.max(0, 1 - u * u * 0.85));

  return { inside, u, v };
}

function sprigAt(a: number, b: number, r: number): Hit {
  /* three leaflets: a long one ahead, a pair swept back either side */
  const len = r * 0.8;
  const wid = r * 0.42;
  const parts: [number, number, number, number][] = [
    [r * 0.45, 0, 0, len],
    [-r * 0.05, r * 0.42, 0.95, len * 0.78],
    [-r * 0.05, -r * 0.42, -0.95, len * 0.78],
  ];

  for (const [ca, cb, phi, l] of parts) {
    const hit = leaflet(a, b, ca, cb, phi, l, wid * (l / len));

    if (hit.inside) {
      const kind: 0 | 1 = r >= 3 && Math.abs(hit.v) < 0.12 ? 1 : 0;

      return { inside: true, kind, rim: clamp01((Math.abs(hit.v) - 0.55) / 0.45) };
    }
  }

  /* the stalk joining them to the twig */
  if (r >= 3.4 && a < -r * 0.3 && a > -r * 1.1 && Math.abs(b) < 0.45) return { inside: true, kind: 2, rim: 0 };

  return MISS;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const SHAPES: Record<LeafShape, (a: number, b: number, r: number) => Hit> = {
  maple: mapleAt,
  lobed: lobedAt,
  birch: birchAt,
  elm: elmAt,
  redwood: redwoodAt,
  bean: beanAt,
  rose: roseAt,
  sprig: sprigAt,
};

/**
 * The pixels of one leaf of `shape` and radius `r`, turned `ph` radians,
 * lit from the upper left. `tone` (about 0.4..0.9) picks how light it sits
 * on the ramp. Offsets are from the leaf's center.
 */
export function leafPixels(
  shape: LeafShape,
  r: number,
  ph: number,
  tone: number,
): LeafPixels {
  const at = SHAPES[shape] ?? lobedAt;
  const out: LeafPixels = { dx: [], dy: [], shade: [] };
  const ext = Math.ceil(r * 1.45) + 1;
  const cos = Math.cos(ph);
  const sin = Math.sin(ph);

  for (let y = -ext; y <= ext; y++) {
    for (let x = -ext; x <= ext; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      /* into the leaf's frame: a along the leaf, b across */
      const a = px * cos + py * sin;
      const b = -px * sin + py * cos;
      const hit = at(a, b, r);

      if (!hit.inside) continue;

      const q = Math.hypot(px, py) / (r * 1.3);
      let v = tone + 0.3 * ((-px * 0.6 - py * 0.8) / (r * 1.1)) - 0.14 * q * q;

      if (hit.rim > 0 && px * 0.5 + py * 0.85 > 0) v -= 0.26 * hit.rim;

      let idx = Math.min(4, Math.max(0, Math.floor(v * 5)));

      if (hit.kind === 1) idx = Math.max(0, idx - 2);
      else if (hit.kind === 2) idx = 0;

      out.dx.push(x);
      out.dy.push(y);
      out.shade.push(idx);
    }
  }

  /* make sure even the tiniest leaf leaves a mark */
  if (out.dx.length === 0) {
    out.dx.push(0);
    out.dy.push(0);
    out.shade.push(Math.min(4, Math.max(0, Math.floor(tone * 5))));
  }

  return out;
}

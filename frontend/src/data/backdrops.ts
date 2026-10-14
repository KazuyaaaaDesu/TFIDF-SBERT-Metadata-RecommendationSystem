/* ============================================================
   BACKDROP ENGINE — a faithful port of the "Backdrops: Seven
   Scenes" reference (256 x 144, 16:9). Every scene's markers —
   palette keyframes, hill fields, clouds, sun/moon arcs, lakes,
   planets, aurora — are kept verbatim from the reference's SC
   table.

   Scenes: Meadow (default), Winter, Desert, Shore, Violet Keep,
   Rose Ruins, Frost Spire.
   ============================================================ */

import type { TreeSpeciesId } from "./knowledge";

export const BACKDROP_W = 256;
export const BACKDROP_H = 144;

export type BackdropThemeId =
  | "meadow"
  | "winter"
  | "desert"
  | "shore"
  | "violet-keep"
  | "rose-ruins"
  | "frost-spire";

export interface BackdropTheme {
  id: BackdropThemeId;
  label: string;
  price: number;
  blurb: string;
}

export const BACKDROP_THEMES: BackdropTheme[] = [
  {
    id: "meadow",
    label: "Meadow",
    price: 0,
    blurb:
      "The home scene: a wooden house on the far hill, a fence, " +
      "fireflies at dusk, and a trail through the grass.",
  },
  {
    id: "winter",
    label: "Winter",
    price: 25,
    blurb:
      "Snow on the pines and the roof, caps on the fence posts, " +
      "and slow flakes sifting down all day.",
  },
  {
    id: "desert",
    label: "Desert",
    price: 25,
    blurb:
      "Palms on the ridge, heat haze at noon, a dry trail, and " +
      "dust drifting off the dunes at dawn.",
  },
  {
    id: "shore",
    label: "Shore",
    price: 40,
    blurb:
      "A striped lighthouse, a boat crossing the bay, waves " +
      "glinting along the beach, and sea fog in the morning.",
  },
  {
    id: "violet-keep",
    label: "Violet Keep",
    price: 40,
    blurb:
      "A violet citadel above a still lake, cumulus towers in the " +
      "sky, and a ringed planet riding the dusk.",
  },
  {
    id: "rose-ruins",
    label: "Rose Ruins",
    price: 60,
    blurb:
      "Broken pillars across the rose lake, a dusty air, and a " +
      "ringed moon glowing over the ruins.",
  },
  {
    id: "frost-spire",
    label: "Frost Spire",
    price: 80,
    blurb:
      "Ice towers above a frozen reach, an aurora unrolling " +
      "through the night sky, and snow falling.",
  },
];

export const DEFAULT_BACKDROP_THEME: BackdropThemeId = "meadow";

const rng = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hx = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hash = (x: number, y: number) => {
  let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);
  h ^= h >>> 13;
  return (h & 0xffff) / 65535;
};
const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));
const vn = (x: number, y: number) => {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const mix = (a: number[], b: number[], f: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * f));
const mul = (c: number[], k: number) =>
  c.map((v) => clamp(Math.round(v * k), 0, 255));

const R = rng(11);

/* scene markers, verbatim */
interface SceneMarker {
  n: BackdropThemeId;
  k: string[];
  f: number[];
  m: number[];
  cl: number;
  tf: number[];
  fx: string;
  fl?: number;
  fence?: number;
  bd?: number;
  cap?: number[];
  pc?: number[];
  cu?: number;
  sw?: number;
  lake?: number;
  wl?: number;
  au?: number;
  pl?: number[];
}

const SC: SceneMarker[] = [
  {
    n: "meadow",
    k: [
      "0 #0e1018 #2a3040 #20252f #1a1f27 #2f3d38 #232420 #3c4254 1",
      ".27 #7d8aa0 #e0c0a4 #8a8c98 #5f6a68 #77876a #4a4538 #e8d0b8 0",
      ".5 #9db0b8 #d8dfd6 #a1b1ad #7f9080 #7f8f6e #6a6a58 #f4f4ee 0",
      ".74 #a3a8b4 #e8d2b0 #a09ea8 #7d8774 #8b9468 #6a5f4c #f0dcc0 0",
      ".84 #3a3458 #c98f78 #5a4a6c #3e3a50 #5a6558 #38333a #b88c8c .3",
    ],
    f: [66, 16, 0.02, 0],
    m: [80, 6, 0.03],
    cl: 0.58,
    tf: [120, 140, 92],
    fx: "ff",
    fl: 1,
    fence: 1,
    bd: 1,
  },
  {
    n: "winter",
    k: [
      "0 #0b1020 #26324a #1e2638 #171d2c #3a4660 #262e44 #38425c 1",
      ".27 #8a98b8 #f0d0c0 #98a0b8 #7a8498 #d8dce8 #a8b0c4 #f4e0d8 0",
      ".5 #a8c0d8 #e6eef4 #b4c4d4 #94a8bc #f2f6fa #c4d0de #ffffff 0",
      ".74 #98a4c4 #f4d0b4 #a8a4bc #8c92aa #f0e8ee #bcb8d0 #f8dcc8 0",
      ".84 #3a3a68 #d08a90 #5a5078 #484468 #9890b0 #5c5478 #c898a8 .3",
    ],
    f: [64, 16, 0.02, 0],
    m: [82, 5, 0.03],
    cl: 0.52,
    tf: [96, 86, 78],
    fx: "sn",
    fence: 1,
    cap: [240, 244, 250],
    pc: [30, 50, 52],
  },
  {
    n: "desert",
    k: [
      "0 #120e1c #3a2a40 #2a1e30 #20182a #4a3a3c #2c2228 #483c54 1",
      ".27 #6a6a9a #f0a880 #9a6a70 #7a5660 #c89870 #8a6458 #f4b090 0",
      ".5 #7ab4e0 #f4e0b4 #c08858 #d8a868 #ecc888 #c0905c #ffffff 0",
      ".74 #8a80b8 #ffb870 #b0705a #c88c58 #e8b070 #a87050 #ffc890 0",
      ".84 #3c2c68 #e0705a #6a3a58 #5a3450 #a8606a #5a3040 #d87888 .3",
    ],
    f: [56, 22, 0.012, 3],
    m: [84, 8, 0.018],
    cl: 0.7,
    tf: [126, 96, 62],
    fx: "du",
    pc: [78, 110, 64],
  },
  {
    n: "shore",
    k: [
      "0 #0c1222 #263450 #16243c #2a2c3a #3c4050 #262836 #34405c 1",
      ".27 #7a8cb8 #f4c0a8 #6a86a8 #b8a090 #d0b8a0 #9a8474 #f8d8c8 0",
      ".5 #6aaee0 #d8f0f4 #4a90b8 #d8cca8 #ecdcb4 #bca884 #ffffff 0",
      ".74 #8a96c8 #ffd0a0 #6a88b0 #e0c4a0 #f0d0a8 #b89c80 #ffe4c8 0",
      ".84 #3a3668 #e8907a #4a5478 #7a6470 #9c8088 #54444e #d89098 .3",
    ],
    f: [70, 0, 0, 0],
    m: [90, 9, 0.02],
    cl: 0.6,
    tf: [110, 140, 88],
    fx: "",
    bd: 1,
  },
  {
    n: "violet-keep",
    k: [
      "0 #0e0c22 #3a2a60 #231a42 #1a1432 #234a42 #120c30 #2a2258 1",
      ".27 #8a7ab0 #f0b0b8 #9a7ab0 #7a6a90 #6ab090 #4a3a88 #9a88d0 0",
      ".5 #8fa0c8 #dcc8e0 #9a88c0 #7a7098 #6ac098 #4a4a98 #9a90e0 0",
      ".74 #8a78b0 #f0a8a0 #9a70a8 #75608c #7ab890 #44308a #8870d0 0",
      ".84 #3a2a68 #d878a0 #5a3a78 #4a3068 #3a7868 #2a1c5c #6a4aa8 .3",
    ],
    f: [80, 6, 0.03, 0],
    m: [100, 0, 0.03],
    cu: 1,
    sw: 1,
    lake: 1,
    wl: 90,
    pl: [150, 4, 36],
    tf: [100, 170, 130],
    fx: "ff",
    bd: 1,
    cl: 0.6,
  },
  {
    n: "rose-ruins",
    k: [
      "0 #140c1c #4a2438 #2c1830 #201226 #2a3a38 #1a0e22 #3c2048 1",
      ".27 #b0809c #ffc0a0 #b8788c #8a5a6c #7a9a78 #6a3a68 #d890a8 0",
      ".5 #d09ab0 #ffd8c0 #c88aa0 #9a6a7c #88b080 #8a5a90 #e8a0b8 0",
      ".74 #c8788c #ffb078 #b86a7c #8a4a5c #8aa468 #6a3a6c #f0907c 0",
      ".84 #50305c #f07a78 #6a3050 #4a2444 #4a6a50 #3a1c50 #c05a80 .3",
    ],
    f: [80, 6, 0.03, 0],
    m: [100, 0, 0.03],
    cu: 1,
    sw: 1,
    lake: 1,
    wl: 90,
    pl: [196, 32, 15, 1],
    tf: [150, 170, 110],
    fx: "du",
    cl: 0.6,
  },
  {
    n: "frost-spire",
    k: [
      "0 #070c1c #1a2e4a #14233c #101a2e #2a4a5a #0e1a3a #223a5c 1",
      ".27 #7a9ac0 #e8d0e0 #8aa8c8 #6a88a8 #8ac0c0 #3a5a90 #c8d8f0 0",
      ".5 #78b0e0 #dcf0f8 #8ac0e0 #6a98c0 #9ad4d0 #3a70b0 #f0f8ff 0",
      ".74 #8a9cd0 #f4d8e8 #9aa8d0 #7a88b8 #9ac8c8 #4a60a0 #e8e4f8 0",
      ".84 #2a3470 #c880c0 #4a4890 #383c78 #5a9aa0 #24306c #8878c8 .3",
    ],
    f: [80, 6, 0.03, 0],
    m: [100, 0, 0.03],
    cu: 1,
    au: 1,
    lake: 1,
    wl: 90,
    tf: [170, 220, 225],
    fx: "sn",
    cl: 0.6,
  },
];

interface Keyframe {
  at: number;
  colors: number[][];
  stars: number;
}

interface Scene {
  n: BackdropThemeId;
  K: Keyframe[];
  cl: number;
  tf: number[];
  fx: string;
  fl: number;
  fence: number;
  bd: number;
  cap: number[];
  pc: number[];
  cu: number;
  sw: number;
  lake: number;
  wl: number;
  au: number;
  pl: number[] | null;
  HF: number[];
  HM: number[];
  FP: number[][];
  MP: number[][];
  TF: number[][];
}

const parseKeys = (marker: SceneMarker): Keyframe[] =>
  marker.k
    .concat([marker.k[0].replace(/^\S+/, "1")])
    .map((s) => {
      const p = s.split(" ");
      return {
        at: +p[0],
        colors: p.slice(1, 8).map(hx),
        stars: +p[8],
      };
    });

export function buildScene(id: BackdropThemeId): Scene {
  const S = SC.find((marker) => marker.n === id) ?? SC[0];
  const Q = rng(31 + SC.indexOf(S));
  const [fb, fa, ff, fq] = S.f;
  const [mb, ma, mf] = S.m;

  const HF: number[] = [];
  const HM: number[] = [];
  const FP: number[][] = [];
  const MP: number[][] = [];
  const TF: number[][] = [];

  for (let x = 0; x < BACKDROP_W; x += 1) {
    let v = vn(x * ff, 1);
    if (fq) v = clamp((v - 0.5) * fq + 0.5, 0, 1);
    HF[x] = Math.round(fb + v * fa + (fa ? vn(x * 0.08, 4) * 3 : 0));
    if (S.lake) {
      HM[x] = Math.round(
        106 + Math.pow(Math.abs(x - 128) / 128, 2) * 36 + vn(x * 0.08, 5) * 3,
      );
    } else {
      HM[x] = Math.round(
        mb + vn(x * mf + 7, 3) * ma + vn(x * 0.1, 9) * 2,
      );
    }
  }

  if (S.n === "meadow" || S.n === "winter") {
    const pine = S.n === "winter";
    for (let k = 0; k < 40; k += 1) {
      const x = 3 + Math.floor(Q() * 250);
      const b = HF[x];
      const h = pine ? 7 + Math.floor(Q() * 6) : 4 + Math.floor(Q() * 4);
      if (pine || Q() < 0.5) {
        for (let j = 0; j < h; j += 1)
          for (let d = -(j >> 1); d <= j >> 1; d += 1)
            FP.push([x + d, b - h + j]);
      } else {
        const r = 2 + (Q() < 0.4 ? 1 : 0);
        FP.push([x, b - 1], [x, b - 2]);
        for (let dy = -r; dy <= r; dy += 1)
          for (let dx = -r; dx <= r; dx += 1)
            if (dx * dx + dy * dy <= r * r + 1)
              FP.push([x + dx, b - 3 - r + dy]);
      }
    }
  }

  if (S.n === "winter") {
    for (let k = 0; k < 10; k += 1) {
      const x = k < 5 ? 4 + Math.floor(Q() * 40) : 212 + Math.floor(Q() * 40);
      const b = HM[x] + 4;
      const h = 20 + Math.floor(Q() * 10);
      for (let j = 0; j < h; j += 1)
        for (let d = -Math.floor(j / 3); d <= Math.floor(j / 3); d += 1)
          MP.push([x + d, b - h + j]);
    }
  }

  if (S.n === "desert") {
    for (const x of [30, 70, 100, 180, 226, 246]) {
      const b = HM[x] + 8;
      const h = 12 + Math.floor(Q() * 6);
      const y0 = b - Math.floor(h * 0.6);
      for (let y = b - h; y <= b; y += 1) MP.push([x, y], [x + 1, y]);
      for (let d = 1; d <= 3; d += 1) MP.push([x - d, y0]);
      for (let y = y0 - 4; y <= y0; y += 1) MP.push([x - 3, y]);
      for (let d = 2; d <= 4; d += 1) MP.push([x + d, y0 - 2]);
      for (let y = y0 - 6; y <= y0 - 2; y += 1) MP.push([x + 4, y]);
    }
  }

  for (let k = 0; k < 110; k += 1) {
    const x = Math.floor(Q() * BACKDROP_W);
    const y = 94 + Math.floor(Q() * 48);
    if (y > HM[x] + 3) TF.push([x, y, Q()]);
  }
  TF.sort((a, b) => a[1] - b[1]);

  return {
    n: S.n,
    K: parseKeys(S),
    cl: S.cl,
    tf: S.tf,
    fx: S.fx,
    fl: S.fl ?? 0,
    fence: S.fence ?? 0,
    bd: S.bd ?? 0,
    cap: S.cap ?? [0, 0, 0],
    pc: S.pc ?? [0, 0, 0],
    cu: S.cu ?? 0,
    sw: S.sw ?? 0,
    lake: S.lake ?? 0,
    wl: S.wl ?? 0,
    au: S.au ?? 0,
    pl: S.pl ?? null,
    HF,
    HM,
    FP,
    MP,
    TF,
  };
}

function pal(t: number, K: Keyframe[]) {
  let i = 0;
  while (i < K.length - 2 && t >= K[i + 1].at) i += 1;
  const a = K[i];
  const b = K[i + 1];
  const f = (t - a.at) / (b.at - a.at);
  const s = f * f * (3 - 2 * f);
  return {
    c: a.colors.map((col, j) => mix(col, b.colors[j], s)),
    st: a.stars + (b.stars - a.stars) * s,
  };
}

/* stars, fireflies, birds, weather particles, cumulus clusters */
const ST: number[][] = [];
const FF: number[][] = [];
const BD: number[][] = [];
const PK: number[][] = [];
const CU: Array<{ x: number; y: number; blobs: number[][]; sp: number }> = [];
for (let i = 0; i < 140; i += 1)
  ST.push([Math.floor(R() * BACKDROP_W), Math.floor(R() * 80), R(), R() * 6.28]);
for (let i = 0; i < 24; i += 1)
  FF.push([
    R() * BACKDROP_W,
    96 + R() * 40,
    10 + R() * 24,
    2 + R() * 6,
    R() * 6 + 2,
    R() * 6 + 2,
    R() * 6.28,
  ]);
for (let i = 0; i < 5; i += 1)
  BD.push([R() * BACKDROP_W, 16 + R() * 34, 4 + R() * 3, R() * 6]);
for (let i = 0; i < 100; i += 1)
  PK.push([R() * BACKDROP_W, R() * BACKDROP_H, 8 + R() * 14, R() * 6.28]);
for (let i = 0; i < 7; i += 1) {
  const blobs: number[][] = [];
  for (let k = 0; k < 10; k += 1)
    blobs.push([
      (R() - 0.5) * [70, 60, 50, 56, 50, 44, 30][i],
      -R() * [44, 36, 30, 40, 18, 16, 14][i],
      6 + R() * (i < 4 ? 11 : 6),
    ]);
  CU.push({
    x: [30, 100, 160, 230, 70, 200, 20][i],
    y: [84, 78, 70, 76, 40, 36, 30][i],
    blobs,
    sp: 2 + R() * 3,
  });
}

const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bay = (x: number, y: number) =>
  (BY[(x & 3) + ((y & 3) << 2)] + 0.5) / 16;

function disc(
  put: (x: number, y: number, c: number[]) => void,
  cx: number,
  cy: number,
  r: number,
  col: number[],
  gr: number,
  gc: number[],
) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  for (let dy = -gr; dy <= gr; dy += 1)
    for (let dx = -gr; dx <= gr; dx += 1) {
      const d = Math.hypot(dx, dy);
      if (d <= r) put(cx + dx, cy + dy, col);
      else if (
        d < gr &&
        (cy + dy) % 2 === 0 &&
        hash((cx + dx) >> 1, cy + dy) < (1 - (d - r) / (gr - r)) * 0.95
      )
        put(cx + dx, cy + dy, gc);
    }
}

function house(
  put: (x: number, y: number, c: number[]) => void,
  HF: number[],
  x0: number,
  w: number,
  bc: number[],
  rc: number[],
  st: number,
  b0?: number,
) {
  const bb = b0 ?? Math.max(...HF.slice(x0 - 1, x0 + w + 1)) + 1;
  for (let x = x0; x < x0 + w; x += 1)
    for (let y = bb - 8; y < bb; y += 1) put(x, y, bc);
  for (let k = 0; k < 5; k += 1)
    for (let x = x0 + k; x < x0 + w - k; x += 1) put(x, bb - 9 - k, rc);
  if (st > 0.5) {
    put(x0 + 3, bb - 5, [255, 200, 110]);
    put(x0 + w - 4, bb - 5, [255, 200, 110]);
  }
}

/* The camera only starts its upward zoom once the tree's growth
   timeline passes this fraction (mirrors PixelGrowthTree's own PA
   phase boundary) — elevation parallax and the cloud-sea haze both
   key off it, so neither kicks in until the view actually begins
   rising. */
const ASCENT_START = 0.46;

/* Per-species character for the haze-leaves: a distinct palette
   and tiny silhouette per tree, so what drifts through the air
   while climbing reads as "this species," not a generic scene
   ornament. */
const SPECIES_HAZE: Record<
  TreeSpeciesId,
  { colors: number[][]; shape: "star" | "lobed" | "oval" | "leaf" | "needle" | "heart" | "petal" }
> = {
  crimson: {
    colors: [[196, 42, 28], [227, 122, 30], [242, 197, 88]],
    shape: "star",
  },
  oak: {
    colors: [[79, 168, 62], [47, 122, 46]],
    shape: "lobed",
  },
  birch: {
    colors: [[223, 196, 56], [244, 222, 120]],
    shape: "oval",
  },
  elm: {
    colors: [[214, 168, 40], [150, 120, 30]],
    shape: "leaf",
  },
  redwood: {
    colors: [[60, 110, 70], [40, 80, 55]],
    shape: "needle",
  },
  beanstalk: {
    colors: [[92, 194, 58], [182, 240, 106]],
    shape: "heart",
  },
  rosevine: {
    colors: [[216, 31, 91], [255, 143, 180]],
    shape: "petal",
  },
};

/* Stamps a tiny per-species silhouette at (x, y) — a few `put()`
   calls arranged to read as a leaf type at a glyph's distance,
   not just a tinted dot. `c0`/`c1` are already depth/light-shaded;
   `spin` (-1/1) flips the asymmetric shapes frame to frame. */
function stampHazeLeaf(
  put: (x: number, y: number, c: number[]) => void,
  x: number,
  y: number,
  shape: string,
  c0: number[],
  c1: number[],
  spin: number,
) {
  const xi = x | 0;
  const yi = y | 0;
  const sx = spin > 0 ? 1 : -1;
  switch (shape) {
    case "star":
      /* maple: a little five-point whirl */
      put(xi, yi, c0);
      put(xi + sx, yi, c1);
      put(xi, yi - 1, c1);
      put(xi, yi + 1, c0);
      break;
    case "lobed":
      /* oak: a chunky blob with a stem fleck */
      put(xi, yi, c0);
      put(xi + 1, yi, c0);
      put(xi, yi + 1, c1);
      break;
    case "oval":
      /* birch: a thin pale streak */
      put(xi, yi, c1);
      put(xi, yi + 1, c0);
      break;
    case "needle":
      /* redwood: a short vertical sliver */
      put(xi, yi - 1, c1);
      put(xi, yi, c0);
      put(xi, yi + 1, c1);
      break;
    case "heart":
      /* beanstalk: a broad leaf, two pixels wide with a stem fleck */
      put(xi, yi, c0);
      put(xi + sx, yi, c0);
      put(xi, yi + 1, c1);
      break;
    case "petal":
      /* rose: a small curled petal, a bright speck over a dark one */
      put(xi, yi, c1);
      put(xi + sx, yi + 1, c0);
      break;
    default:
      /* elm: a simple diagonal pair */
      put(xi, yi, c0);
      put(xi + sx, yi, c1);
  }
}

/* Renders one frame of a scene into an ImageData buffer.

   `parallax` (0..1, the tree's growth) drives a depth parallax —
   but only once the camera begins its upward zoom (ASCENT_START):
   as the tree rises, the near ground leads, the mid band (lakes,
   shores) follows, and the far hills lag — the sky stays put. The
   ground extends downward seamlessly, so the stage never gaps. */
export function renderFrame(
  dst: Uint8ClampedArray,
  scene: Scene,
  t: number,
  tm: number,
  parallax = 0,
  speciesId?: TreeSpeciesId,
  /** Scenery layers the player has switched off: clouds, weather,
   *  fireflies, fence, house. */
  off?: ReadonlySet<string>,
) {
  const hidden = (id: string) => off?.has(id) === true;
  const W = BACKDROP_W;
  const H = BACKDROP_H;
  const S = scene;
  const { c: [top, bot, far, mid, grass, soil, cloud], st } = pal(t, S.K);
  const sea = S.n === "shore";
  const Sk: number[][] = [];
  for (let i = 0; i < 7; i += 1) Sk.push(mix(top, bot, i / 6));

  /* Layer offsets: far lags, mid follows, near leads. Holds at
     zero until the camera actually starts rising (ASCENT_START),
     then ramps across the rest of the climb — no elevation shift
     during ordinary growth. */
  const ease = (u: number) => u * u * (3 - 2 * u);
  const P = ease(clamp((parallax - ASCENT_START) / (1 - ASCENT_START), 0, 1));
  const oFar = Math.round(3.5 * P);
  const oMid = Math.round(6 * P);
  const oNear = Math.round(10 * P);

  const put = (x: number, y: number, c: number[]) => {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    dst[o] = c[0];
    dst[o + 1] = c[1];
    dst[o + 2] = c[2];
    dst[o + 3] = 255;
  };
  const get = (x: number, y: number): number[] => {
    const o = (y * W + x) * 4;
    return [dst[o], dst[o + 1], dst[o + 2]];
  };

  const sky2 = () => {
    if (S.sw)
      for (let y = 0; y < 76; y += 1)
        for (let x = 0; x < W; x += 1) {
          const n = vn(x * 0.012 + y * 0.006 + tm * 0.015, y * 0.07);
          if (n > 0.6 && n < 0.66) put(x, y, mix(get(x, y), bot, 0.5));
        }
    if (S.au)
      for (let x = 0; x < W; x += 1) {
        const c = 30 + Math.sin(x * 0.03 + tm * 0.4) * 8 + vn(x * 0.02 + tm * 0.1, 3) * 10;
        for (let y = Math.floor(c); y < c + 26; y += 1) {
          const k = (y - c) / 26;
          if (bay(x, y) < (1 - k) * 0.75 * (0.3 + 0.7 * st))
            put(x, y, mix(get(x, y), mix([110, 255, 190], [170, 120, 255], k), 0.6));
        }
      }
    if (S.pl) {
      const [px, py, pr, rg] = S.pl;
      const pb = mix(bot, [220, 110, 170], 0.45);
      const pd = mul(mix(top, pb, 0.5), 0.6);
      for (let y = py - pr; y <= py + pr; y += 1)
        for (let x = px - pr; x <= px + pr; x += 1) {
          const dx = x - px;
          const dy = y - py;
          if (Math.hypot(dx, dy) > pr) continue;
          const b = Math.sin(dy * 0.45 + vn((x + tm * 0.6) * 0.05, y * 0.12) * 4);
          const sh = (dx * 0.55 + dy * 0.4) / pr;
          let c2 = b > 0.2 ? pb : mix(pb, pd, 0.55);
          if (sh > 0.35) c2 = mul(c2, 0.62);
          else if (sh > 0.1 && bay(x, y) < 0.5) c2 = mul(c2, 0.8);
          put(x, y, c2);
        }
      if (rg) {
        const a = pr * 1.9;
        const b = pr * 0.38;
        const rc = mix([250, 220, 200], bot, 0.3);
        for (let x = px - Math.ceil(a); x <= px + a; x += 1)
          for (let y = py - Math.ceil(b); y <= py + b; y += 1) {
            const e = Math.hypot((x - px) / a, (y - py) / b);
            if (e > 0.62 && e < 1 && (y > py || Math.hypot(x - px, y - py) > pr))
              put(x, y, e < 0.75 ? mul(rc, 0.7) : bay(x, y) < 0.6 ? rc : mul(rc, 0.85));
          }
      }
    }
  };

  for (let y = 0; y < H; y += 1) {
    const q = Math.pow(Math.min(1, y / 110), 1.5) * 6;
    const i = q | 0;
    for (let x = 0; x < W; x += 1)
      put(x, y, Sk[Math.min(6, q - i > bay(x, y) ? i + 1 : i)]);
  }

  for (const [x, y, th, ph] of ST)
    if (th < st)
      put(
        x,
        y,
        Math.sin(tm * 2.2 + ph) > -0.4 ? [255, 250, 235] : [150, 146, 190],
      );

  sky2();

  const s = (t - 0.2) / 0.62;
  if (s > 0 && s < 1) {
    const hh = Math.sin(Math.PI * s);
    const sc = mix([236, 150, 110], [250, 244, 220], clamp(hh * 1.7, 0, 1));
    disc(put, 14 + s * 228, 88 - hh * 70, 8, sc, 22, mix(bot, sc, 0.5));
  }

  const mt = t >= 0.8 ? (t - 0.8) / 0.4 : t < 0.2 ? (t + 0.2) / 0.4 : -1;
  if (mt >= 0) {
    const hh = Math.sin(Math.PI * mt);
    const mx = Math.round(14 + mt * 228);
    const my = Math.round(84 - hh * 62);
    disc(put, mx, my, -1, [0, 0, 0], 14, mix(top, [150, 140, 210], 0.45));
    for (let dy = -7; dy <= 7; dy += 1)
      for (let dx = -7; dx <= 7; dx += 1)
        if (Math.hypot(dx, dy) <= 5.6 && Math.hypot(dx - 2.8, dy + 1.8) > 4.8)
          put(mx + dx, my + dy, [238, 234, 250]);
  }

  if (S.cu && !hidden("clouds")) {
    const CMK = new Uint8Array(W * H);
    for (const { x, y: yb, blobs, sp } of CU) {
      const ox = (x + tm * sp + 80) % (W + 160) - 80;
      for (const [dx, dy, r] of blobs) {
        const cx = Math.round(ox + dx);
        const cy = Math.round(yb + dy);
        for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y += 1)
          for (let xx = Math.max(0, cx - r); xx <= Math.min(W - 1, cx + r); xx += 1)
            if ((xx - cx) ** 2 + (y - cy) ** 2 <= r * r) CMK[y * W + xx] = 1;
      }
    }
    const hi = mix(cloud, [255, 255, 255], 0.24);
    const sh = mul(mix(cloud, top, 0.25), 0.74);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1)
        if (CMK[y * W + x]) {
          const ul = x > 1 && y > 1 && !CMK[(y - 2) * W + x - 2];
          const dn = y + 3 < H && !CMK[(y + 3) * W + x + 1];
          put(x, y, ul ? hi : dn ? sh : vn(x * 0.12, y * 0.14) > 0.72 ? mul(cloud, 0.92) : cloud);
        }
  } else {
    const CM = new Uint8Array(W * 34);
    [
      [24, 1.4, 0.03, S.cl, 1],
      [46, 0.7, 0.022, S.cl + 0.04, 0.75],
    ].forEach(([yc, sp, sc, th, a], k) => {
      const y0 = yc - 16;
      const cc = mix(bot, cloud, a);
      for (let y = 0; y < 34; y += 1)
        for (let x = 0; x < W; x += 1)
          CM[y * W + x] =
            vn((x + tm * sp) * sc + k * 9, (y0 + y) * 0.12) -
              (0.4 * Math.abs(y - 16)) / 16 >
            th
              ? 1
              : 0;
      for (let y = 1; y < 33; y += 1)
        for (let x = 0; x < W; x += 1)
          if (CM[y * W + x])
            put(
              x,
              y0 + y,
              !CM[(y - 1) * W + x]
                ? mix(cc, [255, 255, 255], 0.35)
                : !CM[(y + 1) * W + x]
                  ? mul(cc, 0.74)
                  : cc,
            );
    });
  }

  if (S.bd && st < 0.3)
    BD.forEach(([x0, y, sp, ph]) => {
      const x = (x0 + tm * sp) % (W + 20) - 10;
      const f = Math.sin(tm * 9 + ph) > 0 ? -1 : 1;
      const bc = [44, 40, 70];
      put(x, y, bc);
      put(x - 1, y + f, bc);
      put(x + 1, y + f, bc);
      put(x - 2, y + 2 * f, bc);
      put(x + 2, y + 2 * f, bc);
    });

  for (let x = 0; x < W; x += 1)
    for (let y = S.HF[x]; y < (S.wl || S.HM[x]); y += 1) {
      let c = far;
      if (y === S.HF[x]) c = mul(far, 1.25);
      else if (sea) {
        c = mul(far, 1 - (0.18 * (y - S.HF[x])) / (S.HM[x] - S.HF[x] + 1));
        if (Math.sin(x * 0.35 + tm * 1.6 + y * 1.3) > 0.93) c = mul(far, 1.5);
      } else if (bay(x, y) < (y - S.HF[x]) * 0.02) c = mul(far, 0.88);
      put(x, y - oFar, c);
    }

  const tc = mul(far, 0.74);
  for (const [x, y] of S.FP) put(x, y - oFar, tc);

  const putFar = (x: number, y: number, c: number[]) => put(x, y - oFar, c);
  if (S.n === "meadow" && !hidden("house")) house(putFar, S.HF, 194, 14, mul(far, 0.7), mul(far, 1.22), st);
  if (S.n === "winter" && !hidden("house")) house(putFar, S.HF, 200, 14, mul(far, 0.72), [236, 240, 248], st);

  if (S.lake) {
    const C = { bot, far, mid, grass, soil };
    const WL = S.wl;
    const lit = 1 - 0.6 * st;
    const wall = mul(mix([250, 228, 224], bot, 0.2), lit);
    const rc = mul(mix(far, [34, 24, 40], 0.65), 1 - 0.5 * st);
    const wn = st > 0.5 ? [255, 208, 130] : [150, 66, 104];
    const gc = mul(grass, 0.6 + 0.4 * (1 - st));

    const blk = (a: number, b: number, y0: number, y1: number) => {
      for (let x = a; x <= b; x += 1)
        for (let y = y0; y <= y1; y += 1) {
          let q = x - a < 2 ? mul(wall, 1.08) : b - x < 2 ? mul(wall, 0.8) : wall;
          if (hash(x, y) < 0.12) q = mul(q, 0.9);
          put(x, y, q);
        }
      for (let x = a + 2; x < b - 1; x += 4)
        for (let y = y0 + 6; y < y1 - 4; y += 10)
          for (let k = 0; k < 3; k += 1) put(x, y + k, wn);
    };
    const cone = (cx: number, y0: number, hw: number, h: number, col?: number[]) => {
      const c2 = col ?? rc;
      for (let k = 0; k < h; k += 1) {
        const w = Math.round((hw * k) / h);
        for (let x = cx - w; x <= cx + w; x += 1)
          put(x, y0 + k, x < cx ? mul(c2, 1.15) : c2);
      }
      for (let k = 1; k <= 3; k += 1) put(cx, y0 - k, c2);
    };
    const hip = (a: number, b: number, y0: number, h: number) => {
      for (let k = 0; k < h; k += 1) {
        const q = h - 1 - k;
        for (let x = a - 3 + q; x <= b + 3 - q; x += 1)
          put(x, y0 + k, k === 0 ? mul(rc, 1.3) : rc);
      }
    };
    const blob = (x: number, y: number, r: number) => {
      for (let dy = -r; dy <= r; dy += 1)
        for (let dx = -r; dx <= r; dx += 1)
          if (dx * dx + dy * dy <= r * r)
            put(x + dx, y + dy, dy < 0 && dx < 1 ? mul(gc, 1.2) : gc);
    };
    const isl = (a: number, b: number, hm: number) => {
      for (let x = a; x <= b; x += 1) {
        const u = (x - a) / (b - a);
        const h = Math.round(Math.pow(Math.sin(Math.PI * u), 0.6) * hm + vn(x * 0.2, 3) * 3);
        for (let y = WL - h; y <= WL; y += 1) {
          const r = hash(x, y);
          put(x, y, r < 0.2 ? mul(mid, 0.8) : r > 0.82 ? mix(mid, [170, 160, 190], 0.5) : mid);
        }
      }
    };

    if (S.n === "violet-keep") {
      const bw = mix(wall, far, 0.35);
      const cb = WL - 12;
      for (let x = 52; x <= 170; x += 1) {
        for (let y = WL - 9; y <= WL; y += 1) put(x, y, bw);
        if ((x >> 2) % 2 === 1) put(x, WL - 10, bw);
      }
      for (let k = 0; k < 4; k += 1) {
        const ax = 70 + k * 27;
        for (let x = ax - 7; x <= ax + 7; x += 1)
          for (let y = WL - 9; y <= WL; y += 1)
            if (Math.hypot(x - ax, (y - WL) * 1.2) < 7)
              put(x, y, mul(mix(soil, far, 0.3), 0.8));
      }
      house(put, S.HF, 8, 12, mix(wall, far, 0.3), mul(rc, 1.6), st, WL - 1);
      house(put, S.HF, 26, 10, mix(wall, far, 0.3), mul(rc, 1.6), st, WL - 1);
      blk(38, 43, WL - 22, WL - 1);
      cone(40, WL - 30, 4, 8);
      blob(20, WL - 4, 4);
      blob(48, WL - 3, 4);
      isl(176, 254, 16);
      blk(194, 213, cb - 22, cb);
      hip(194, 213, cb - 28, 6);
      blk(224, 242, cb - 16, cb);
      hip(224, 242, cb - 22, 6);
      blk(186, 194, cb - 30, cb);
      cone(190, cb - 42, 6, 12);
      blk(214, 223, cb - 48, cb);
      cone(218, cb - 66, 7, 18);
      for (let y = cb - 12; y <= cb; y += 1)
        for (let x = 203; x <= 206; x += 1)
          if (y > cb - 9 || Math.hypot(x - 204.5, y - cb + 8) < 2.5)
            put(x, y, mul(wall, 0.35));
      blob(200, cb + 1, 4);
      blob(233, cb + 2, 3);
      blob(251, WL - 6, 3);
    }
    if (S.n === "rose-ruins") {
      isl(6, 96, 14);
      const cb = WL - 10;
      const hs = [24, 30, 18, 28, 12, 22, 26];
      for (let k = 0; k < 7; k += 1) {
        const x = 14 + k * 11;
        const h = hs[k];
        blk(x, x + 3, cb - h, cb);
        blk(x - 1, x + 4, cb - h - 2, cb - h);
      }
      for (const k of [0, 3, 5]) {
        const x = 14 + k * 11;
        for (let xx = x + 4; xx < x + 11; xx += 1)
          for (let y = cb - hs[k] - 1; y <= cb - hs[k] + 1; y += 1)
            put(xx, y, wall);
      }
      blk(88, 92, cb - 40, cb);
      cone(90, cb - 48, 2, 8, wall);
      blob(10, cb + 1, 3);
      blob(58, cb + 2, 3);
      blob(94, cb + 2, 3);
    }
    if (S.n === "frost-spire") {
      isl(150, 252, 12);
      const ice = mul(mix([205, 232, 255], bot, 0.3), Math.min(1, lit + 0.2));
      [
        [166, 5, 24],
        [182, 7, 36],
        [198, 9, 52],
        [214, 6, 30],
        [232, 8, 42],
        [246, 5, 20],
      ].forEach(([x, hw, h]) => cone(x, WL - 8 - h, hw, h, ice));
    }
  }

  if (sea) {
    const hb = S.HF[214];
    const dk = 1 - 0.5 * st;
    for (let x = 208; x <= 220; x += 1)
      for (let y = hb - 1; y <= hb + 1; y += 1) put(x, y - oFar, mul(far, 0.6));
    for (let y = hb - 20; y < hb - 1; y += 1) {
      const hw = 2 + Math.floor(((y - hb + 20) / 20) * 1.5);
      for (let x = 214 - hw; x <= 214 + hw; x += 1)
        put(
          x,
          y - oFar,
          mul(Math.floor((hb - y) / 4) % 2 ? [220, 70, 60] : [240, 236, 230], dk),
        );
    }
    for (let y = hb - 23; y <= hb - 21; y += 1)
      for (let x = 212; x <= 216; x += 1)
        put(x, y - oFar, st > 0.5 ? [255, 236, 150] : [120, 130, 140]);
    for (let x = 213; x <= 215; x += 1) put(x, hb - 24 - oFar, [60, 50, 60]);
    if (st > 0.5) {
      const dir = Math.sin(tm * 0.7) > 0 ? -1 : 1;
      for (let dx = 2; dx < 70; dx += 1)
        for (let dy = -Math.floor(dx * 0.12); dy <= Math.floor(dx * 0.12); dy += 1) {
          const x = 214 + dir * dx;
          const y = hb - 22 + dy;
          if (x >= 0 && x < W && bay(x, y) < 0.45 * (1 - dx / 70))
            put(x, y - oFar, mix(get(x, y), [255, 240, 170], 0.3));
        }
    }
    const bx = ((tm * 2.5 + 40) % 300) - 30;
    for (let x = 0; x < 7; x += 1) {
      put(bx + x, 76, [96, 64, 44]);
      put(bx + x, 77, [96, 64, 44]);
    }
    for (let j = 0; j < 6; j += 1) {
      put(bx + 2, 75 - j, [96, 64, 44]);
      for (let i = 0; i <= (5 - j) >> 1; i += 1)
        put(bx + 3 + i, 75 - j, [240, 236, 226]);
    }
  }

  for (let y = 70; y < 96; y += 1)
    for (let x = 0; x < W; x += 1)
      if ((x + y) % 2 === 0 && hash(x >> 3, y) < 0.4)
        put(x, y, mix(get(x, y), bot, 0.3));

  if (S.lake)
    for (let y = S.wl; y < H; y += 1) {
      const k = y - S.wl;
      const ys = Math.max(0, S.wl - 1 - Math.floor(k * 0.9));
      for (let x = 0; x < W; x += 1) {
        const xo = Math.round(Math.sin(y * 0.9 + tm * 1.3 + x * 0.02) * 1.4);
        const c = get(clamp(x + xo, 0, W - 1), ys);
        let o = mix(c, mix(soil, top, 0.12), clamp(0.5 + k / 90, 0, 0.85));
        if (hash(x >> 2, y * 3 + Math.floor(tm * 0.7)) < 0.035) o = mix(o, bot, 0.55);
        put(x, y, o);
      }
    }

  for (let x = 0; x < W; x += 1)
    for (let y = S.HM[x]; y < H; y += 1) {
      const v = (y - S.HM[x]) / (H - S.HM[x]);
      const c = v < 0.3 ? mix(mid, grass, v / 0.3) : mix(grass, soil, ((v - 0.3) / 0.7) * 0.85);
      const r = hash(x, y);
      put(
        x,
        y,
        y === S.HM[x]
          ? mul(c, 1.2)
          : r < 0.13
            ? mul(c, 0.86)
            : r > 0.9
              ? mul(c, 1.13)
              : (y % 2 && hash(x >> 2, y) < 0.15)
                ? mul(c, 0.94)
                : c,
      );
    }

  if (sea)
    for (let x = 0; x < W; x += 1)
      if (Math.sin(x * 0.22 - tm * 1.8) > 0) put(x, S.HM[x] - 1, [240, 248, 252]);

  if (S.pc.some((v) => v > 0)) {
    const pc = mul(S.pc, 0.5 + 0.5 * (1 - st));
    for (const [x, y] of S.MP) put(x, y, pc);
  }

  if (S.fence && !hidden("fence")) {
    const fc = mix(mid, [72, 58, 46], 0.6);
    for (let x = 0; x < W; x += 1) {
      if (x % 24 < 2) {
        for (let y = S.HM[x] - 5; y <= S.HM[x] + 5; y += 1)
          put(x, y - oNear, y === S.HM[x] - 5 && S.cap ? S.cap : fc);
      } else {
        if (hash(x >> 3, 1) < 0.8) put(x, S.HM[x] - 1 - oNear, fc);
        if (hash(x >> 3, 2) < 0.8) put(x, S.HM[x] + 3 - oNear, fc);
      }
    }
  }

  if (S.lake) {
    const wd = mul([158, 104, 72], 0.45 + 0.55 * (1 - st));
    for (let y = 124; y < H; y += 1)
      for (let x = 0, e = Math.round(72 - (y - 124) * 1.6); x < e; x += 1)
        put(x, y, y === 124 ? mul(wd, 1.25) : Math.floor((x + y * 1.3) / 6) % 2 ? wd : mul(wd, 0.82));
    for (let y = 110; y <= 128; y += 1)
      for (let x = 60; x <= 63; x += 1) put(x, y, x === 60 ? mul(wd, 1.2) : wd);
    const bx = 196 + Math.sin(tm * 0.5) * 3;
    const by = 104 + Math.sin(tm * 0.9) * 0.8;
    const bw = mul([196, 150, 100], 0.5 + 0.5 * (1 - st));
    for (let r = 0; r < 3; r += 1)
      for (let x = -7 + r; x <= 7 - r; x += 1) {
        put(bx + x, by + r, r === 0 ? [92, 52, 40] : bw);
        put(bx + x, by + 5 - r, mix(bw, soil, 0.65));
      }
    for (let k = 0; k < 6; k += 1) put(bx + 2 + k, by - 3 + k, bw);
  }

  const tcol = mul(S.tf, 0.45 + 0.55 * (1 - st));
  for (const [x, y, r] of S.TF) {
    const h = 1 + ((y - 90) / 18) | 0;
    const sw = Math.sin(tm * 1.8 + x * 0.35) > 0.55 ? 1 : 0;
    for (let k = 1; k <= h; k += 1)
      put(x + (k === h ? sw : 0), y - k, k === h ? mul(tcol, 1.25) : tcol);
    if (S.fl && r > 0.9)
      put(
        x,
        y - h - 1,
        mul(
          [
            [255, 90, 122],
            [255, 224, 102],
            [250, 250, 255],
          ][Math.floor(r * 37) % 3],
          1 - 0.55 * st,
        ),
      );
  }

  if (S.fx === "ff" && !hidden("fireflies"))
    FF.forEach(([x0, y0, ax, ay, fx, fy, ph]) => {
      if (ph / 6.28 >= st) return;
      const b = Math.sin(tm * 2.6 + ph * 5);
      const x = x0 + Math.sin(tm * fx * 0.3 + ph) * ax;
      const y = y0 + Math.sin(tm * fy * 0.3 + ph * 1.7) * ay;
      if (b > 0.1) {
        put(x, y, [216, 255, 122]);
        if (b > 0.6) {
          const g = [110, 140, 70];
          put(x - 1, y, g);
          put(x + 1, y, g);
          put(x, y - 1, g);
          put(x, y + 1, g);
        }
      }
    });

  if (S.fx === "sn" && !hidden("weather"))
    PK.forEach(([x0, y0, sp, ph]) => {
      const x = (x0 + Math.sin(tm * 0.8 + ph) * 5 + W) % W;
      const y = (y0 + tm * sp) % H;
      put(x, y, [250, 252, 255]);
      if (sp > 16) put(x + 1, y, [220, 228, 240]);
    });

  if (S.fx === "du" && st < 0.5 && !hidden("weather"))
    PK.forEach(([x0, y0, sp, ph]) => {
      if (sp > 14)
        put((x0 + tm * sp * 2) % W, 90 + y0 / 3 + Math.sin(tm + ph) * 3, mul(grass, 1.12));
    });

  /* CL O U D  S E A — haze that thickens with HEIGHT. From the
     mature stages the scene slowly gives way to the clouds that
     already live in each scene; the higher a band of the picture
     sits, the thicker the haze on it, so the canopy above the
     field fades into drifting cloud while the ground keeps its
     color. The saturation wash runs one band higher — above the
     giant stage everything the canopy has left below drains to
     gray. The haze is alive: two sheets drift at different rates
     and heave gently, leaves fall through it, and birds cross the
     hazy sky. */
  /* Both keyed off ASCENT_START too, so the haze builds in step
     with the elevation shift above instead of arriving a stage
     later: cf reaches full density about 70% of the way up the
     climb, wash (the gray-out) finishes exactly at the summit. */
  const cf = ease(clamp((parallax - ASCENT_START) / ((1 - ASCENT_START) * 0.7), 0, 1));
  const wash = ease(
    clamp((parallax - (ASCENT_START + (1 - ASCENT_START) * 0.4)) / ((1 - ASCENT_START) * 0.6), 0, 1),
  );
  if (cf > 0.02 || wash > 0.02) {
    const mask = new Float32Array(W * H);
    if (S.cu) {
      for (const { x, y: yb, blobs, sp } of CU) {
        const ox = (x + tm * sp + 80) % (W + 160) - 80;
        for (const [dx, dy, r] of blobs) {
          const cx = Math.round(ox + dx);
          const cy = Math.round(yb + dy);
          const R = r * 1.2;
          for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y += 1)
            for (let xx = Math.max(0, cx - R); xx <= Math.min(W - 1, cx + R); xx += 1) {
              const d = Math.hypot(xx - cx, y - cy);
              const v = 1 - d / R;
              if (v > 0.05 && v > mask[y * W + xx]) mask[y * W + xx] = v * v;
            }
        }
      }
    } else {
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) {
          const far = clamp(vn(x * 0.022 + tm * 0.009 + 1, (y + P * 5 + tm * 2.2) * 0.024 + 2) * 1.9 - (0.62 + 0.025 * Math.sin(tm * 0.2)), 0, 1);
          const near = clamp(vn(x * 0.042 - tm * 0.021 + 5, (y + P * 13 + tm * 6.8) * 0.036 + 9) * 1.9 - (0.66 + 0.03 * Math.cos(tm * 0.16)), 0, 1);
          const lump = 1 - (1 - far) * (1 - near);
          mask[y * W + x] = clamp(lump * 1.3 - 0.18, 0, 1) ** 1.4;
        }
    }
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const base = get(x, y);
        /* The wash: above the giant stage the scene drains to gray. */
        const gray = (base[0] + base[1] + base[2]) / 3;
        const washed = mix(base, [gray, gray, gray], 0.55 * wash);
        /* The haze is proportional to the tree's height: the higher
           the canopy climbs, the denser the blanket — same density
           across the frame, breathing gently as it drifts. */
        const breathe = 1 + 0.08 * Math.sin(tm * 0.35 + y * 0.02);
        const a = cf * mask[y * W + x] * 0.92 * breathe;
        if (a <= 0.02) {
          if (cf > 0.02 || wash > 0.02) put(x, y, washed);
          continue;
        }
        const nn = vn(x * 0.12, y * 0.14);
        const col =
          nn > 0.72
            ? mix(cloud, [255, 255, 255], 0.3)
            : hash(x, y) < 0.18
              ? mul(cloud, 0.85)
              : cloud;
        put(x, y, mix(washed, col, a));
      }
  }

  /* Leaves fall through the hazy air, at two depths, in the active
     species' own colors and silhouette. Most just fall straight
     through; a few catch on the haze instead, drift to a hang, sway
     there a while, then fade and restart — "sometimes gather in
     the frame" rather than only ever raining past. */
  if (cf > 0.03 && !hidden("haze")) {
    const species = speciesId ? SPECIES_HAZE[speciesId] : undefined;
    const tc = mul(S.tf, 0.5 + 0.5 * (1 - st));
    for (let k = 0; k < 26; k += 1) {
      const seed = hash(k, 7);
      const near = seed > 0.6;
      const ph = hash(k, 11) * 6.283;
      const gathers = hash(k, 47) > 0.65;
      let x: number;
      let y: number;
      let alpha = 1;
      if (!gathers) {
        const spd = near ? 17 : 9;
        y = ((tm * spd + ph * 6 + P * 12) % (H + 8)) - 4;
        if (y < 0 || y > H - 1) continue;
        const x0 = seed * (W + 20) - 10;
        x = Math.abs(x0 + Math.sin(tm * (near ? 1.5 : 0.8) + ph) * 3) % W;
      } else {
        const cyc = 11 + hash(k, 41) * 9;
        const t0 = hash(k, 43) * cyc;
        const cp = ((tm + t0) % cyc) / cyc;
        const fallFrac = 0.32 + hash(k, 51) * 0.12;
        const restY = H * (0.14 + 0.5 * hash(k, 53));
        const x0 = seed * (W + 20) - 10;
        if (cp < fallFrac) {
          y = (cp / fallFrac) * (restY + 4) - 4;
          x = Math.abs(x0 + Math.sin(tm * (near ? 1.5 : 0.8) + ph) * 3) % W;
        } else {
          const rp = (cp - fallFrac) / (1 - fallFrac);
          y = restY + Math.sin(tm * 0.6 + k) * 1.1;
          x = Math.abs(x0 + Math.sin(tm * 0.3 + ph) * 1.2) % W;
          alpha = rp > 0.78 ? clamp(1 - (rp - 0.78) / 0.22, 0, 1) : 1;
          if (alpha <= 0.03) continue;
        }
        if (y < 0 || y > H - 1) continue;
      }
      const spin = Math.sin(tm * 1.3 + ph) > 0 ? 1 : -1;
      const c0 = species
        ? mul(species.colors[k % species.colors.length], near ? 1.2 : 0.95)
        : mul(tc, near ? 1.3 : 1.05);
      const c1 = species
        ? mul(species.colors[(k + 1) % species.colors.length], near ? 1.05 : 0.85)
        : mul(tc, near ? 1.1 : 0.9);
      const shape = species ? species.shape : "leaf";
      const stampPut =
        alpha >= 0.999
          ? put
          : (px: number, py: number, c: number[]) => {
              const pxi = px | 0;
              const pyi = py | 0;
              if (pxi < 0 || pyi < 0 || pxi >= W || pyi >= H) return;
              put(pxi, pyi, mix(get(pxi, pyi), c, alpha));
            };
      stampHazeLeaf(stampPut, x, y, shape, c0, c1, spin);
    }
  }

  /* Birds cross the hazy sky once the canopy has climbed up. */
  if (cf > 0.03) {
    const bc = mix(top, [24, 18, 30], 0.72);
    for (let k = 0; k < 3; k += 1) {
      const spd = 6 + k * 2.5;
      const y = 8 + hash(k, 3) * 26;
      const x = ((hash(k, 5) * (W + 34) + tm * spd * (1 + cf)) % (W + 34)) - 17;
      const f = Math.sin(tm * 8 + k * 2.4) > 0 ? -1 : 1;
      const xi = Math.round(x);
      put(xi, y, bc);
      put(xi - 1, y + f, bc);
      put(xi + 1, y + f, bc);
      put(xi - 2, y + 2 * f, bc);
      put(xi + 2, y + 2 * f, bc);
    }
  }
}

/* One static daytime still for shop previews. */
export function backdropStill(
  ctx: CanvasRenderingContext2D,
  id: BackdropThemeId,
  t = 0.5,
) {
  const scene = buildScene(id);
  const img = ctx.createImageData(BACKDROP_W, BACKDROP_H);
  renderFrame(img.data, scene, t, 0);
  ctx.putImageData(img, 0, 0);
  return scene;
}

export function themeIndex(id: BackdropThemeId): number {
  return Math.max(
    0,
    BACKDROP_THEMES.findIndex((theme) => theme.id === id),
  );
}
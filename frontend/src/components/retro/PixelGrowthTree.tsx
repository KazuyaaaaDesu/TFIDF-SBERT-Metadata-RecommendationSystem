/**
 * PIXEL GROWTH TREE — the Tree of Knowledge's tree, grown like the
 * Crimson Tree reference: a 192x192 procedural pixel tree that
 * grows from the root up over a few seconds, with a per-species
 * five-tone foliage ramp, catmull-rom limbs, canopy clusters that
 * pop in at their birth time, and falling leaves once it is fully
 * grown.
 *
 * Controls: Pause/Play, a growth slider (0..1000 = 0%..100%), and
 * Replay. The tree's height in feet adds a few dark root pixels so
 * fertilizer visibly anchors a taller tree.
 */

import { useEffect, useRef, useState } from "react";
import {
  SPECIES_STAGE_FERT,
  TREE_GROWTH_TARGET,
  treeSpecies,
  type TreeSpeciesId,
} from "../../data/knowledge";
import {
  motePose,
  sylphPose,
  vineShown,
  vineSpecs,
} from "../../utils/ascentAccents";
import {
  CASTLE_H,
  CASTLE_W,
  castleSprite,
  drawCastle as paintCastleSprite,
  type CastlePainter,
} from "../../utils/castleSprite";
import { leafPixels, type LeafShape } from "../../utils/leafShapes";
import { drawCharms, type CharmEnv } from "./gardenCharms";
import {
  resolveVariant,
  tintBark,
  tintFoliage,
} from "../../utils/treeVariants";
import {
  makeRoots,
  motionTick,
  rootAt,
  sapShade,
  shimmerShift,
  smoothstep,
  swayOffset,
} from "../../utils/treeMotion";

/* The raster IS the garden stage: 256x144 art pixels, the same grid as
   the backdrop, so the tree paints across the whole scene instead of
   inside a smaller window with hard clipped edges (the trunk used to be
   cut flat at the window's top and sides). S, the world-to-pixel scale,
   stays pinned to the reference's original 128-wide calibration, so the
   tree itself renders at the same size as before; the extra frame is
   only room: more sky above, more margin at the sides. The ground sits
   a fixed distance above the bottom edge. */
const W = 256;
const H = 144;
const S = 128 / 800;
const GROUND_ROW = H - 9;

/* ---------- palette helpers ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  const hex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

function shift(color: string, amount: number): string {
  const [r, g, b] = hexToRgb(color);
  return rgbToHex([r + amount, g + amount, b + amount]);
}

/* ---------- seeded noise ---------- */

const rng = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const hash = (x: number, y: number) => {
  let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);
  h ^= h >>> 13;
  return (h & 0xffff) / 65535;
};

const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));

const lerpArr = (values: number[], u: number) => {
  const f = u * (values.length - 1);
  const i = Math.min(values.length - 2, f | 0);
  return values[i] + (values[i + 1] - values[i]) * (f - i);
};

function spline(pts: number[][], n: number): number[][] {
  const out: number[][] = [];
  const m = pts.length - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[i];
    const c = pts[i + 1];
    const d = pts[Math.min(i + 2, m)];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0,
        1,
      ].map((j) =>
        0.5 *
        (2 * b[j] +
          (-a[j] + c[j]) * t +
          (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 +
          (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * t3),
      ));
    }
  }
  out.push(pts[m]);
  return out;
}

/* ---------- per-species tree shapes ---------- */

interface TreeShape {
  trunk: number[][];
  trunkW: number[];
  branches: { pts: number[][]; ws: number[]; b0: number; dur: number }[];
  clusters: {
    cx: number; cy: number; rx: number; ry: number; tone: number;
    lo: number; hi: number;
  }[];
  /** How many loosely-scattered clusters bloom above the canopy
      at the very top of the growth (random positions, seeded). */
  topFoliage?: number;
  /** Extra clusters (elder stage / ground clumps). */
  elder: {
    cx: number; cy: number; rx: number; ry: number; tone: number;
    lo?: number; hi?: number; start?: number;
  }[];
}

/* The reference's exact sprite palettes for the default tree. */
const CRIMSON_PALETTE: Palette = {
  bark: ["#221b2b", "#322a3f", "#443a52", "#5a4e66"],
  foliage: ["#3f0614", "#76091c", "#b30f20", "#e5111f", "#ff3345"],
  accent: "#4f5340",
  cream: ["#f3dcd2", "#ffeee8", "#e8c7bd"],
};

const SHAPES: Record<TreeSpeciesId, TreeShape> = {
  crimson: {
    topFoliage: 5,
    trunk: [
      [400, 742], [398, 690], [396, 630], [398, 570], [402, 510],
      [404, 450], [403, 390], [402, 330], [402, 270], [403, 245],
    ],
    trunkW: [104, 94, 86, 80, 74, 68, 60, 50, 40, 32],
    branches: [
      { pts: [[402,520],[360,495],[310,455],[262,410],[225,360]], ws: [30,24,18,12,6], b0: .13, dur: .2 },
      { pts: [[404,515],[450,490],[500,450],[545,405],[580,355]], ws: [30,24,18,12,6], b0: .14, dur: .2 },
      { pts: [[403,440],[365,400],[325,350],[290,290],[262,230]], ws: [28,22,16,10,5], b0: .2, dur: .2 },
      { pts: [[404,435],[445,395],[485,345],[520,285],[545,225]], ws: [28,22,16,10,5], b0: .22, dur: .2 },
      { pts: [[403,350],[375,300],[350,240],[335,180],[330,125]], ws: [22,17,12,8,4], b0: .28, dur: .16 },
      { pts: [[402,345],[432,295],[455,235],[470,175],[475,120]], ws: [22,17,12,8,4], b0: .3, dur: .16 },
      { pts: [[402,260],[402,200],[404,140],[404,85]], ws: [20,14,9,4], b0: .32, dur: .14 },
      { pts: [[262,410],[235,430],[205,430]], ws: [10,6,3], b0: .36, dur: .12 },
      { pts: [[545,405],[575,430],[600,430]], ws: [10,6,3], b0: .38, dur: .12 },
      { pts: [[400,735],[350,742],[305,738]], ws: [20,12,5], b0: -.07, dur: .12 },
      { pts: [[403,735],[452,742],[497,738]], ws: [20,12,5], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,95,80,45,.72],[330,120,70,45,.68],[470,120,70,45,.68],[400,55,40,25,.8],
      [260,185,85,55,.62],[400,170,90,55,.6],[540,185,85,55,.62],
      [200,265,85,55,.55],[330,260,85,55,.52],[470,260,85,55,.52],[600,265,85,55,.55],
      [175,350,75,50,.5],[300,345,80,50,.46],[420,340,80,50,.44],[540,345,80,50,.46],[630,350,75,50,.5],
      [210,430,70,40,.44],[330,435,70,40,.4],[470,435,70,40,.4],[590,430,70,40,.44],
      [270,500,60,30,.4],[400,515,70,30,.38],[530,500,60,30,.4],
    ].map(([cx, cy, rx, ry, tone]) => ({
      cx, cy, rx, ry, tone, lo: 2.8, hi: 4.2,
    })),
    elder: [
      { cx: 520, cy: 725, rx: 26, ry: 9, tone: 0.5, lo: 2, hi: 3.2, start: 0.93 },
      { cx: 285, cy: 722, rx: 22, ry: 8, tone: 0.55, lo: 1.8, hi: 2.8, start: 0.95 },
    ],
  },
  oak: {
    topFoliage: 5,
    trunk: [
      [400, 742], [396, 690], [392, 640], [395, 590], [402, 540],
      [408, 490], [410, 440], [408, 390], [404, 340], [404, 290],
      [406, 245],
    ],
    trunkW: [130, 118, 108, 100, 94, 86, 76, 66, 56, 48, 40],
    branches: [
      { pts: [[404,500],[360,470],[300,440],[230,420],[170,380],[120,340]], ws: [58,46,36,26,16,8], b0: .13, dur: .22 },
      { pts: [[410,490],[460,460],[530,440],[600,420],[660,380],[700,340]], ws: [58,46,36,26,16,8], b0: .14, dur: .22 },
      { pts: [[412,560],[470,550],[540,540],[600,550],[650,540]], ws: [30,22,16,10,6], b0: .2, dur: .2 },
      { pts: [[405,400],[380,340],[340,290],[300,240],[270,190]], ws: [40,30,22,14,8], b0: .25, dur: .18 },
      { pts: [[408,400],[440,340],[480,290],[520,240],[560,200]], ws: [40,30,22,14,8], b0: .27, dur: .18 },
      { pts: [[406,330],[404,280],[400,230],[398,170],[400,120]], ws: [32,24,18,12,6], b0: .3, dur: .15 },
      { pts: [[230,420],[200,440],[160,470],[130,470]], ws: [14,10,6,3], b0: .38, dur: .12 },
      { pts: [[600,420],[630,460],[650,480],[665,500]], ws: [14,10,6,3], b0: .4, dur: .12 },
      { pts: [[300,440],[290,400],[250,370],[220,340]], ws: [10,8,5,3], b0: .4, dur: .12 },
      { pts: [[530,440],[540,400],[580,370],[610,340]], ws: [10,8,5,3], b0: .42, dur: .12 },
      { pts: [[400,735],[340,742],[290,738]], ws: [26,14,5], b0: -.07, dur: .12 },
      { pts: [[405,735],[460,742],[510,738]], ws: [24,12,5], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,130,120,60,.62],[270,160,110,60,.58],[530,160,110,60,.6],[160,230,100,70,.55],[640,230,100,70,.57],
      [400,205,140,70,.5],[300,265,110,65,.45],[500,265,110,65,.47],
      [110,330,80,60,.55],[690,330,80,60,.55],[210,335,100,60,.5],[590,335,100,60,.5],[400,305,120,60,.4],
      [150,420,60,40,.5],[650,410,65,45,.5],[250,415,70,40,.42],[550,405,70,40,.42],
      [640,520,70,40,.5],[520,485,60,32,.42],[130,470,50,30,.5],
      [330,95,55,32,.7],[480,92,55,30,.7],[610,160,60,40,.65],[190,150,60,40,.65],
    ].map(([cx, cy, rx, ry, tone]) => ({
      cx, cy, rx, ry, tone, lo: 2.8, hi: 4.2,
    })),
    elder: [
      { cx: 520, cy: 725, rx: 26, ry: 9, tone: 0.5, lo: 2, hi: 3.2, start: 0.93 },
      { cx: 285, cy: 722, rx: 22, ry: 8, tone: 0.55, lo: 1.8, hi: 2.8, start: 0.95 },
    ],
  },
  birch: {
    topFoliage: 8,
    trunk: [
      [395, 742], [392, 690], [396, 630], [404, 570], [412, 510],
      [416, 450], [414, 390], [408, 330], [404, 285], [404, 245],
    ],
    trunkW: [62, 56, 52, 48, 44, 40, 36, 32, 28, 24],
    branches: [
      { pts: [[412,520],[440,490],[480,470],[520,470],[548,500]], ws: [18,14,10,6,3], b0: .14, dur: .2 },
      { pts: [[408,470],[370,440],[330,430],[295,450],[270,490]], ws: [18,14,10,6,3], b0: .15, dur: .2 },
      { pts: [[414,400],[450,365],[495,350],[535,360],[560,395]], ws: [16,12,9,5,3], b0: .2, dur: .2 },
      { pts: [[410,380],[370,350],[330,335],[290,350],[265,390]], ws: [16,12,9,5,3], b0: .22, dur: .2 },
      { pts: [[406,310],[435,270],[470,245],[500,250],[520,280]], ws: [14,10,7,4,2], b0: .28, dur: .16 },
      { pts: [[404,300],[372,260],[340,235],[310,245],[292,275]], ws: [14,10,7,4,2], b0: .3, dur: .16 },
      { pts: [[404,260],[404,200],[400,140],[398,90]], ws: [18,13,8,4], b0: .32, dur: .14 },
      { pts: [[400,730],[372,690],[350,630],[338,560],[334,500],[336,450]], ws: [34,30,26,22,18,12], b0: .1, dur: .2 },
      { pts: [[336,450],[310,410],[285,370],[270,330]], ws: [12,9,6,3], b0: .24, dur: .15 },
      { pts: [[395,735],[350,742],[310,738]], ws: [16,9,4], b0: -.07, dur: .12 },
      { pts: [[398,735],[440,742],[480,738]], ws: [16,9,4], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,95,70,40,.78],[330,140,70,40,.72],[470,140,70,40,.72],[260,215,70,45,.66],[400,200,80,45,.66],[540,215,70,45,.68],
      [205,300,65,45,.6],[330,290,70,45,.6],[470,295,70,45,.6],[590,310,60,45,.62],[180,400,55,45,.55],[290,410,65,45,.52],[400,420,70,40,.5],
      [520,410,65,45,.52],[610,420,50,45,.56],[250,500,55,40,.5],[330,520,55,40,.48],[560,510,50,40,.52],[470,520,50,40,.48],[400,65,35,22,.85],[290,350,45,40,.55],
    ].map(([cx, cy, rx, ry, tone]) => ({
      cx, cy, rx, ry, tone, lo: 2.2, hi: 3.8,
    })),
    elder: [
      { cx: 400, cy: 120, rx: 20, ry: 14, tone: .75 },
      { cx: 360, cy: 95, rx: 16, ry: 12, tone: .78 },
      { cx: 450, cy: 100, rx: 18, ry: 12, tone: .75 },
      { cx: 300, cy: 420, rx: 20, ry: 14, tone: .6 },
      { cx: 520, cy: 420, rx: 20, ry: 14, tone: .6 },
    ],
  },
  elm: {
    topFoliage: 6,
    trunk: [
      [400, 742], [399, 690], [399, 640], [400, 590], [401, 540],
      [402, 490], [402, 440], [403, 380], [403, 320], [404, 270], [404, 245],
    ],
    trunkW: [110, 98, 90, 86, 82, 78, 70, 60, 48, 38, 30],
    branches: [
      { pts: [[400,490],[360,440],[310,390],[250,340],[190,300],[150,290]], ws: [46,36,28,20,12,6], b0: .12, dur: .22 },
      { pts: [[402,480],[385,420],[360,350],[330,280],[300,230]], ws: [38,30,22,14,8], b0: .16, dur: .2 },
      { pts: [[402,480],[402,410],[404,330],[408,250],[412,170]], ws: [38,30,22,14,6], b0: .18, dur: .2 },
      { pts: [[404,480],[425,420],[450,350],[480,280],[512,230]], ws: [38,30,22,14,8], b0: .2, dur: .2 },
      { pts: [[406,490],[448,440],[498,390],[558,340],[618,300],[658,290]], ws: [46,36,28,20,12,6], b0: .13, dur: .22 },
      { pts: [[150,290],[120,320],[100,370]], ws: [8,5,3], b0: .32, dur: .12 },
      { pts: [[658,290],[690,320],[710,370]], ws: [8,5,3], b0: .34, dur: .12 },
      { pts: [[250,340],[230,380],[215,430]], ws: [10,6,3], b0: .3, dur: .12 },
      { pts: [[558,340],[575,385],[590,430]], ws: [10,6,3], b0: .32, dur: .12 },
      { pts: [[400,735],[345,742],[295,738]], ws: [22,12,5], b0: -.07, dur: .12 },
      { pts: [[403,735],[455,742],[505,738]], ws: [22,12,5], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,100,100,50,.7],[300,125,90,50,.66],[500,125,90,50,.66],[210,170,90,55,.62],[590,170,90,55,.62],[400,175,100,55,.6],
      [130,240,80,55,.58],[670,240,80,55,.58],[300,230,90,55,.52],[500,230,90,55,.52],[210,300,80,55,.5],[590,300,80,55,.5],[400,265,100,55,.48],
      [110,330,60,45,.52],[690,330,60,45,.52],[170,390,55,40,.5],[630,390,55,40,.5],[225,440,50,35,.45],[575,440,50,35,.45],[100,400,40,40,.55],[700,400,40,40,.55],
      [350,330,70,45,.42],[450,330,70,45,.42],
    ].map(([cx, cy, rx, ry, tone]) => ({
      cx, cy, rx, ry, tone, lo: 2.6, hi: 4.2,
    })),
    elder: [
      { cx: 400, cy: 150, rx: 60, ry: 40, tone: .7 },
      { cx: 300, cy: 120, rx: 50, ry: 36, tone: .72 },
      { cx: 500, cy: 120, rx: 50, ry: 36, tone: .72 },
    ],
  },
  redwood: {
    topFoliage: 8,
    trunk: [
      [400, 742], [399, 650], [400, 560], [401, 470], [402, 380],
      [402, 300], [402, 220], [402, 150], [402, 90],
    ],
    trunkW: [140, 110, 96, 86, 76, 66, 56, 44, 32],
    branches: [
      { pts: [[402,340],[360,350],[320,370],[290,400]], ws: [20,14,9,4], b0: .2, dur: .18 },
      { pts: [[402,335],[445,345],[485,365],[515,395]], ws: [20,14,9,4], b0: .2, dur: .18 },
      { pts: [[402,270],[365,275],[335,295],[312,325]], ws: [18,13,8,4], b0: .26, dur: .16 },
      { pts: [[402,265],[440,272],[470,290],[492,320]], ws: [18,13,8,4], b0: .26, dur: .16 },
      { pts: [[402,200],[372,205],[350,222],[335,245]], ws: [16,11,7,3], b0: .32, dur: .14 },
      { pts: [[402,195],[432,200],[455,218],[470,240]], ws: [16,11,7,3], b0: .32, dur: .14 },
      { pts: [[402,140],[380,145],[365,160]], ws: [12,8,3], b0: .36, dur: .12 },
      { pts: [[402,135],[424,140],[439,155]], ws: [12,8,3], b0: .36, dur: .12 },
      { pts: [[400,735],[340,742],[290,738]], ws: [30,16,6], b0: -.07, dur: .12 },
      { pts: [[403,735],[462,742],[512,738]], ws: [30,16,6], b0: -.06, dur: .12 },
    ],
    clusters: [
      [402,60,26,30,.8],[402,100,40,34,.74],[352,130,45,30,.68],[452,130,45,30,.68],[402,150,50,32,.64],
      [330,210,70,36,.6],[474,210,70,36,.6],[402,215,60,34,.56],
      [300,280,90,40,.52],[504,280,90,40,.52],[402,285,70,40,.48],
      [270,350,100,44,.48],[534,350,100,44,.48],[402,355,80,42,.44],[360,320,60,30,.42],[444,320,60,30,.42],
    ].map(([cx, cy, rx, ry, tone]) => ({
      cx, cy, rx, ry, tone, lo: 2.4, hi: 3.6,
    })),
    elder: [
      { cx: 520, cy: 725, rx: 26, ry: 9, tone: 0.5, lo: 2, hi: 3.2, start: 0.93 },
      { cx: 285, cy: 722, rx: 22, ry: 8, tone: 0.55, lo: 1.8, hi: 2.8, start: 0.95 },
    ],
  },
  beanstalk: {
    topFoliage: 6,
    trunk: [
      [400, 742], [372, 688], [430, 626], [366, 562], [434, 498], [368, 434],
      [432, 370], [372, 306], [428, 242], [384, 178], [414, 118], [398, 66],
    ],
    trunkW: [58, 50, 46, 42, 38, 35, 32, 29, 26, 23, 19, 14],
    branches: [
      { pts: [[372,562],[316,548],[258,530],[210,548],[188,596]], ws: [16,13,9,6,3], b0: .16, dur: .2 },
      { pts: [[434,498],[492,480],[552,462],[600,478],[620,526]], ws: [16,13,9,6,3], b0: .17, dur: .2 },
      { pts: [[368,434],[310,414],[252,388],[222,350],[240,318]], ws: [15,12,8,5,3], b0: .21, dur: .2 },
      { pts: [[432,370],[492,350],[548,322],[576,284],[556,252]], ws: [15,12,8,5,3], b0: .23, dur: .2 },
      { pts: [[372,306],[322,286],[276,258],[252,222],[272,194]], ws: [13,10,7,4,2], b0: .27, dur: .18 },
      { pts: [[428,242],[478,222],[524,196],[546,160],[524,134]], ws: [13,10,7,4,2], b0: .29, dur: .18 },
      { pts: [[384,178],[352,156],[326,128],[332,96]], ws: [10,8,5,3], b0: .33, dur: .14 },
      { pts: [[414,118],[446,98],[470,74]], ws: [9,6,3], b0: .36, dur: .12 },
      { pts: [[400,735],[348,742],[298,738]], ws: [24,13,5], b0: -.07, dur: .12 },
      { pts: [[403,735],[456,742],[506,738]], ws: [24,13,5], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,58,36,28,.82],[400,104,60,34,.74],
      [310,170,74,36,.68],[490,170,74,36,.68],[400,210,56,32,.6],
      [270,252,84,38,.62],[530,252,84,38,.62],[400,290,54,30,.52],
      [242,336,88,40,.56],[558,336,88,40,.56],[400,372,56,32,.48],
      [214,416,84,38,.5],[586,416,84,38,.5],[400,452,56,30,.44],
      [200,500,74,34,.46],[600,500,74,34,.46],[400,532,52,28,.4],
      [212,584,60,30,.42],[588,584,60,30,.42],[300,540,56,26,.4],[500,540,56,26,.4],
    ].map(([cx, cy, rx, ry, tone]) => ({
      /* a slim, leafy ladder up the stalk rather than a round crown */
      cx: 400 + (cx - 400) * 0.66,
      cy,
      rx: rx * 0.72,
      ry: ry * 0.86,
      tone,
      lo: 3.4,
      hi: 5.2,
    })),
    elder: [
      { cx: 520, cy: 725, rx: 26, ry: 9, tone: 0.5, lo: 2, hi: 3.2, start: 0.93 },
      { cx: 285, cy: 722, rx: 22, ry: 8, tone: 0.55, lo: 1.8, hi: 2.8, start: 0.95 },
    ],
  },
  rosevine: {
    topFoliage: 5,
    /* a rose shrub, thickened into a vine: a short, twisting main cane
       that throws thick arching canes out and down, thorned all over */
    trunk: [
      [400, 742], [388, 700], [414, 652], [392, 604], [412, 554],
      [398, 504], [406, 454], [400, 404],
    ],
    trunkW: [136, 118, 106, 96, 86, 76, 64, 52],
    branches: [
      { pts: [[392,690],[330,640],[250,606],[168,628],[120,688],[100,742]], ws: [46,38,30,22,13,6], b0: .1, dur: .22 },
      { pts: [[410,690],[480,640],[560,606],[642,628],[690,688],[708,742]], ws: [46,38,30,22,13,6], b0: .11, dur: .22 },
      { pts: [[396,600],[322,540],[238,498],[160,508],[110,560],[96,632]], ws: [40,32,24,16,9,4], b0: .15, dur: .22 },
      { pts: [[412,596],[486,536],[570,494],[648,504],[698,556],[712,628]], ws: [40,32,24,16,9,4], b0: .16, dur: .22 },
      { pts: [[398,504],[340,440],[272,392],[202,390],[152,434],[132,502]], ws: [34,27,20,13,7,3], b0: .2, dur: .2 },
      { pts: [[406,500],[466,436],[534,388],[604,386],[654,430],[672,498]], ws: [34,27,20,13,7,3], b0: .21, dur: .2 },
      { pts: [[404,452],[424,386],[404,324],[366,278],[350,226]], ws: [30,23,16,9,4], b0: .26, dur: .18 },
      { pts: [[400,420],[440,360],[492,318],[552,310],[596,340]], ws: [26,20,14,8,3], b0: .28, dur: .18 },
      { pts: [[400,420],[360,360],[308,320],[248,314],[206,346]], ws: [26,20,14,8,3], b0: .29, dur: .18 },
      { pts: [[250,606],[226,570],[232,526]], ws: [12,8,4], b0: .3, dur: .12 },
      { pts: [[560,606],[584,570],[578,526]], ws: [12,8,4], b0: .31, dur: .12 },
      { pts: [[400,735],[336,742],[284,738]], ws: [28,15,5], b0: -.07, dur: .12 },
      { pts: [[403,735],[466,742],[518,738]], ws: [28,15,5], b0: -.06, dur: .12 },
    ],
    clusters: [
      [400,232,80,44,.74],[330,268,80,44,.68],[470,268,80,44,.68],
      [260,318,90,48,.62],[540,318,90,48,.62],[400,318,100,50,.58],
      [190,388,90,50,.58],[610,388,90,50,.58],[330,380,90,48,.52],[470,380,90,48,.52],
      [130,470,84,54,.54],[670,470,84,54,.54],[250,462,90,50,.48],[550,462,90,50,.48],[400,456,90,46,.46],
      [100,560,72,52,.52],[700,560,72,52,.52],[200,558,90,50,.46],[600,558,90,50,.46],[330,540,80,44,.42],[470,540,80,44,.42],
      [110,650,62,46,.48],[690,650,62,46,.48],[210,652,80,42,.44],[590,652,80,42,.44],[320,640,70,36,.4],[480,640,70,36,.4],
      [160,718,62,28,.42],[640,718,62,28,.42],
    ].map(([cx, cy, rx, ry, tone]) => ({
      /* leave the canes showing between the leafy masses */
      cx, cy, rx: rx * (cy > 480 ? 0.6 : 0.78), ry: ry * (cy > 480 ? 0.66 : 0.8), tone, lo: 2.6, hi: 4.2,
    })),
    elder: [
      { cx: 520, cy: 725, rx: 26, ry: 9, tone: 0.5, lo: 2, hi: 3.2, start: 0.93 },
      { cx: 285, cy: 722, rx: 22, ry: 8, tone: 0.55, lo: 1.8, hi: 2.8, start: 0.95 },
    ],
  },
};

/* ---------- palettes ---------- */

interface Palette {
  bark: string[];
  foliage: string[];
  accent: string;
  cream: string[];
}

function ramps(light: string, mid: string, deep: string): Palette {
  return {
    bark: [shift(mid, -70), shift(mid, -55), shift(mid, -34), shift(mid, -16)],
    foliage: [shift(deep, -40), deep, shift(mid, 10), mid, light],
    accent: "#4f5340", /* the reference's moss, verbatim */
    cream: ["#f3dcd2", "#ffeee8", "#e8c7bd"],
  };
}

/* ---------- component ---------- */

/* The reference's phases: growth (P in [0, 0.46)), zoom into the
   giant (0.46..0.66), then the ancient ascent (0.66..1). */
const PA = 0.46;
const PB = 0.2;
const PC = 0.34;

interface Art {
  /** Oak leaves have seven lobes; the crimson family five. */
  leafPoints: number;
  leafAmp: number;
  BX: number;
  ROOTX: number;
  ZM: number;
  DYW: number;
  /** Ancient-bark cell height / width and edge thresholds. */
  cellY: number;
  cellW: number;
  fxE: number;
  fyE: number;
  noiseL: number;
  noiseY: number;
  /** World-trunk profile scalars. */
  baseW: number;
  fillCX: number;
  baseCX: number;
  baseRW: number;
  WP: number[][];
  wWdef: number;
  /** Oak sheds acorns and plants one in the soil. */
  acorn: boolean;
  ground: number[][];
  blinkNear: number;
  blinkWin: number;
  /** Canopy center used for the cluster birth ramp. */
  clusterCX: number;
  clusterCY: number;
  /** Cluster-birth ramp radius in the 800-unit world. */
  clusterR: number;
  /** Maple leaves use the lobed silhouette and turn autumn. */
  mapleLeaf: boolean;
  /** Per-reference trunk-texture tuning (verbatim from each source). */
  trunkCellY: number;
  trunkCellMul: number;
  trunkLatJ: number;
  trunkYJ: number;
  trunkLatLean: number;
  trunkNoiseL: number;
  trunkNoiseY: number;
  trunkNoiseAmp: number;
  trunkGateX: number;
  trunkGateY: number;
  trunkDash: boolean;
  /** How the bark is drawn: the shared cell pattern, or a species' own. */
  barkStyle: "cells" | "plates" | "furrows" | "peel" | "lattice" | "fibres" | "twist" | "thorns";
  trunkFracY: number;
  trunkCxwAmp: number;
  trunkLowW: number;
  /** The source's leaf silhouette (the `e = r*(...)` formula). */
  leafShape: LeafShape;
  /** A second leaf design, drawn in the ramps listed in `altRamps`
      (the rose: sprigs of leaves among the blooms). */
  altShape?: LeafShape;
  altRamps?: number[];
  /** How the young trunk and limbs are dressed: twisted rope, or thorned. */
  limbStyle?: "twist" | "thorn";
  /** Frequency of the ancient trunk's sideways sway (default 0.0023). */
  trunkCxwK?: number;
  /** The source's four palettes for multi-hue leaves (gold/orange/
     crimson/green families per tree). */
  leafRamps?: number[][][];
  /** A single autumn ramp the foliage turns into once grown. */
  turnRamp?: number[][];
}

const OAK_ART: Art = {
  leafPoints: 7,
  leafAmp: 0.22,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.4,
  DYW: 2600,
  cellY: 64,
  cellW: 8,
  fxE: 0.16,
  fyE: 0.035,
  noiseL: 14,
  noiseY: 18,
  baseW: 40,
  fillCX: 406,
  baseCX: 400,
  baseRW: 130,
  WP: [
    [742, 200], [600, 170], [400, 150], [245, 140],
    [0, 126], [-1000, 110], [-3000, 92],
  ],
  wWdef: 92,
  acorn: true,
  ground: [
    [150, 102, 54],
    [88, 58, 32],
  ],
  blinkNear: 3.4,
  blinkWin: 0.14,
  clusterCX: 405,
  clusterCY: 360,
  clusterR: 330,
  mapleLeaf: false,  trunkCellY: 90,
  trunkCellMul: 9,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: false,
  barkStyle: "furrows",
  trunkFracY: 245,
  trunkCxwAmp: 38,
  trunkLowW: 32,
  leafShape: "lobed",
};

const CRIMSON_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.26,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.6,
  DYW: 2600,
  cellY: 24,
  cellW: 10,
  fxE: 0.13,
  fyE: 0.1,
  noiseL: 8,
  noiseY: 10,
  baseW: 12,
  fillCX: 403,
  baseCX: 440,
  baseRW: 100,
  WP: [
    [742, 110], [600, 100], [400, 92], [245, 84],
    [0, 76], [-1000, 66], [-3000, 54],
  ],
  wWdef: 54,
  acorn: false,
  ground: [
    [120, 84, 62],
    [96, 66, 50],
  ],
  blinkNear: 2.4,
  blinkWin: 0.05,
  clusterCX: 395,
  clusterCY: 300,
  clusterR: 330,
  mapleLeaf: false,  trunkCellY: 90,
  trunkCellMul: 9,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: false,
  barkStyle: "cells",
  trunkFracY: 245,
  trunkCxwAmp: 38,
  trunkLowW: 32,
  leafShape: "lobed",
};

/* The maple reference's four autumn ramps: leaves pass from green
   to gold, orange, or crimson as the tree matures. */
const M_GOLD = ["#6b4a0a", "#a8740f", "#d9a21b", "#f2c53a", "#ffe16b"].map(
  hexToRgb,
);
const M_ORNG = ["#5a2008", "#963a0c", "#d2570f", "#f27a1a", "#ffa63c"].map(
  hexToRgb,
);
const M_CRIM = ["#4a0a12", "#861418", "#c42a1c", "#e8472a", "#ff7a4d"].map(
  hexToRgb,
);
const M_GRN = ["#0f2a16", "#1d4a22", "#2f7a2e", "#4fa83e", "#8fd45c"].map(
  hexToRgb,
);
const MAPLE_RAMPS = [M_GOLD, M_ORNG, M_CRIM, M_GRN];

/* The birch source's three leaf families plus the turned green. */
const B_Y1 = ["#7a6a10", "#b8a418", "#e0cf30", "#f4ea5a", "#fffa9a"].map(hexToRgb);
const B_Y2 = ["#6b4a0a", "#a8740f", "#d9a21b", "#f2c53a", "#ffe16b"].map(hexToRgb);
const B_Y3 = ["#3b5a10", "#6a8f1c", "#9bc02a", "#c2dc4a", "#e6f27a"].map(hexToRgb);
const B_GRN = ["#143a1a", "#256a2c", "#46a03e", "#7acb55", "#b6ec80"].map(hexToRgb);
const BIRCH_RAMPS = [B_Y1, B_Y2, B_Y3, B_GRN];

/* The elm source's three leaf families plus the turned green. */
const E_1 = ["#6b4a0a", "#a8740f", "#d9a21b", "#f2c53a", "#ffe16b"].map(hexToRgb);
const E_2 = ["#5a5a10", "#8a8a1a", "#b8b82a", "#d8d848", "#f0f078"].map(hexToRgb);
const E_3 = ["#7a4a08", "#b87a14", "#e0a028", "#f5c042", "#ffe070"].map(hexToRgb);
const E_GRN = ["#123418", "#22582a", "#3a8a38", "#62b44e", "#9ce078"].map(hexToRgb);
const ELM_RAMPS = [E_1, E_2, E_3, E_GRN];

/* The redwood source's three needle families plus the turned green. */
const R_1 = ["#0a2820", "#12403a", "#1d6a52", "#34966e", "#6ec59a"].map(hexToRgb);
const R_2 = ["#0c2a1a", "#164a2a", "#276e3c", "#44985a", "#80c88a"].map(hexToRgb);
const R_3 = ["#10302c", "#1c4e48", "#2f7a6a", "#55a890", "#8fd4bc"].map(hexToRgb);
const R_GRN = ["#143a1a", "#2a6a2e", "#4a9e3e", "#7acb55", "#b6ec80"].map(hexToRgb);
const REDWOOD_RAMPS = [R_1, R_2, R_3, R_GRN];

const BIRCH_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.22,
  BX: W / 2,
  ROOTX: 400,
  ZM: 4.4,
  DYW: 2600,
  cellY: 36,
  cellW: 6,
  fxE: 0.12,
  fyE: 0.04,
  noiseL: 6,
  noiseY: 8,
  baseW: 24,
  fillCX: 404,
  baseCX: 400,
  baseRW: 62,
  WP: [
    [742, 150], [600, 132], [400, 118], [245, 106],
    [0, 94], [-1000, 84], [-3000, 70],
  ],
  wWdef: 60,
  acorn: false,
  ground: [
    [120, 84, 62],
    [96, 66, 50],
  ],
  blinkNear: 2.6,
  blinkWin: 0.1,
  clusterCX: 400,
  clusterCY: 300,
  clusterR: 330,
  mapleLeaf: false,  trunkCellY: 90,
  trunkCellMul: 9,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: true,
  barkStyle: "peel",
  trunkFracY: 245,
  trunkCxwAmp: 38,
  trunkLowW: 24,
  leafShape: "birch",
  leafRamps: BIRCH_RAMPS,
};

const BIRCH_GOLD = ["#fff4b0", "#f2d14e", "#e2b811", "#c99700", "#8a6d00"].map(
  hexToRgb,
);
const BIRCH_SPL: number[][] = [
  [164, 166, 172],
  [90, 92, 98],
];

/* The three sources' bark tables, verbatim. */
const BIRCH_WORLD = {
  BK: ["#2a2725", "#8d8a86", "#bcb9b3", "#d8d5cf", "#ebe8e2", "#f7f5ef"].map(hexToRgb),
  MS: ["#3a5030", "#4f7040", "#6a9c4c"].map(hexToRgb),
  LICH: hexToRgb("#d8b896"),
  AMB: ["#2a2624", "#4a443f", "#6a625a"].map(hexToRgb),
  FUN: [],
};

const ELM_WORLD = {
  BK: ["#16120f", "#272019", "#3a3128", "#4f443a", "#675a4d", "#82746a"].map(hexToRgb),
  MS: ["#26401f", "#3f6a2c", "#6a9c3c"].map(hexToRgb),
  LICH: hexToRgb("#aebf9c"),
  AMB: ["#6a3c12", "#c27a1c", "#f0b43c"].map(hexToRgb),
  FUN: [],
};

const REDWOOD_WORLD = {
  BK: ["#1c0e08", "#321810", "#4f2616", "#6e3620", "#8c4a2c", "#aa6240"].map(hexToRgb),
  MS: ["#1f4a2a", "#2f6a34", "#4a8a3c"].map(hexToRgb),
  LICH: hexToRgb("#a9b86a"),
  AMB: ["#4a1608", "#9a3a14", "#e07a3a"].map(hexToRgb),
  FUN: [],
};

const ELM_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.24,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.4,
  DYW: 2600,
  cellY: 88,
  cellW: 8,
  fxE: 0.15,
  fyE: 0.05,
  noiseL: 10,
  noiseY: 16,
  baseW: 22,
  fillCX: 402,
  baseCX: 400,
  baseRW: 130,
  WP: [
    [742, 175], [600, 152], [400, 136], [245, 124],
    [0, 110], [-1000, 98], [-3000, 84],
  ],
  wWdef: 90,
  acorn: false,
  ground: [
    [120, 84, 62],
    [96, 66, 50],
  ],
  blinkNear: 3.0,
  blinkWin: 0.12,
  clusterCX: 400,
  clusterCY: 330,
  clusterR: 330,
  mapleLeaf: false,  trunkCellY: 55,
  trunkCellMul: 7,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0.3,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.15,
  trunkGateY: 0.07,
  trunkDash: false,
  barkStyle: "lattice",
  trunkFracY: 245,
  trunkCxwAmp: 38,
  trunkLowW: 30,
  leafShape: "elm",
  leafRamps: ELM_RAMPS,
};

const REDWOOD_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.26,
  BX: W / 2,
  ROOTX: 400,
  ZM: 2.8,
  DYW: 3400,
  cellY: 52,
  cellW: 7,
  fxE: 0.13,
  fyE: 0.05,
  noiseL: 8,
  noiseY: 12,
  baseW: 22,
  fillCX: 402,
  baseCX: 400,
  baseRW: 110,
  WP: [
    [742, 260], [600, 230], [400, 200], [245, 180],
    [0, 160], [-1000, 140], [-3000, 110],
  ],
  wWdef: 110,
  acorn: false,
  ground: [
    [120, 84, 62],
    [96, 66, 50],
  ],
  blinkNear: 2.6,
  blinkWin: 0.09,
  clusterCX: 402,
  clusterCY: 230,
  clusterR: 300,
  mapleLeaf: false,  trunkCellY: 220,
  trunkCellMul: 5,
  trunkLatJ: 10,
  trunkYJ: 5,
  trunkLatLean: 0,
  trunkNoiseL: 0.9,
  trunkNoiseY: 0.008,
  trunkNoiseAmp: 0.35,
  trunkGateX: 0.2,
  trunkGateY: 0.02,
  trunkDash: false,
  barkStyle: "fibres",
  trunkFracY: 90,
  trunkCxwAmp: 20,
  trunkLowW: 22,
  leafShape: "redwood",
  leafRamps: REDWOOD_RAMPS,
};

/* The beanstalk's three leaflet greens plus the young green. */
const BN_1 = ["#0c3416", "#16601f", "#2c9a2c", "#5cc83e", "#a6ee6a"].map(hexToRgb);
const BN_2 = ["#2c4a0c", "#4f7a14", "#86b020", "#b8dc3c", "#e6f78a"].map(hexToRgb);
const BN_3 = ["#0a3a30", "#146050", "#228a62", "#44b886", "#8ee0b4"].map(hexToRgb);
const BN_GRN = ["#0e3a1a", "#1c6a28", "#38a834", "#6ed850", "#c4f58a"].map(hexToRgb);
const BEAN_RAMPS = [BN_1, BN_2, BN_3, BN_GRN];

/* The rose's two bloom colors, then the leaf green (used twice: the
   third family and the young foliage), drawn as sprigs. */
const RS_1 = ["#3a0716", "#780f2c", "#c4204a", "#ea4a74", "#ff93b0"].map(hexToRgb);
const RS_2 = ["#7a2a48", "#c4587c", "#ea85a6", "#fbb4ca", "#ffe3ec"].map(hexToRgb);
const RS_LEAF = ["#0c2a14", "#17481f", "#2a7430", "#4aa04a", "#88d076"].map(hexToRgb);
const ROSE_RAMPS = [RS_1, RS_2, RS_LEAF, RS_LEAF];

const BEAN_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.22,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.0,
  DYW: 3600,
  cellY: 52,
  cellW: 7,
  fxE: 0.13,
  fyE: 0.05,
  noiseL: 8,
  noiseY: 12,
  baseW: 18,
  fillCX: 404,
  baseCX: 400,
  baseRW: 64,
  WP: [
    [742, 84], [600, 74], [400, 66], [245, 60],
    [0, 54], [-1000, 50], [-3000, 44],
  ],
  wWdef: 54,
  acorn: false,
  ground: [
    [168, 104, 52],
    [222, 170, 96],
  ],
  blinkNear: 2.6,
  blinkWin: 0.09,
  clusterCX: 400,
  clusterCY: 320,
  clusterR: 320,
  mapleLeaf: false,  trunkCellY: 120,
  trunkCellMul: 6,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.5,
  trunkNoiseY: 0.02,
  trunkNoiseAmp: 0.25,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: false,
  barkStyle: "twist",
  trunkFracY: 80,
  trunkCxwAmp: 40,
  trunkCxwK: 0.0056,
  trunkLowW: 18,
  leafShape: "bean",
  leafRamps: BEAN_RAMPS,
  limbStyle: "twist",
};

const ROSE_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.24,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.4,
  DYW: 3000,
  cellY: 60,
  cellW: 8,
  fxE: 0.14,
  fyE: 0.05,
  noiseL: 8,
  noiseY: 12,
  baseW: 30,
  fillCX: 402,
  baseCX: 400,
  baseRW: 124,
  WP: [
    [742, 196], [600, 168], [400, 146], [245, 130],
    [0, 114], [-1000, 100], [-3000, 84],
  ],
  wWdef: 100,
  acorn: false,
  ground: [
    [170, 28, 40],
    [236, 86, 80],
  ],
  blinkNear: 3.0,
  blinkWin: 0.11,
  clusterCX: 402,
  clusterCY: 470,
  clusterR: 400,
  mapleLeaf: false,  trunkCellY: 90,
  trunkCellMul: 9,
  trunkLatJ: 9,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: false,
  barkStyle: "thorns",
  trunkFracY: 400,
  trunkCxwAmp: 56,
  trunkCxwK: 0.0042,
  trunkLowW: 30,
  leafShape: "rose",
  leafRamps: ROSE_RAMPS,
  altShape: "sprig",
  altRamps: [2, 3],
  limbStyle: "thorn",
};

const MAPLE_ART: Art = {
  leafPoints: 5,
  leafAmp: 0.26,
  BX: W / 2,
  ROOTX: 400,
  ZM: 3.6,
  DYW: 2600,
  cellY: 90,
  cellW: 9,
  fxE: 0.14,
  fyE: 0.03,
  noiseL: 7,
  noiseY: 8,
  baseW: 32,
  fillCX: 404,
  baseCX: 400,
  baseRW: 104,
  WP: [
    [742, 170], [600, 150], [400, 134], [245, 124],
    [0, 112], [-1000, 100], [-3000, 86],
  ],
  wWdef: 86,
  acorn: true,
  ground: [
    [140, 96, 52],
    [222, 198, 152],
  ],
  blinkNear: 3.4,
  blinkWin: 0.14,
  clusterCX: 402,
  clusterCY: 300,
  clusterR: 340,
  mapleLeaf: true,  trunkCellY: 90,
  trunkCellMul: 9,
  trunkLatJ: 7,
  trunkYJ: 8,
  trunkLatLean: 0,
  trunkNoiseL: 0.4,
  trunkNoiseY: 0.03,
  trunkNoiseAmp: 0.2,
  trunkGateX: 0.14,
  trunkGateY: 0.03,
  trunkDash: false,
  barkStyle: "plates",
  trunkFracY: 245,
  trunkCxwAmp: 38,
  trunkLowW: 32,
  leafShape: "maple",
};

/* The oak's exact palettes, verbatim from the reference. */
const MAPLE_PALETTE: Palette = {
  bark: ["#211c1a", "#383230", "#524a45", "#70665e"],
  foliage: ["#4a0a12", "#861418", "#c42a1c", "#e8472a", "#ff7a4d"],
  accent: "#4a6a34",
  cream: ["#c9741a", "#a8481a", "#d9a21b"],
};

const BIRCH_PALETTE: Palette = {
  bark: ["#5a5652", "#9c9892", "#c8c4bc", "#e6e2da"],
  foliage: ["#6b4a0a", "#a8740f", "#d9a21b", "#f2c53a", "#ffe16b"],
  accent: "#2a2624",
  cream: ["#d9c030", "#b8a418", "#8a7a3a"],
};

const ELM_PALETTE: Palette = {
  bark: ["#1f1b18", "#35302b", "#4d453d", "#6a6056"],
  foliage: ["#7a4a08", "#b87a14", "#e0a028", "#f5c042", "#ffe070"],
  accent: "#4a6a34",
  cream: ["#d9a21b", "#b8821a", "#8a6a3a"],
};

const REDWOOD_PALETTE: Palette = {
  bark: ["#2a1208", "#4a2214", "#6e3620", "#8c4a2c"],
  foliage: ["#0c2a1a", "#164a2a", "#276e3c", "#44985a", "#80c88a"],
  /* (R_2 — the source's middle needle family, listed verbatim) */
  accent: "#3f6a30",
  cream: ["#2f6a34", "#4a8a3c", "#8a4a2a"],
};

const BEAN_PALETTE: Palette = {
  bark: ["#173a12", "#2a5a1c", "#43822a", "#6ab43c"],
  foliage: ["#0e3a1a", "#1c6a28", "#38a834", "#6ed850", "#c4f58a"],
  accent: "#3a6a28",
  cream: ["#e8f5a0", "#c8e070", "#8fba3a"],
};

const ROSE_PALETTE: Palette = {
  bark: ["#1a0d14", "#2e1522", "#4a2236", "#6a3550"],
  foliage: ["#4a0a1e", "#8a1236", "#d81f5b", "#f0507e", "#ff9cbc"],
  accent: "#3a6a30",
  cream: ["#ffd6e2", "#ffb3cb", "#e88aa8"],
};

const BEAN_WORLD = {
  BK: ["#0d2a10", "#173d14", "#245a1c", "#357f26", "#52a838", "#86d055"].map(hexToRgb),
  MS: ["#1f4a1a", "#2f7a26", "#58a83a"].map(hexToRgb),
  LICH: hexToRgb("#b8d98a"),
  AMB: ["#2a5a14", "#6ab032", "#d4f060"].map(hexToRgb),
  FUN: [],
};

const ROSE_WORLD = {
  BK: ["#150a10", "#27121d", "#3f1f30", "#5a2f46", "#7e4864", "#e8c8a0"].map(hexToRgb),
  MS: ["#1f4a2a", "#36783a", "#5aa04a"].map(hexToRgb),
  LICH: hexToRgb("#d8b8c8"),
  AMB: ["#5a1230", "#c02a5e", "#ff7aa6"].map(hexToRgb),
  FUN: [],
};

const OAK_PALETTE: Palette = {
  bark: ["#1e1610", "#32261b", "#4a3a2a", "#66523b"],
  foliage: ["#0f2a16", "#1d4a22", "#2f7a2e", "#4fa83e", "#8fd45c"],
  accent: "#4a6a34",
  cream: ["#8a7a4a", "#a08a52", "#5f7a3a"],
};

const OAK_WORLD = {
  BK: ["#16110d", "#241b14", "#352a20", "#4a3c2e", "#605040", "#7d6a55"].map(
    hexToRgb,
  ),
  MS: ["#26401f", "#3f6a2c", "#6a9c3c"].map(hexToRgb),
  LICH: hexToRgb("#aebf9c"),
  AMB: ["#6a3c12", "#c27a1c", "#f0b43c"].map(hexToRgb),
  FUN: ["#e2c58a", "#c79a54", "#7a5a30"].map(hexToRgb),
};

const MAPLE_WORLD = {
  BK: ["#1a1514", "#2a2422", "#3d3532", "#554b46", "#70655d", "#8f8379"].map(
    hexToRgb,
  ),
  LICH: hexToRgb("#aebf9c"),
  AMB: ["#6a3c12", "#c27a1c", "#f0b43c"].map(hexToRgb),
  SPL: ["#a4a6ac", "#5a5c62"].map(hexToRgb),
  MS: ["#26401f", "#3f6a2c", "#6a9c3c"].map(hexToRgb),
};

function mixRgb(a: number[], b: number[], t: number): number[] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/* The tree opens at the growth it was given (the player's real
   progress) and follows later changes at this speed, in growth per
   second. It is the same fast pace in both directions, so feeding
   the tree and stepping back to an earlier stage move alike; callers
   that want a visible tween animate the `growth` they pass. A whole
   journey at this rate takes a quarter of a second to catch up, so it
   never lags the caller's own animation. */
const FOLLOW_RATE = 4;

export default function PixelGrowthTree({
  speciesId,
  growth,
  onTreeClick,
  cssScale,
  static: staticFrame = false,
  variantId = "original",
  layersOff,
  charms,
  onCreature,
}: {
  speciesId: TreeSpeciesId;
  /** 0..1 — the fertilizer position on the reference's timeline
   *  (20 packets take the acorn to the ancient oak). */
  growth: number;
  /** A plain click on the tree. */
  onTreeClick?: () => void;
  /** Css pixels per art pixel: the tree is drawn at exactly this
   *  whole-device-pixel scale, the same as the backdrop's, so the two
   *  share one pixel grid. */
  cssScale?: number;
  /** Paint ONE frame at `growth` and stop: no growth replay, no
   *  idle sway — used for the small card snapshots. */
  static?: boolean;
  /** A painted color variant of the species ("original" by default). */
  variantId?: string;
  /** Scenery the player has switched off (see SCENE_LAYERS). */
  layersOff?: string[];
  /** The garden charms switched on (cheat words, see data/charms.ts). */
  charms?: string[];
  /** A creature (squirrel, jay, sylph ...) was clicked or tapped. */
  onCreature?: (kind: string) => void;
}) {
  /* Creatures can be poked. `pokes` holds when each was last poked (in
     seconds on the render clock), `hits` where each is on screen this
     frame, `hover` the one the pointer is over. */
  const pokesRef = useRef<Record<string, number>>({});
  const hitsRef = useRef<{ key: string; x: number; y: number; w: number; h: number }[]>([]);
  const hoverRef = useRef<string | null>(null);
  /* when each field rose was last double-clicked (render clock, seconds) */
  const burstRef = useRef<Record<string, number>>({});
  const creatureAt = (clientX: number, clientY: number): string | null => {
    const canvas = ref.current;

    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;

    for (let i = hitsRef.current.length - 1; i >= 0; i--) {
      const h = hitsRef.current[i];

      if (x >= h.x - 2 && x <= h.x + h.w + 2 && y >= h.y - 2 && y <= h.y + h.h + 2) {
        return h.key;
      }
    }

    return null;
  };
  const layersRef = useRef<ReadonlySet<string>>(new Set());
  layersRef.current = new Set(layersOff ?? []);
  /* What the creatures remember between frames (where they are, what they
     are doing), so they can walk to their next spot and follow the tree. */
  const memoRef = useRef<Map<string, unknown>>(new Map());
  const charmsRef = useRef<readonly string[]>([]);
  charmsRef.current = charms ?? [];
  const ref = useRef<HTMLCanvasElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const dispRef = useRef(growth);
  const [reduced] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  /* Until the stage has been measured the tree is drawn at 3x. */
  const pxScale = cssScale ?? 3;

  const shape = SHAPES[speciesId];
  const species = treeSpecies(speciesId);
  const pal =
    speciesId === "crimson"
      ? MAPLE_PALETTE
      : speciesId === "oak"
        ? OAK_PALETTE
        : speciesId === "birch"
          ? BIRCH_PALETTE
          : speciesId === "elm"
            ? ELM_PALETTE
            : speciesId === "redwood"
              ? REDWOOD_PALETTE
              : speciesId === "beanstalk"
                ? BEAN_PALETTE
                : speciesId === "rosevine"
                  ? ROSE_PALETTE
                  : ramps(species.leafLight, species.leaf, species.leafDeep);
  const art = speciesId === "oak"
    ? OAK_ART
    : speciesId === "crimson"
      ? MAPLE_ART
      : speciesId === "birch"
        ? BIRCH_ART
        : speciesId === "elm"
          ? ELM_ART
          : speciesId === "redwood"
            ? REDWOOD_ART
            : speciesId === "beanstalk"
              ? BEAN_ART
              : speciesId === "rosevine"
                ? ROSE_ART
                : CRIMSON_ART;
  const speciesKey = `${speciesId}:${species.label}`;

  /* The growth prop ref, read by the animation loop. */
  const growthRef = useRef(growth);
  growthRef.current = growth;
  useEffect(() => {
    /* A new tree, or a fresh mount (reload, tab switch): show the
       real progress at once rather than replaying from the acorn. */
    dispRef.current = clamp(growthRef.current, 0, 1);
  }, [speciesKey]);


  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    offRef.current = document.createElement("canvas");
    offRef.current.width = W;
    offRef.current.height = H;
    const off = offRef.current.getContext("2d");
    if (!off) return;

    const img = off.createImageData(W, H);
    const buf = img.data;
    const cov = new Uint8Array(W * H);

    /* ---- species art tables ---- */
    /* The painted variant: foliage turns in hue, bark is washed with a
       tint. The original variant leaves every color untouched. */
    const VARIANT = resolveVariant(speciesId, variantId);
    const tf = (c: number[]) => tintFoliage(VARIANT, c);
    const tb = (c: number[]) => tintBark(VARIANT, c);
    const tfAll = (ramp: number[][]) => ramp.map(tf);
    const BARK = pal.bark.map(hexToRgb).map(tb);
    const FOLI = pal.foliage.map(hexToRgb).map(tf);
    const MOSS = tf(hexToRgb(pal.accent));
    const CREAM = pal.cream.map(hexToRgb);
    const ACN = art.ground;
    let BK: number[][];
    let MS: number[][];
    let LICH: number[];
    let AMB: number[][];
    let FUN: number[][];
    let SPL: number[][] = [];
    if (speciesId === "oak") {
      BK = OAK_WORLD.BK;
      MS = OAK_WORLD.MS;
      LICH = OAK_WORLD.LICH;
      AMB = OAK_WORLD.AMB;
      FUN = OAK_WORLD.FUN;
    } else if (speciesId === "crimson") {
      BK = MAPLE_WORLD.BK;
      MS = MAPLE_WORLD.MS;
      LICH = MAPLE_WORLD.LICH;
      AMB = MAPLE_WORLD.AMB;
      SPL = MAPLE_WORLD.SPL;
    } else if (speciesId === "elm") {
      BK = ELM_WORLD.BK;
      MS = ELM_WORLD.MS;
      LICH = ELM_WORLD.LICH;
      AMB = ELM_WORLD.AMB;
      FUN = ELM_WORLD.FUN;
      SPL = [];
    } else if (speciesId === "redwood") {
      BK = REDWOOD_WORLD.BK;
      MS = REDWOOD_WORLD.MS;
      LICH = REDWOOD_WORLD.LICH;
      AMB = REDWOOD_WORLD.AMB;
      FUN = REDWOOD_WORLD.FUN;
      SPL = [];
    } else if (speciesId === "beanstalk" || speciesId === "rosevine") {
      const W2 = speciesId === "beanstalk" ? BEAN_WORLD : ROSE_WORLD;

      BK = W2.BK;
      MS = W2.MS;
      LICH = W2.LICH;
      AMB = W2.AMB;
      FUN = W2.FUN;
      SPL = [];
    } else if (speciesId === "birch") {
      BK = BIRCH_WORLD.BK;
      MS = BIRCH_WORLD.MS;
      LICH = BIRCH_WORLD.LICH;
      AMB = BIRCH_WORLD.AMB;
      SPL = BIRCH_SPL;
      FUN = BIRCH_WORLD.FUN;
    } else {
      BK = [0, 1, 2, 3, 4, 5].map((i) => mixRgb(BARK[0], BARK[3], i / 5));
      BK[0] = mixRgb(BK[0], [0, 0, 0], 0.35);
      MS = [
        mixRgb(MOSS, [0, 0, 0], 0.4),
        MOSS,
        mixRgb(MOSS, [255, 255, 255], 0.3),
      ];
      LICH = mixRgb(MOSS, [255, 255, 255], 0.55);
      AMB = FOLI;
      FUN = [];
    }
    if (VARIANT.id !== "original" && speciesId in SPECIES_STAGE_FERT) {
      BK = BK.map(tb);
      MS = MS.map(tf);
      LICH = tb(LICH);
    }
    /* Leaf color sets, in the variant's colors. */
    const LEAF_RAMPS = art.leafRamps ? art.leafRamps.map(tfAll) : null;
    /* Ramps drawn with the species' second leaf design (the rose's sprigs). */
    const ALT_RAMPS = new Set<number[][]>(
      LEAF_RAMPS && art.altRamps ? art.altRamps.map((i) => LEAF_RAMPS[i]) : [],
    );
    const MAPLE_R = MAPLE_RAMPS.map(tfAll);
    const TURN_R = art.turnRamp ? tfAll(art.turnRamp) : undefined;

    const put = (x: number, y: number, c: number[]) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = 255;
    };

    /* Semi-transparent paint (clouds): blended over whatever is
       already there, so the drift reads on every backdrop theme. */
    const blendPut = (x: number, y: number, c: number[], a: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      const ia = buf[o + 3] / 255;
      const oa = a + ia * (1 - a);
      if (oa <= 0.004) return;
      buf[o] = Math.round((c[0] * a + buf[o] * ia * (1 - a)) / oa);
      buf[o + 1] = Math.round((c[1] * a + buf[o + 1] * ia * (1 - a)) / oa);
      buf[o + 2] = Math.round((c[2] * a + buf[o + 2] * ia * (1 - a)) / oa);
      buf[o + 3] = Math.round(oa * 255);
    };

    /* put() when fully opaque; blendPut() for fade-in/out passes —
       the fast path stays untouched. */
    const paint = (x: number, y: number, c: number[], a = 1) => {
      if (a >= 0.995) put(x, y, c);
      else blendPut(x, y, c, a);
    };

    const R2 = rng(11);

    /* The beanstalk is slim and sways a little: higher up the stalk
       leans further, in a slow wave. The lean is a couple of screen
       pixels at any zoom, so it stays a gentle sway rather than a
       swing, and it is applied wherever the tree is placed (limbs,
       leaves, the climbing trunk) so everything moves together. */
    const isBean = speciesId === "beanstalk";
    let BEND_T = 0;
    let CURSG = 1;
    const bendWorld = (wy: number, sg: number): number =>
      isBean && !reduced
        ? (1.9 / (S * Math.max(sg, 0.05))) *
          Math.sin(BEND_T * 0.85 + wy * 0.0072) *
          clamp((742 - wy) / 420, 0, 1)
        : 0;


    /* ---- pollen dust (the reference's own sprinkle) ---- */
    const SP: [number, number, number[], number][] = [];
    for (let i = 0; i < 280; i++) {
      const x = Math.round(
        art.BX + (R2() + R2() + R2() - 1.5) * 40,
      );
      const yv = Math.round(GROUND_ROW + (R2() - 0.5) * 3.4);
      SP.push([
        x,
        yv,
        CREAM[(R2() * 3) | 0],
        Math.abs(x - art.BX) / 70 * 0.2,
      ]);
    }

    /* ---- canopy clusters (per species) ---- */
    const leaves: {
      x: number; y: number; r: number; ph: number; tone: number; b: number;
      pal: number; sw: number;
    }[] = [];
    const cluster = (
      cx: number,
      cy: number,
      rx: number,
      ry: number,
      tb: number,
      start: number,
      lo = 3,
      hi = 4.8,
    ) => {
      const la = (lo + hi) / 2;
      const n = Math.ceil((rx * ry * S * S) / (la * la * 0.3));
      for (let i = 0; i < n * 1.35; i++) {
        const edge = i >= n;
        const u = edge ? 0.95 + R2() * 0.15 : Math.sqrt(R2());
        const a2 = R2() * 6.283;
        const dx = Math.cos(a2) * u;
        const dy = Math.sin(a2) * u;
        const lr = edge ? 1.5 + R2() * 1 : lo + R2() * (hi - lo);
        leaves.push({
          x: (cx + dx * rx) * S,
          y: (cy + dy * ry) * S,
          r: lr,
          ph: R2() * 6.283,
          tone: tb - 0.22 * dy + (R2() - 0.5) * 0.2 + (edge ? 0.12 : 0),
          b: start + 0.09 * Math.hypot(dx, dy) + R2() * 0.03,
          /* maple leaves hold a hue — gold, orange, or crimson —
             and a growth threshold at which they turn. */
          pal: (() => {
            const q = R2() + dy * 0.18;
            return q < 0.3 ? 0 : q < 0.7 ? 1 : 2;
          })(),
          sw: 0.55 + 0.38 * R2(),
        });
      }
    };
    shape.clusters.forEach((c) => {
      const start =
        0.36 +
        0.36 *
          clamp(
            Math.hypot(c.cx - art.clusterCX, c.cy - art.clusterCY) / art.clusterR,
            0,
            1,
          );
      cluster(c.cx, c.cy, c.rx, c.ry, c.tone, start, c.lo, c.hi);
    });
    for (const c of shape.elder) {
      cluster(c.cx, c.cy, c.rx, c.ry, c.tone, c.start ?? 0.9, c.lo ?? 2.2, c.hi ?? 3.6);
    }
    /* Loose foliage above the crown: a handful of small clusters
       scattered at random around the canopy's top, real late so
       the tree keeps dressing up as it finishes. */
    const topN = shape.topFoliage ?? 5;
    for (let i = 0; i < topN; i += 1) {
      const ang = R2() * 6.283;
      const rad = art.clusterR * (0.22 + R2() * 0.3);
      const tcxx = art.clusterCX + Math.cos(ang) * rad;
      const tcy = art.clusterCY - 150 - R2() * 110;
      cluster(
        tcxx,
        tcy,
        22 + R2() * 20,
        14 + R2() * 12,
        0.55 + R2() * 0.3,
        0.72 + R2() * 0.26,
        1.8,
        3.2,
      );
    }
    leaves.sort((a, b) => a.y - b.y);

    /* ---- limbs (trunk + branches) with the reference's g0/gd ---- */
    const TR = {
      sp: spline(shape.trunk, 24),
      ws: shape.trunkW,
      g0: 0.03,
      gd: 0.2,
    };
    const BR = shape.branches.map((b) => ({
      sp: spline(b.pts, 24),
      ws: b.ws,
      g0: 0.18 + b.b0 * 1.2,
      gd: b.dur * 1.2,
    }));

    const limb = (
      o: { sp: number[][]; ws: number[]; g0: number; gd: number },
      g: number,
      sg: number,
      kx: number,
    ) => {
      const N = o.sp.length;
      const uM = clamp((g - o.g0) / o.gd, 0, 1);
      const salt = (o.g0 * 100 + 20) | 0;
      if (uM <= 0) return;
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        if (u > uM) break;
        const [X, Y] = pt(o, u, sg, kx);
        const w = (lerpArr(o.ws, u) * S * sg) / 2;
        for (let py = Math.floor(Y - w - 1); py <= Math.ceil(Y + w + 1); py++) {
          for (let px = Math.floor(X - w - 1); px <= Math.ceil(X + w + 1); px++) {
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const dx = px + 0.5 - X;
            const dy = py + 0.5 - Y;
            if (dx * dx + dy * dy > w * w + 0.2) continue;
            const k = py * W + px;
            if (cov[k]) continue;
            cov[k] = 1;
            const n = clamp(dx / (w + 0.5), -1, 1);
            const band = Math.floor((n + 1) * 2.6) + salt * 8;
            let v = 0.5 - 0.34 * n + (hash(i >> 2, band) - 0.5) * 0.42;
            /* the beanstalk's limbs are ropes: strands wound round them */
            if (art.limbStyle === "twist") v += 0.3 * Math.sin(i * 0.42 + n * 2.6);
            if (hash(px, py + 7) >= DM) {
              put(
                px,
                py,
                hash(i >> 2, band + 40) > 0.94
                  ? MOSS
                  : BARK[clamp(Math.floor(v * 4), 0, 3)],
              );
            }
          }
        }
        /* the rose's canes are armed: a thorn every so often, pointing
           out and down */
        if (art.limbStyle === "thorn" && w > 0.9 && i % 4 === 2 && hash(i, 31) > 0.3) {
          const side = hash(i, 32) > 0.5 ? 1 : -1;
          const tx = Math.round(X + side * (w + 0.6));
          const ty = Math.round(Y);

          put(tx, ty, BK[5]);
          put(tx + side, ty + 1, BK[5]);
          put(tx + side * 2, ty + 2, BK[4]);
          put(tx, ty + 1, BK[1]);
        }
      }
    };

    /* ---- world-trunk profile tables (species-shaped) ---- */
    const RX = new Float32Array(800).fill(art.fillCX);
    const RW = new Float32Array(800).fill(art.baseW);
    for (let y = 743; y < 800; y++) {
      RX[y] = art.baseCX;
      RW[y] = art.baseRW;
    }
    for (let i = 0; i < TR.sp.length - 1; i++) {
      const a = TR.sp[i];
      const b = TR.sp[i + 1];
      const ua = i / (TR.sp.length - 1);
      const ub = (i + 1) / (TR.sp.length - 1);
      for (let y = Math.ceil(b[1]); y <= Math.floor(a[1]); y++) {
        const f = (a[1] - y) / (a[1] - b[1] || 1);
        RX[y] = a[0] + (b[0] - a[0]) * f;
        RW[y] = lerpArr(TR.ws, ua + (ub - ua) * f);
      }
    }
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
    const wW = (y: number) => {
      for (let i = 0; i < 6; i++) {
        if (y >= art.WP[i + 1][0]) {
          const a = art.WP[i];
          const b = art.WP[i + 1];
          return a[1] + (b[1] - a[1]) * (a[0] - y) / (a[0] - b[0]);
        }
      }
      return art.wWdef;
    };
    const cxw = (y: number) =>
      (y >= art.trunkFracY
        ? RX[clamp(Math.round(y), 0, 799)]
        : art.fillCX +
          art.trunkCxwAmp *
            Math.sin((art.trunkFracY - y) * (art.trunkCxwK ?? 0.0023))) +
      bendWorld(y, CURSG);

    /* ---- ancient-ascent decor ----
       The climb above the mature canopy would otherwise be a bare
       bark tunnel: the authored branches/clusters stop a little
       above the crown, but the world-trunk keeps rising for
       DYW more world-units. Seed a sparse ladder of branch stubs
       and leaf tufts up that same stretch (deterministic per
       species, so remounts don't reshuffle it) so the climb keeps
       reading as a living tree instead of pure texture. */
    const AR2 = rng(speciesId.length * 97 + 13);
    /* The summit: where the climb ends, the trunk gives out into a
       spreading crown. In world units, a little above the frame's
       center at the top of the climb, so it sits near the top of the
       screen when the camera arrives. */
    const SUMMIT_Y = 742 - art.DYW - 160;
    const SUMMIT_ROOM = (W / 2 - 6) / (S * art.ZM);
    const ascentStubs: {
      sp: number[][];
      ws: number[];
      tipX: number;
      tipY: number;
      lr: number[];
      side: number;
      /** Only the last twigs of a branch carry leaves; the limbs between
       *  are bare bark. */
      leafy: boolean;
    }[] = [];
    {
      const top = -40;
      const bottom = 742 - art.DYW + 60;

      /* A binary-tree fractal: every limb ends in a fork of two, one
         dominant and one shorter, each thinner and leaning a little back
         toward the light. The same rule makes a bough, its branches and
         its twigs, so the climb reads as one tree rather than a stack of
         sticks. Only the ends of the last forks carry leaves. */
      const grow = (
        x0: number,
        y0: number,
        ang: number,
        len: number,
        w: number,
        depth: number,
        leafSize: number,
      ) => {
        const bow = (AR2() - 0.5) * 0.4;
        const tx = x0 + Math.sin(ang) * len;
        const ty = y0 - Math.cos(ang) * len;
        const mx = x0 + Math.sin(ang + bow) * len * 0.5;
        const my = y0 - Math.cos(ang + bow) * len * 0.5;
        const wTip = w * 0.6;
        const terminal = depth === 0;

        ascentStubs.push({
          sp: spline(
            [
              [x0, y0],
              [mx, my],
              [tx, ty],
            ],
            12,
          ),
          ws: [w, (w + wTip) / 2, wTip],
          tipX: tx,
          tipY: ty,
          lr: [
            terminal ? leafSize * (0.8 + 0.5 * AR2()) : 3,
            0.45 + AR2() * 0.35,
          ],
          side: Math.sin(ang) >= 0 ? 1 : -1,
          leafy: terminal,
        });

        if (terminal) return;

        const spread = 0.4 + AR2() * 0.3;
        const lead = AR2() < 0.5 ? 1 : -1;
        const a1 = clamp((ang + lead * spread * 0.7) * 0.93, -1.9, 1.9);
        const a2 = clamp((ang - lead * spread) * 0.93, -1.9, 1.9);

        grow(tx, ty, a1, len * (0.74 + 0.08 * AR2()), wTip, depth - 1, leafSize);
        grow(tx, ty, a2, len * (0.54 + 0.1 * AR2()), wTip * 0.85, depth - 1, leafSize);
      };

      const room = (W / 2 - 12) / (S * art.ZM);
      let side = AR2() < 0.5 ? -1 : 1;
      let y = top;

      while (y > bottom) {
        side = -side * (AR2() < 0.78 ? 1 : -1);
        const cx = cxw(y);
        const halfW = Math.max(4, wW(y) / 2);
        const climb = clamp((top - y) / (top - bottom), 0, 1);

        grow(
          cx + side * halfW * 0.35,
          y + 6,
          side * (0.95 + 0.3 * AR2()),
          clamp(halfW * (0.9 + 0.5 * AR2()), 20, room / 2.2),
          Math.max(4, halfW * 0.5),
          2,
          (9 + AR2() * 7) * (1 + climb * 0.7),
        );
        y -= 92 + AR2() * 78;
      }

      /* The summit: the trunk ends in a spread of boughs, two leaders
         reaching up and the rest out and up, each forking three times. */
      for (let i = 0; i < 9; i++) {
        const sd = i % 2 === 0 ? -1 : 1;
        const y0 = SUMMIT_Y + 30 + i * 32 + AR2() * 12;
        const cx = cxw(y0);
        const halfW = Math.max(4, wW(y0) / 2);
        const leader = i < 2;

        grow(
          cx + sd * halfW * 0.3,
          y0 + 6,
          sd * (leader ? 0.2 : 0.7 + 0.5 * AR2()),
          clamp(halfW * (leader ? 2 : 1.5), 24, SUMMIT_ROOM / 2),
          Math.max(4, halfW * (leader ? 0.55 : 0.48)),
          3,
          12 + AR2() * 8,
        );
      }

      /* Twigs straight off the trunk between the limbs: short, thin and
         frequent, so the bark is never a bare column for long. */
      {
        let ty = top - 40;
        let tside = AR2() < 0.5 ? -1 : 1;

        while (ty > bottom) {
          tside = -tside;
          const cx = cxw(ty);
          const halfW = Math.max(4, wW(ty) / 2);
          const len = halfW * (0.5 + 0.55 * AR2());
          const lift = 10 + AR2() * 18;
          const w0 = Math.max(2.4, halfW * 0.2);
          const x0 = cx + tside * halfW * 0.4;
          const x1 = cx + tside * (halfW * 0.7 + len * 0.55);
          const x2 = cx + tside * (halfW * 0.5 + len);

          ascentStubs.push({
            sp: spline(
              [
                [x0, ty + 4],
                [x1, ty - lift * 0.4],
                [x2, ty - lift],
              ],
              10,
            ),
            ws: [w0, w0 * 0.5, w0 * 0.2],
            tipX: x2,
            tipY: ty - lift,
            lr: [5 + AR2() * 5, 0.4 + AR2() * 0.3],
            side: tside,
            leafy: true,
          });
          ty -= 44 + AR2() * 40;
        }
      }
    }

    /* The summit canopy: clumps of leaves in two depth layers around
       the top of the trunk, one behind the bark and one in front, so
       the boughs weave through foliage. Positions are world units. */
    const CANOPY: {
      x: number;
      y: number;
      r: number;
      tone: number;
      layer: 0 | 1;
      ph: number;
    }[] = [];
    {
      const ccx = cxw(SUMMIT_Y);

      /* The beanstalk's summit is sparse: it opens out onto clouds and the
         giant's castle instead of closing over in leaves. */
      const sparse = speciesId === "beanstalk" || speciesId === "rosevine";

      while (CANOPY.length < (speciesId === "beanstalk" ? 36 : sparse ? 36 : 300)) {
        const a = AR2() * 6.283;
        const d = Math.sqrt(AR2());
        const y = (sparse ? SUMMIT_Y + 60 : SUMMIT_Y - 70) + Math.sin(a) * d * (sparse ? 110 : 190);

        if (y > SUMMIT_Y + 90) continue;

        CANOPY.push({
          x: ccx + Math.cos(a) * d * SUMMIT_ROOM * 1.15,
          y,
          r: 15 + AR2() * 17,
          tone: 0.42 + AR2() * 0.38,
          layer: AR2() < 0.5 ? 0 : 1,
          ph: AR2() * 6.3,
        });
      }
    }

    /* Clouds at the summit, in screen pixels: some drift behind the
       crown, some pass in front, soft and translucent. */
    const SUMMIT_CLOUDS = Array.from({ length: 8 }, (_, i) => {
      const front = i >= 4;
      const w = front ? 70 + AR2() * 50 : 70 + AR2() * 60;
      const h = front ? 14 + AR2() * 8 : 16 + AR2() * 10;

      return {
        x: AR2() * (W + 80) - 40,
        y: front ? 48 + AR2() * 62 : 4 + AR2() * 34,
        w,
        h,
        v: (front ? 3.2 : 1.6) * (0.7 + AR2() * 0.6),
        front,
        /* a cumulus: tall in the middle, small low puffs at the sides */
        blobs: Array.from({ length: 6 }, (_, k) => {
          const ox = 0.14 + (k / 5) * 0.72 + (AR2() - 0.5) * 0.04;
          const mid = Math.sin(Math.PI * ox);

          return {
            ox,
            oy: 0.72 - 0.34 * mid + (AR2() - 0.5) * 0.06,
            r: 0.07 + 0.1 * mid + AR2() * 0.03,
          };
        }),
      };
    });

    /* ---- camera anchors shared with the limb painter ---- */
    let AX = art.BX;
    let XF = art.ROOTX;
    let YF = 742;
    let DY = 0;
    let DM = 0;
    let GG = 0;

    const pt = (
      o: { sp: number[][]; ws: number[]; g0: number; gd: number },
      u: number,
      sg: number,
      kx: number,
    ) => {
      const p = o.sp[Math.min(o.sp.length - 1, Math.floor(u * (o.sp.length - 1)))];
      return [
        AX + (p[0] + bendWorld(p[1], sg) - XF) * S * sg * kx,
        AY + (p[1] - YF) * S * sg,
      ];
    };
    const AY = H - 9.3;

    /* ---- Mature-to-Ancient motion ----
       From the Mature stage the tree comes alive: buttress roots with a
       sap pulse rising toward the trunk (the root view lasts while the
       camera is still near the ground), and, higher in the climb, vines
       and leaf tufts that sway in the wind with a slow wave of light
       through the leaves. Everything steps at the pixel-art cadence
       (MOTION_HZ) and moves in whole art pixels. Colors come from the
       species' own tables: bark and moss for the roots, the resin ramp
       for the sap (birch's resin ramp is ash gray, so it takes its
       golden-cream ramp instead), the foliage ramp for the shimmer. */
    const matureG =
      (SPECIES_STAGE_FERT[speciesId]?.[4] ?? 2000) / TREE_GROWTH_TARGET;
    /* ---- sky friends: clouds drift past and birds rest on the
          canopy once the tree reaches the Mature stage ---- */
    const skyRng = rng(31);
    const clouds = Array.from({ length: 3 }, () => ({
      x: skyRng() * W,
      y: 6 + skyRng() * 30,
      w: 22 + skyRng() * 16,
      h: 5 + skyRng() * 3,
      v: 1.5 + skyRng() * 2.5,
      ph: skyRng() * 6.283,
    }));
    /* The canopy's top leaves, once the crown is nearly whole — where the
       birds perch. (The crown's growth `g` runs 0..1 over the first phase
       of the climb; it is not the fertilizer fraction `matureG` is.) */
    const BIRDS_AT = 0.9;
    const perches = [...leaves]
      .filter((L) => L.b <= BIRDS_AT - 0.05)
      .sort((a, b) => a.y - b.y)
      .slice(0, 10);
    /* 0 while the birds are away, 1 once they have landed: they fly in
       when the crown fills out and lift off when the tree shrinks. */
    let BIRDS_HERE = 0;

    const SAP =
      speciesId === "birch"
        ? [BIRCH_GOLD[3], BIRCH_GOLD[2], BIRCH_GOLD[1]]
        : AMB;
    const ROOTS = makeRoots(
      rng(speciesId.length * 131 + 7),
      cxw(742),
      (wW(742) * 1.8) / 2,
      742,
    );
    const ROOT_TOP = Math.min(...ROOTS.map((r) => r.box.y0));
    let MT = 0;
    let ROOT_LIFE = 0;
    let LEAF_LIFE = 0;
    /* How far the roots have crept out from the trunk (0..1), and the
       world height where the ancient bark currently ends. */
    let ROOT_REACH = 1;
    let TRUNK_TOP = -1e9;
    /* the render clock in seconds, the same one that pokes are stamped with */
    let CLOCK = 0;
    /* Where the young trunk ends, in world units: it stops inside the
       crown, so the bark that takes over has to climb out of it. */
    const YOUNG_TOP = TR.sp[TR.sp.length - 1][1];

    /* Which root (and where along it) covers each screen pixel. The
       camera only moves while the tree grows, so the mask is rebuilt
       when it does, not every frame. */
    const rootMask = {
      key: "",
      root: new Int8Array(W * H),
      t: new Float32Array(W * H),
      n: new Float32Array(W * H),
    };
    const ROOT_CX = cxw(742);
    const refreshRootMask = (Z: number, e: number) => {
      /* The roots' foot sits at the FULL trunk's width; while the bark is
         still widening from the young trunk they are drawn squeezed in
         toward the axis, so they always meet the trunk. */
      const squeeze = clamp(
        (RW[742] * (1 - e) + wW(742) * e) / wW(742),
        0.3,
        1,
      );
      const key = `${AX.toFixed(3)}|${XF.toFixed(3)}|${YF.toFixed(3)}|${Z.toFixed(4)}|${ROOT_REACH.toFixed(3)}|${squeeze.toFixed(3)}`;
      if (rootMask.key === key) return;
      rootMask.key = key;
      rootMask.root.fill(-1);
      const pq = S * Z;
      for (let sy = 0; sy < H; sy++) {
        const wy = YF + (sy + 0.5 - AY) / pq;
        if (wy < ROOT_TOP || wy > 748) continue;
        for (let sx = 0; sx < W; sx++) {
          const wx = XF + (sx + 0.5 - AX) / pq;
          const hit = rootAt(
            ROOTS,
            ROOT_CX + (wx - ROOT_CX) / squeeze,
            wy,
            ROOT_REACH,
          );
          if (!hit) continue;
          const i = sy * W + sx;
          rootMask.root[i] = hit.root;
          rootMask.t[i] = hit.t;
          rootMask.n[i] = hit.n;
        }
      }
    };
    const rootPx = (sx: number, sy: number): number[] | null => {
      const i = sy * W + sx;
      const ri = rootMask.root[i];
      if (ri < 0) return null;
      const t = rootMask.t[i];
      const n = rootMask.n[i];

      /* The reference's roots are dark, chunky and ragged at the edge. */
      if (Math.abs(n) > 0.74 && hash(sx * 3 + ri * 7, sy * 11) < 0.42) {
        return null;
      }
      let idx = n < -0.35 ? 3 : n < 0.25 ? 2 : n < 0.7 ? 1 : 0;
      if (Math.abs(n) > 0.88) idx = 0;
      const grain = hash(sx * 5 + ri * 13, sy * 3);
      if (grain > 0.86) idx = Math.max(0, idx - 1);
      else if (grain < 0.08) idx = Math.min(5, idx + 1);
      let col = BK[idx];

      if (n < -0.1 && hash(sx * 7 + ri, sy * 5) < 0.12 + 0.3 * t) {
        col = MS[hash(sx, sy * 3 + ri) < 0.5 ? 0 : 1];
      }

      const shade = sapShade(MT, t, ROOTS[ri].phase, ROOT_LIFE);
      if (shade >= 0 && Math.abs(n) < 0.26) col = SAP[shade];
      else if (shade === 2 && Math.abs(n) < 0.5) col = SAP[0];

      return col;
    };

    /* ---- bark that looks like the species' bark. Each returns a
       brightness 0..1 for a spot on the trunk: L runs across it, Y up it
       (world units, about half a pixel each at the full climb zoom), n is
       -1 at the lit left edge to +1 at the shaded right edge.
         plates   red maple: long narrow scaly plates, a lifted lip at the
                  top of each, shaggy
         furrows  oak: broad flat ridges split by deep wandering furrows,
                  cross-checked into blocks
         peel     birch: papery white in horizontal bands, dark lenticel
                  dashes, black rugged fissures at the foot
         lattice  elm: flat-topped ridges between crossing furrows that
                  make diamonds, tight thin scales
         fibres   redwood: thick stringy fibres in long vertical ridges
                  with deep furrows between them ---- */
    const barkV = (
      style: Art["barkStyle"],
      L: number,
      Y: number,
      n: number,
      wy: number,
    ): number => {
      switch (style) {
        case "plates": {
          const wob = vn(Y * 0.02, 4) * 6;
          const u = (L + wob) / 7;
          const col = Math.floor(u);
          const fx = u - col;
          const per = 46 + hash(col, 1) * 62;
          const off = hash(col, 2) * per;
          const row = Math.floor((Y + off) / per);
          const fy = (Y + off) / per - row;
          const pn = hash(col * 7 + row, 5);
          let v = 0.4 + 0.3 * pn + 0.2 * (1 - fx) - 0.3 * n;

          if (fy < 0.1) v += 0.24;
          else if (fy > 0.88) v -= 0.26;
          if (fx < 0.12 || fx > 0.94) v = 0.07 + 0.1 * pn;
          if (hash(col + 11, row) > 0.9 && fy < 0.35) v += 0.14;

          return v;
        }
        case "furrows": {
          const warp = (vn(Y * 0.012, 9) - 0.5) * 10 + (vn(Y * 0.05, 3) - 0.5) * 3;
          const u = (L + warp) / 15;
          const col = Math.floor(u);
          const fx = u - col;
          const seg = Math.floor((Y + hash(col, 3) * 90) / (70 + hash(col, 4) * 70));
          const fy = (Y + hash(col, 3) * 90) / (70 + hash(col, 4) * 70) - seg;
          const sn = hash(col, seg);
          let v = 0.46 + 0.26 * sn - 0.3 * n;

          if (fx < 0.17) v = 0.05 + 0.05 * sn;
          else if (fx < 0.38) v += 0.2;
          else if (fx > 0.82) v -= 0.18;
          if (sn > 0.78 && Math.abs(fx - 0.58) < 0.045) v = 0.08;
          if (fy < 0.05) v = 0.08;

          return v;
        }
        case "peel": {
          const band = Math.floor(Y / 24 + vn(L * 0.05, 4) * 1.6);
          let v = 0.8 + 0.12 * hash(band, 2) - 0.1 * n;
          const curl = Math.abs(((Y + 6 * Math.sin(L * 0.09 + band)) % 24) - 12);

          if (curl < 0.8) v -= 0.3;

          const row = Math.floor(Y / 17);
          const fy = Y / 17 - row;
          const seg = hash(row, Math.floor((L + hash(row, 1) * 40) / (9 + hash(row, 3) * 8)));

          if (seg > 0.55 && fy > 0.3 && fy < 0.52) v = 0.05;

          const foot = clamp((wy - 600) / 130, 0, 1);

          if (foot > 0) {
            const u = (L + Y * 0.35) / 11;
            const f = u - Math.floor(u);

            const u2 = (L - Y * 0.35) / 11;
            const f2 = u2 - Math.floor(u2);

            /* two sets of slanting fissures cross into black diamonds */
            if (f < 0.26 * foot || f2 < 0.2 * foot) v = 0.04;
            else if (foot > 0.5) v = Math.min(v, 0.55);
          }

          return v;
        }
        case "lattice": {
          const warp = (vn(Y * 0.015, 7) - 0.5) * 6;
          const d1 = (L + Y * 0.62 + warp) / 13;
          const d2 = (L - Y * 0.62 - warp) / 13;
          const f1 = d1 - Math.floor(d1);
          const f2 = d2 - Math.floor(d2);
          const cn = hash(Math.floor(d1), Math.floor(d2));
          let v = 0.48 + 0.2 * cn - 0.3 * n;

          if (f1 < 0.2 || f2 < 0.2) v = 0.06 + 0.08 * cn;
          else if (f1 > 0.55 && f2 > 0.55) v += 0.12;
          if (hash(Math.floor(L * 0.9), Math.floor(Y * 0.9)) > 0.93) v += 0.2;
          if (cn > 0.88) v -= 0.18;

          return v;
        }
        case "fibres": {
          const warp = (vn(Y * 0.009, 12) - 0.5) * 9;
          const u = (L + warp) / 17;
          const col = Math.floor(u);
          const fx = u - col;
          const s = Math.floor((L + warp) / 3.2);
          const strand = hash(s, Math.floor(Y / (60 + hash(s, 2) * 120)));
          let v = 0.36 + 0.42 * strand - 0.2 * n;

          if (fx < 0.14) v = 0.04;
          else if (fx < 0.3) v *= 0.72;
          if (strand > 0.86) v = 0.82;
          if (hash(s + 31, Math.floor(Y * 0.5)) > 0.95) v += 0.15;

          return v;
        }
        case "twist": {
          /* a rope of green strands wound round the stalk, with now and
             then a knot where a tendril leaves it */
          const warp = vn(Y * 0.011, 6) * 8;
          const d = (L * 0.8 + Y * 0.5 + warp) / 13;
          const f = d - Math.floor(d);
          const strand = hash(Math.floor(d), 4);
          let v = 0.5 + 0.2 * strand - 0.28 * n;

          if (f < 0.13) v = 0.05 + 0.06 * strand;
          else if (f > 0.5 && f < 0.64) v += 0.18;
          if (hash(Math.floor(L * 0.7), Math.floor(Y * 0.6)) > 0.95) v += 0.18;

          const knotRow = Math.floor(Y / 150);
          const ky = Y / 150 - knotRow;

          if (hash(knotRow, 8) > 0.45 && ky > 0.46 && ky < 0.54) v = Math.min(v, 0.12 + 0.2 * Math.abs(ky - 0.5) * 10);

          return v;
        }
        case "thorns": {
          /* dark plum canes in long strands, armed with pale thorns that
             point down and out, a few to a hand's length */
          const warp = (vn(Y * 0.01, 14) - 0.5) * 7;
          const strand = hash(Math.floor((L + warp) / 6), 2);
          let v = 0.3 + 0.2 * strand - 0.28 * n + 0.05 * Math.sin((L + warp) * 0.55);

          if (hash(Math.floor((L + warp) / 6) + 40, Math.floor(Y / 130)) > 0.9) v += 0.22;

          const cw = 34;
          const ch = 88;
          const cu = (L + hash(Math.floor(Y / ch), 6) * cw) / cw;
          const col = Math.floor(cu);
          const fx = cu - col;
          const row = Math.floor((Y + hash(col, 9) * ch) / ch);
          const fy = (Y + hash(col, 9) * ch) / ch - row;

          if (hash(col, row + 77) > 0.34 && fy > 0.06 && fy < 0.6) {
            /* a thorn: broad at the cane, curving down to a sharp point */
            const k = (fy - 0.06) / 0.54;
            const xc = 0.2 + 0.5 * k * k;
            const hw = 0.2 * (1 - k) + 0.02;

            if (Math.abs(fx - xc) < hw) v = 0.99;
            else if (fx > xc && fx - xc < hw + 0.08) v = 0.03;
          }

          return v;
        }
        default:
          return 0.5;
      }
    };

    /* ---- the ancient bark (per-pixel, value-noise art) — the
       maple reference's trunkPx, translated verbatim. ---- */
    const trunkPx = (
      sx: number,
      sy: number,
      Z: number,
      e: number,
      tm: number,
    ): number[] | null => {
      const pq = S * Z;
      const wx = XF + (sx + 0.5 - AX) / pq;
      const wy = YF + (sy + 0.5 - AY) / pq;
      if (wy > 746 || wy < TRUNK_TOP) return null;
      const yi = clamp(Math.round(wy), 0, 799);
      const cx = cxw(wy);
      const w =
        ((wy >= art.trunkFracY ? RW[yi] : art.trunkLowW) * (1 - e) +
          wW(wy) * e) *
        (1 + 0.8 * Math.exp(-(742 - wy) / 38));
      const lat = wx - cx;
      /* The climbing top narrows to a tip instead of a flat cut. */
      const tip = clamp((wy - TRUNK_TOP) / 90, 0, 1);
      const half =
        (w / 2 + (vn(wy * 0.07, 5) - 0.5) * 5 + (vn(wy * 0.31, 2) - 0.5) * 2) *
        (0.3 + 0.7 * tip);
      const n = lat / half;
      if (Math.abs(n) > 1) return null;
      const nz = (a: number, b: number) =>
        hash(Math.floor(a * pq), Math.floor(b * pq));
      const L = lat + (vn(wy * 0.02, 5) - 0.5) * art.trunkLatJ;
      const Y =
        wy +
        (vn(lat * 0.05, 9) - 0.5) * art.trunkYJ +
        lat * art.trunkLatLean;
      const cellY = art.trunkCellY;
      const cellM = art.trunkCellMul;
      const r = Math.floor(Y / cellY);
      const fxp = (L + hash(r, 3) * cellM) / cellM;
      const c = Math.floor(fxp);
      const fx = fxp - c;
      const fy = Y / cellY - r;
      const pno = hash(c, r);
      let v =
        0.34 + 0.38 * pno + 0.22 * (1 - fx) * (1 - fy * 0.6) - 0.3 * n +
        (vn(L * art.trunkNoiseL, Y * art.trunkNoiseY) - 0.5) *
          art.trunkNoiseAmp;
      if (art.barkStyle !== "cells") {
        v = barkV(art.barkStyle, L, Y, n, wy);
      } else if (fx < art.trunkGateX || fy < art.trunkGateY) {
        v = 0.06 + 0.1 * pno;
      }
      if (art.barkStyle === "cells" && art.trunkDash) {
        /* Birch: dark slash marks across the pale bark. */
        const hr = Math.floor(Y / 9);
        const hv = hash(hr, Math.floor((L + hash(hr, 1) * 30) / 14));
        const hf = Y / 9 - hr;
        if (hv > 0.66 && hf > 0.3 && hf < 0.62) v = -1;
      }
      let idx = clamp(Math.floor(v * 6), 0, 5);
      if (n < -0.88) idx = Math.min(5, idx + 2);
      else if (n > 0.86) idx = Math.max(0, idx - 2);
      if (wy > 700) idx = Math.max(0, idx - 1);
      let col = BK[idx];
      if (
        pno > 0.86 && fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7 &&
        hash(c + 7, r) > 0.4
      ) {
        col = LICH;
      }
      const ms =
        vn(L * 0.045, Y * 0.02) + (wy > 400 ? 0.08 : 0) - (n > 0 ? 0.06 : 0);
      if (ms > 0.66 && nz(L, Y + 3) > 0.35) {
        col = MS[clamp(Math.floor((ms - 0.66) * 14), 0, 2)];
      }
      for (let j = Math.floor(wy / 260) - 1; j <= Math.floor(wy / 260); j++) {
        if (hash(j, 6) < 0.35) continue;
        const ky = j * 260 + hash(j, 1) * 200;
        const rx = 12 + hash(j, 3) * 12;
        const d = Math.hypot(
          (lat - (hash(j, 2) - 0.5) * half * 0.9) / rx,
          (wy - ky) / (rx * 1.6),
        );
        if (d < 1) {
          col = d < 0.2 || d > 0.88 ? BK[0] : BK[Math.floor(d * 5.5) % 2 ? 1 : 3];
        } else if (d < 1.18) {
          col = BK[0];
        }
      }
      for (let j = Math.floor(wy / 340) - 1; j <= Math.floor(wy / 340); j++) {
        if (hash(j, 9) < 0.5) continue;
        const ky = j * 340 + hash(j, 4) * 240;
        const dl = lat - (hash(j, 5) - 0.5) * half * 1.2;
        const dy = wy - ky;
        const d = Math.hypot(dl, dy);
        const ln = 22 + hash(j, 7) * 20;
        if (d < 4) {
          col = SPL[d < 2.2 ? 0 : 1];
        } else if (dy > 0 && dy < ln && Math.abs(dl) < 1.7) {
          col = AMB[dy > ln - 5 ? 2 : 1];
        }
      }
      for (let k = 0; k < (layersRef.current.has("vines") ? 0 : 5); k++) {
        /* Wind: the vine shifts by whole art pixels (offset / pq is
           that many pixels in world units), a traveling wave along
           its length. Each vine winds at its own pitch and breadth,
           and the extra ones only run part of the climb, so the trunk
           is hung with vines of different lengths. */
        if (k >= 2 && hash(Math.floor(wy / (260 + 70 * k)), k + 40) < 0.4) continue;
        const vineSway = swayOffset(MT, wy * 0.006 + k * 2.3, 2 * LEAF_LIFE);
        const d = Math.abs(
          lat -
            Math.sin(wy * (0.0042 + 0.0013 * k) + k * 3.1) * half * (0.62 - 0.07 * k) -
            vineSway / pq,
        );
        if (d < (k < 2 ? 0.6 : 0.5) / pq) col = MS[k % 2 === 0 ? 0 : 1];
        else if (
          d < 3.4 / pq &&
          (((wy / (58 - 4 * k) + k * 0.3) % 1) + 1) % 1 < 0.14
        ) {
          col =
            FOLI[
              clamp(3 + shimmerShift(MT, sx, sy, k * 1.9, LEAF_LIFE), 0, 4)
            ];
        }
      }
      const sp = clamp((520 - wy) / 300, 0, 1);
      if (sp > 0 && !layersRef.current.has("sap")) {
        /* Sap veins are the 0.5 contour of a noise field. Cutting
           the field at a fixed height makes the line as wide as the
           field is flat, which swells it into slabs; so the cut is
           divided by the local slope, giving a vein of constant
           width on screen (about 1-2 art pixels). */
        const sapAt = (l: number, y: number) =>
          vn(l * 0.05 + vn(wy * 0.004, 2) * 3, y * 0.0035) - 0.5;
        const f0 = sapAt(L, Y);
        const dd = Math.abs(f0);

        if (dd < 0.12) {
          const e = 1.5;
          const gl = (sapAt(L + e, Y) - f0) / e;
          const gy = (sapAt(L, Y + e) - f0) / e;
          const slope = Math.max(1e-4, Math.hypot(gl, gy));
          const dist = dd / slope;
          const half = (0.4 + 0.35 * sp) / pq;

          if (dist < half) {
            const q = 0.5 + 0.5 * Math.sin(MT * 0.16 + wy * 0.012);
            col = AMB[q > 0.66 ? 2 : q > 0.33 ? 1 : 0];
          } else if (dist < half * 1.5) {
            col = AMB[0];
          }
        }
      }
      return col;
    };

    /* ---- leaf sprites (the species' lobe count) ---- */
    const leaf = (
      X: number,
      Y: number,
      r: number,
      ph: number,
      tone: number,
      ramp: number[][] = FOLI,
      fade = 1,
    ) => {
      if (r < 0.8) {
        paint(X | 0, Y | 0, ramp[3], fade);
        return;
      }
      leafCached(X, Y, r, ph, tone, ramp, fade);
    };

    /* The canopy paints hundreds of leaves a frame. Each distinct leaf
       (size, turn, tone, colors) is worked out once, by the species' own
       leaf design (see utils/leafShapes), into a list of pixels, and then
       stamped at a whole-pixel position. */
    const leafSprites = new Map<
      string,
      { dx: number[]; dy: number[]; c: number[][] }
    >();
    const leafCached = (
      X: number,
      Y: number,
      r: number,
      ph: number,
      tone: number,
      ramp: number[][],
      fade = 1,
    ) => {
      const rq = Math.max(1, Math.round(r * 2) / 2);
      const pq = Math.round((((ph % 6.2832) + 6.2832) % 6.2832) / 0.5236) * 0.5236;
      const tq = clamp(Math.round(tone * 10) / 10, 0, 1.2);
      const design = ALT_RAMPS.has(ramp) && art.altShape ? art.altShape : art.leafShape;
      const key = `${design}|${rq}|${pq.toFixed(2)}|${tq}|${ramp[0][0]},${ramp[2][1]},${ramp[4][2]}`;
      let sprite = leafSprites.get(key);

      if (!sprite) {
        const px = leafPixels(design, rq, pq, tq);

        sprite = { dx: px.dx, dy: px.dy, c: px.shade.map((i) => ramp[i]) };
        leafSprites.set(key, sprite);
      }

      const ox = Math.round(X);
      const oy = Math.round(Y);

      if (fade >= 0.995) {
        for (let i = 0; i < sprite.dx.length; i++) {
          put(ox + sprite.dx[i], oy + sprite.dy[i], sprite.c[i]);
        }
      } else {
        for (let i = 0; i < sprite.dx.length; i++) {
          blendPut(ox + sprite.dx[i], oy + sprite.dy[i], sprite.c[i], fade);
        }
      }
    };

    const drawLeaf = (
      L: (typeof leaves)[number],
      s: number,
      sg: number,
      kx: number,
    ) => {
      if (s < 0.15) return;
      /* Match the reference exactly: XF*S/YF*S, not the fixed
         BX/118.7 stand-ins — those only coincided with XF*S/YF*S
         at the original W=128 (S=0.16) scale. Leaf clusters are
         pre-scaled by S at cluster()-build time (see `cluster`
         below), so widening the canvas (and therefore S) without
         live-recomputing this anchor silently drops every leaf's
         vertical position out of alignment with its branch. */
      const X = AX + (L.x + bendWorld(L.y / S, sg) * S - XF * S) * sg * kx;
      const Y = AY + (L.y - YF * S) * sg;
      const r = L.r * (0.55 + 0.45 * sg) * s;
      if (Y + r * 1.3 < 0 || Y - r * 1.3 > H || X + r * 1.3 < 0 || X - r * 1.3 > W) {
        return;
      }
      const ramp = LEAF_RAMPS
        ? LEAF_RAMPS[GG > L.sw ? L.pal : 3]
        : art.mapleLeaf
          ? GG > L.sw
            ? MAPLE_R[L.pal]
            : MAPLE_R[3]
          : TURN_R && GG > L.sw
            ? TURN_R
            : FOLI;
      /* New leaves fade in over a short growth window after their
         birth — per level the crown grows gradually, never pops. */
      const fade = smoothstep(L.b, L.b + 0.055, GG);
      leaf(X, Y, r, L.ph, L.tone, ramp, fade);
    };

    /* ---- ancient-ascent branch stub: always fully present (the
       climb has already passed any growth-reveal threshold), with
       a darkened base for contact shading against the trunk. ---- */
    const ascentLimb = (
      stub: (typeof ascentStubs)[number],
      sg: number,
      kx: number,
    ) => {
      const N = stub.sp.length;
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const [X, Y] = pt(
          { sp: stub.sp, ws: stub.ws, g0: 0, gd: 1 },
          u,
          sg,
          kx,
        );
        const w = (lerpArr(stub.ws, u) * S * sg) / 2;
        if (w < 0.35) continue;
        for (let py = Math.floor(Y - w - 1); py <= Math.ceil(Y + w + 1); py++) {
          for (let px = Math.floor(X - w - 1); px <= Math.ceil(X + w + 1); px++) {
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const dx = px + 0.5 - X;
            const dy = py + 0.5 - Y;
            if (dx * dx + dy * dy > w * w + 0.2) continue;
            const n = clamp(dx / (w + 0.5), -1, 1);
            const base = 1 - u;
            let v =
              0.5 - 0.34 * n - 0.22 * base +
              (hash(px, py * 3 + 11) - 0.5) * 0.3;
            /* bark seams: short dark grooves running along the limb */
            if (w > 1.4 && hash(Math.round(u * 22), Math.round(n * 3) + 90) > 0.74) {
              v -= 0.3;
            }
            /* a knot partway along, as a dark ring with a pale heart */
            const kd = Math.hypot(
              (u - 0.52) * N * 0.55,
              (dy + (hash(N, 3) - 0.5) * w) * 0.9,
            );
            let mossy = false;
            if (w > 1.5 && kd < w * 0.55) {
              v = kd < w * 0.2 ? 0.78 : 0.04;
            } else if (n < -0.2 && hash(px * 3, py * 7 + Math.round(u * 9)) < 0.42 - 0.3 * u) {
              /* moss gathers on the upper face, thickest near the trunk */
              mossy = true;
            }
            put(
              px,
              py,
              mossy
                ? MS[hash(px, py * 5) > 0.5 ? 1 : 0]
                : hash(px * 5, py + 19) > 0.92
                  ? MOSS
                  : BARK[clamp(Math.floor(v * 4), 0, 3)],
            );
          }
        }
        if (art.limbStyle === "thorn" && w > 0.9 && i % 3 === 1 && hash(i, 53) > 0.25) {
          const side = hash(i, 54) > 0.5 ? 1 : -1;
          const tx = Math.round(X + side * (w + 0.6));
          const ty = Math.round(Y);

          put(tx, ty, BK[5]);
          put(tx + side, ty + 1, BK[5]);
          put(tx + side * 2, ty + 2, BK[4]);
        }
      }
    };

    /* A loose tuft of small leaves scattered around the stub's
       tip, scaled from world units into the current screen zoom. */
    /* The leaf colors for the tufts and the big falling leaves: the
       species' own ramps (the maple's gold, orange and crimson, the
       birch's yellows, ...), mostly color with the odd green leaf. The
       oak stays green. */
    const LEAF_SET: number[][][] | null =
      LEAF_RAMPS ?? (art.mapleLeaf ? MAPLE_R : null);
    const leafRampFor = (a: number, b: number): number[][] => {
      if (!LEAF_SET) return TURN_R ?? FOLI;
      const r = hash(a, b);
      return LEAF_SET[
        r < 0.2 ? 3 : Math.min(2, Math.floor(((r - 0.2) / 0.8) * 3))
      ];
    };

    const drawAscentTuft = (
      stub: (typeof ascentStubs)[number],
      sg: number,
      kx: number,
    ) => {
      /* Anchor the tuft a few world-units above the stub's actual
         tip so the leaf mass caps the branch instead of hanging
         off its underside. */
      const [tx, ty] = pt(
        { sp: [[stub.tipX, stub.tipY - 4]], ws: [1], g0: 0, gd: 1 },
        0,
        sg,
        kx,
      );
      const [rw, tone] = stub.lr;
      const rs = rw * S * sg;
      if (rs < 1) return;
      const seedA = (stub.tipX * 3) | 0;
      const seedB = (stub.tipY * 5) | 0;
      /* The tuft sways in the wind: whole art pixels, each tuft on
         its own phase, with a slow wave of light through its leaves. */
      const wph = stub.tipX * 0.013 + stub.tipY * 0.007;

      /* Side twigs: thin shoots off the limb, each ending in a pair of
         leaves that swing a pixel in the wind. */
      const sideTwigs = rs > 7 ? 4 : rs > 4 ? 2 : 1;
      for (let j = 0; j < sideTwigs; j++) {
        const u = 0.28 + (0.55 / sideTwigs) * j;
        const [wx, wy] = stub.sp[Math.min(stub.sp.length - 1, Math.floor(u * (stub.sp.length - 1)))];
        const [bx0, by0] = pt({ sp: [[wx, wy]], ws: [1], g0: 0, gd: 1 }, 0, sg, kx);
        const dirY = j % 2 === 0 ? -1 : 1;
        const len = Math.max(3, rs * (0.2 + 0.1 * hash(j + seedA, 61)));
        const sx = swayOffset(MT, wph + j * 1.7, LEAF_LIFE);
        const tipX = bx0 + stub.side * len * 0.8 + sx;
        const tipY = by0 + dirY * len * 0.9;
        const steps = Math.ceil(len);
        for (let q = 0; q <= steps; q++) {
          const f = q / steps;
          put(
            Math.round(bx0 + (tipX - bx0) * f),
            Math.round(by0 + (tipY - by0) * f),
            BARK[f < 0.5 ? 1 : 2],
          );
        }
        const lr2 = Math.max(1.3, rs * 0.13);
        for (const o of [-1, 1]) {
          leafCached(
            tipX + o * lr2 * 0.9,
            tipY - lr2 * 0.4,
            lr2,
            j + o,
            tone + 0.15 * shimmerShift(MT, tipX, tipY, wph + j, LEAF_LIFE),
            leafRampFor(j * 2 + o + seedA, seedB + 9),
          );
        }
      }

      /* Leaves along the twig itself, alternating above and below it,
         so the branch is leafy from the trunk out to the tuft. */
      const m = Math.max(4, Math.round(11 * Math.min(1, rs / 8)));
      for (let j = 0; j < m; j++) {
        const u = 0.3 + 0.65 * (j / (m - 1));
        const [wx, wy] = stub.sp[Math.min(stub.sp.length - 1, Math.floor(u * (stub.sp.length - 1)))];
        const [lx, ly] = pt({ sp: [[wx, wy]], ws: [1], g0: 0, gd: 1 }, 0, sg, kx);
        const jig = hash(j + seedA, seedB);
        const lr = Math.max(1.4, rs * (0.17 + 0.12 * jig));
        const bx = lx + swayOffset(MT, wph + j * 1.1, 2 * LEAF_LIFE);
        const by =
          ly + (j % 2 === 0 ? -1 : 1) * lr * 0.8 +
          swayOffset(MT, wph + j * 1.1 + 1.7, LEAF_LIFE);
        leafCached(
          bx,
          by,
          lr,
          jig * 6,
          tone + (jig - 0.5) * 0.2 + 0.2 * shimmerShift(MT, bx, by, wph, LEAF_LIFE),
          leafRampFor(j + seedA, seedB),
        );
      }

      /* Push the whole tuft outward past the tip (away from the
         trunk) and clear ABOVE it (scaled to the tuft's own radius,
         not a fixed pixel nudge, so it stays clear of the branch at
         any zoom) — otherwise the leaf mass centers on the tip and
         half of it droops below the twig instead of capping it. */
      const away = stub.side * rs * 0.3;
      const up = rs * 0.6;
      const swX = swayOffset(MT, wph, 2 * LEAF_LIFE);
      const swY = swayOffset(MT, wph + 1.9, LEAF_LIFE);
      leafCached(
        tx + away + swX,
        ty - up - rs * 0.15 + swY,
        Math.max(1.6, rs * 0.5),
        0.4,
        tone + 0.2 * shimmerShift(MT, tx, ty, wph, LEAF_LIFE),
        leafRampFor(seedA, seedB),
      );
      /* Blob count follows the tuft's size (bigger tufts higher up),
         dense enough that a large cluster stays a mass of leaves
         instead of a few blurry dots. */
      const n = Math.min(36, Math.max(15, Math.round(rw * 1.2)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + stub.tipX * 0.013;
        const jig = hash(i + ((stub.tipY * 3) | 0), 31);
        const ox = Math.cos(a) * rs * (0.3 + 0.5 * jig) + away;
        const oy = Math.sin(a) * rs * (0.22 + 0.3 * jig) - rs * 0.2 - up;
        const rr = Math.max(1.3, rs * (0.26 + 0.22 * jig));
        const bx = tx + ox + swayOffset(MT, wph + i * 0.9, 2 * LEAF_LIFE);
        const by = ty + oy + swayOffset(MT, wph + i * 0.9 + 1.3, LEAF_LIFE);
        leafCached(
          bx,
          by,
          rr,
          a,
          tone +
            (jig - 0.5) * 0.15 +
            0.2 * shimmerShift(MT, bx, by, wph, LEAF_LIFE),
          leafRampFor(i + seedA, seedB + 3),
        );
      }
    };

    const FALL: {
      x: number; y: number; ph: number; v: number; gy: number; a: boolean;
      p: number[][];
    }[] = [];
    const LAND: { x: number; y: number; a: boolean; p: number[][] }[] = [];
    let spawn = 0;

    const fall = (dt: number, shower: boolean, tm: number) => {
      spawn += dt;
      if (spawn > (shower ? 0.3 : 0.45) && FALL.length < (shower ? 22 : 14)) {
        spawn = 0;
        let L = leaves[0];
        for (let i = 0; i < 6; i++) {
          L = leaves[(Math.random() * leaves.length) | 0];
          if (L.y < 90) break;
        }
        FALL.push({
          x: shower ? Math.random() * W : L.x,
          y: shower ? -2 : L.y + L.r,
          a: art.acorn && Math.random() < 0.3,
          p: art.mapleLeaf
            ? MAPLE_R[(Math.random() * 3) | 0]
            : FOLI,
          ph: Math.random() * 6,
          v: 5 + Math.random() * 4,
          gy: GROUND_ROW - 3 + Math.random() * 5,
        });
      }
      for (let i = FALL.length - 1; i >= 0; i--) {
        const f = FALL[i];
        f.y += f.v * dt;
        f.ph += dt * 2.5;
        const gust = 0.5 + 0.5 * Math.sin(tm * 0.5);
        f.x += (Math.sin(f.ph) * 7 + gust * 15) * dt;
        if (f.y >= (DY > 0 ? H + 3 : f.gy)) {
          if (DY <= 0) {
            LAND.push({
              x: f.x | 0,
              y: f.gy | 0,
              a: f.a,
              p: f.p,
            });
            if (LAND.length > 45) LAND.shift();
          }
          FALL.splice(i, 1);
          continue;
        }
        if (f.a) {
          if (art.mapleLeaf) {
            const sd = Math.sin(f.ph * 3) > 0 ? 1 : -1;
            put(f.x | 0, f.y | 0, ACN[0]);
            put((f.x | 0) + sd, (f.y | 0) - 1, ACN[1]);
            put((f.x | 0) + sd * 2, (f.y | 0) - 1, ACN[1]);
          } else {
            put(f.x | 0, f.y | 0, ACN[0]);
            put(f.x | 0, (f.y | 0) - 1, ACN[1]);
          }
        } else {
          put(f.x | 0, f.y | 0, f.p[4]);
          put(
            (f.x | 0) + (Math.sin(f.ph) > 0 ? 1 : -1),
            f.y | 0,
            f.p[3],
          );
          put(f.x | 0, (f.y | 0) + 1, f.p[2]);
        }
      }
      LAND.forEach(({ x, y, a, p }) => {
        put(x, (y + DY) | 0, a ? ACN[0] : p[3]);
        put(x + 1, (y + DY) | 0, a ? ACN[1] : p[2]);
      });
    };

    /* Now and then a LARGER leaf lets go and falls, drawn with the
       species' own leaf shape and falling its own way: the maple's
       spins like a helicopter, the oak's flutters side to side, the
       birch's flips quickly, the elm's glides slowly, the redwood's
       sprig drops straight. They are rare (every few seconds), at
       most two at once, and only while motion is on. */
    const BIG_STYLE: Record<
      string,
      { spin: number; sway: number; hz: number; v: [number, number]; drift: number }
    > = {
      maple: { spin: 5.2, sway: 3.5, hz: 2.0, v: [8, 11], drift: 0.4 },
      lobed: { spin: 1.9, sway: 13, hz: 2.4, v: [5, 7], drift: 0.7 },
      birch: { spin: 3.6, sway: 8, hz: 3.0, v: [6, 8.5], drift: 0.5 },
      elm: { spin: 1.1, sway: 6, hz: 1.5, v: [4.2, 6], drift: 1.4 },
      redwood: { spin: 2.6, sway: 2.5, hz: 1.7, v: [7, 10], drift: 0.2 },
      bean: { spin: 1.6, sway: 9, hz: 2.0, v: [5, 7.5], drift: 0.6 },
      rose: { spin: 2.2, sway: 11, hz: 2.6, v: [3.6, 5.4], drift: 1.0 },
      sprig: { spin: 2.2, sway: 8, hz: 2.2, v: [4.5, 6.5], drift: 0.8 },
    };
    const BIG: {
      x: number; y: number; r: number; ph: number; spin: number;
      v: number; age: number; seed: number; tone: number; gy: number;
      ramp: number[][];
    }[] = [];
    let bigTimer = 2 + Math.random() * 3;

    const bigFall = (dt: number, shower: boolean, tm: number) => {
      const style = BIG_STYLE[art.leafShape] ?? BIG_STYLE.lobed;
      bigTimer -= dt;

      if (bigTimer <= 0 && BIG.length < 2) {
        bigTimer = (shower ? 3.5 : 5) + Math.random() * (shower ? 4 : 6);
        const r = 4.6 + Math.random() * 2.6;
        let x = 10 + Math.random() * (W - 20);
        let y = -r * 1.4;
        if (!shower) {
          /* the full-tree view: let go from the canopy itself */
          let L = leaves[0];
          for (let i = 0; i < 6; i++) {
            L = leaves[(Math.random() * leaves.length) | 0];
            if (L.y < 90) break;
          }
          x = L.x;
          y = L.y + L.r;
        }
        const seed = Math.random() * 100;
        BIG.push({
          x, y, r,
          ph: Math.random() * 6,
          spin: (Math.random() < 0.5 ? -1 : 1) * style.spin * (0.8 + Math.random() * 0.4),
          v: (style.v[0] + Math.random() * (style.v[1] - style.v[0])) * (shower ? 1.6 : 1),
          age: 0,
          seed,
          tone: 0.55 + Math.random() * 0.25,
          gy: GROUND_ROW - 3 + Math.random() * 4,
          ramp: leafRampFor((seed * 13) | 0, (seed * 7) | 0),
        });
      }

      const wind = 0.5 + 0.5 * Math.sin(tm * 0.5);

      for (let i = BIG.length - 1; i >= 0; i--) {
        const b = BIG[i];
        b.age += dt;
        b.y += b.v * dt;
        b.ph += b.spin * dt;
        b.x += (Math.sin(b.age * style.hz + b.seed) * style.sway + wind * style.drift * 14) * dt;

        if (b.y >= (DY > 0 ? H + b.r * 1.4 : b.gy)) {
          if (DY <= 0) {
            LAND.push({ x: b.x | 0, y: b.gy | 0, a: false, p: b.ramp });
            if (LAND.length > 45) LAND.shift();
          }
          BIG.splice(i, 1);
          continue;
        }

        /* whole pixels, and the turning stepped like the rest */
        leafCached(
          Math.round(b.x),
          Math.round(b.y),
          b.r,
          Math.floor(b.ph / 0.4) * 0.4,
          b.tone,
          b.ramp,
        );
      }
    };

    const easeInOut = (u: number) => u * u * (3 - 2 * u);

    /* ---- what the climb brings into view: vines hanging from above,
       sylphs on the wing, motes of light drifting up, and shafts of sun.
       They sit in front of the tree, grow in with the climb (`asc`, 0..1)
       and are tinted from the species' own colors. ---- */
    const VINES = vineSpecs(9, speciesId.length * 11 + 3);
    const lighten = (c: number[], k: number) => mixRgb(c, [255, 255, 255], k);
    const SYLPH_BODY = lighten(FOLI[Math.min(4, FOLI.length - 1)], 0.62);
    const SYLPH_WING = [236, 246, 255];
    const MOTE = lighten(FOLI[Math.min(4, FOLI.length - 1)], 0.7);

    const sinceKey = (key: string, tm: number): number => {
      const at = pokesRef.current[key];

      if (at === undefined) return Infinity;

      const d = tm - at;

      return d >= 0 && d < 12 ? d : Infinity;
    };

    const drawAscentAccents = (asc: number, tm: number) => {
      if (asc <= 0.01) return;

      /* shafts of sun, slanting down from the upper left */
      for (let i = 0; i < (layersRef.current.has("shafts") ? 0 : 3); i++) {
        const x0 = 30 + i * 78 + Math.sin(i * 2.3) * 12;
        const half = 6 + i * 2;
        const breathe = reduced ? 1 : 0.8 + 0.2 * Math.sin(tm * 0.5 + i * 1.7);

        for (let y = 0; y < 104; y++) {
          const cx = x0 + y * 0.55;
          const fall = (1 - y / 104) * 0.1 * asc * breathe;

          for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
            const edge = 1 - Math.abs(x - cx) / half;

            if (edge <= 0) continue;
            blendPut(x, y, [255, 244, 205], fall * Math.min(1, edge * 1.6));
          }
        }
      }

      /* vines hanging from the top edge, swaying in whole pixels */
      const grow = smoothstep(0.05, 0.7, asc);

      if (!layersRef.current.has("hanging")) VINES.forEach((v, i) => {
        const len = vineShown(v.length, grow);

        for (let y = 0; y < len; y++) {
          const depth = y / Math.max(1, v.length);
          const sway = Math.round(
            swayOffset(MT, v.phase + y * 0.07, 2.2) * depth,
          );
          const x = v.x + sway;

          put(x, y, MS[(y + i) % 4 < 2 ? 1 : 0]);
          if (y % 7 === 3 && len > 6) {
            leafCached(
              x + ((i + y) % 2 === 0 ? -2 : 2),
              y,
              1.7,
              (i + y) * 0.9,
              0.55 + 0.2 * shimmerShift(MT, x, y, v.phase, 1),
              leafRampFor(i, y),
            );
          }
        }

        /* a bud at the tip, a bright one now and then */
        if (len >= v.length * 0.9) {
          const x = v.x + Math.round(swayOffset(MT, v.phase + len * 0.07, 2.2));

          put(x, len, i % 3 === 0 ? lighten(FOLI[Math.min(4, FOLI.length - 1)], 0.35) : MS[2]);
          put(x, len + 1, MS[1]);
        }
      });

      /* motes of light drifting up through the leaves */
      const moteCount = layersRef.current.has("motes") ? 0 : Math.round(28 * asc);

      for (let k = 0; k < moteCount; k++) {
        const m = motePose(k, reduced ? 0 : tm);

        if (m.glow < 0.25) continue;
        blendPut(m.x, m.y, MOTE, 0.5 + 0.5 * m.glow);
        if (m.glow > 0.7) {
          blendPut(m.x + 1, m.y, MOTE, 0.25);
          blendPut(m.x - 1, m.y, MOTE, 0.25);
          blendPut(m.x, m.y + 1, MOTE, 0.25);
          blendPut(m.x, m.y - 1, MOTE, 0.25);
        }
      }

      /* sylphs: little winged people with a glow and a trail of dust.
         Offsets are drawn facing right and flipped when they turn. */
      const sylphCount = layersRef.current.has("sylphs") || isBean
        ? 0
        : Math.max(1, Math.round(1 + 4 * asc));

      /* The beanstalk's climb is full of fireflies and old magic instead:
         fireflies that blink on and off, and glimmering wisps that wind
         through the air leaving a trail of sparks. */
      if (isBean && !layersRef.current.has("sylphs")) {
        const t = reduced ? 0 : tm;
        const lit = Math.min(1, asc * 1.4);

        for (let k = 0; k < 26; k++) {
          const bx = hash(k, 11) * W + 9 * Math.sin(t * 0.4 + k * 1.7);
          const by = hash(k, 12) * (H - 20) + 5 * Math.sin(t * 0.55 + k * 2.3);
          const x = Math.round(bx);
          const y = Math.round(by);
          const blink = 0.5 + 0.5 * Math.sin(t * (1.1 + hash(k, 13) * 1.4) + k * 3.1);

          if (blink < 0.25) continue;

          const a = lit * Math.min(1, (blink - 0.2) * 1.6);

          blendPut(x, y, [226, 255, 130], a);
          blendPut(x + 1, y, [190, 240, 90], a * 0.45);
          blendPut(x - 1, y, [190, 240, 90], a * 0.45);
          blendPut(x, y + 1, [190, 240, 90], a * 0.45);
          blendPut(x, y - 1, [190, 240, 90], a * 0.45);
        }

        const MAGIC = [[190, 255, 150], [255, 232, 140], [170, 240, 255], [255, 190, 240]];

        for (let m = 0; m < 5; m++) {
          const col = MAGIC[m % MAGIC.length];

          for (let k = 9; k >= 0; k--) {
            const tt = t - k * 0.09;
            const x = Math.round(W * (0.14 + 0.72 * hash(m, 21)) + (W * 0.2) * Math.sin(tt * (0.45 + hash(m, 22) * 0.3) + m * 1.9));
            const y = Math.round(H * (0.2 + 0.5 * hash(m, 23)) + (H * 0.22) * Math.sin(tt * (0.62 + hash(m, 24) * 0.3) + m * 2.6));

            if (k === 0) {
              /* the bright head: a small four-point star that twinkles */
              const tw = 0.7 + 0.3 * Math.sin(t * 6 + m);

              blendPut(x, y, [255, 255, 240], lit * tw);
              blendPut(x + 1, y, col, lit * 0.8 * tw);
              blendPut(x - 1, y, col, lit * 0.8 * tw);
              blendPut(x, y + 1, col, lit * 0.8 * tw);
              blendPut(x, y - 1, col, lit * 0.8 * tw);
              blendPut(x + 2, y, col, lit * 0.35);
              blendPut(x - 2, y, col, lit * 0.35);
            } else if (k % 2 === 1 || k < 4) {
              blendPut(x + ((k * 3 + m) % 3) - 1, y + ((k * 5 + m) % 3) - 1, col, lit * 0.7 * (1 - k / 10));
            }
          }
        }
      }
      const DRESS = [
        [255, 190, 220],
        [170, 228, 255],
        [255, 232, 160],
        lighten(FOLI[Math.min(4, FOLI.length - 1)], 0.4),
        [200, 255, 190],
      ];
      /* upper and lower wings, wings up (flap 0) or down (flap 1) */
      const WINGS: number[][][] = [
        [[-1, -2], [-2, -3], [-3, -5], [-4, -6], [-2, -4], [-3, -4], [-1, -1], [-3, -1], [-4, -2]],
        [[-1, -1], [-2, 0], [-3, 1], [-4, 2], [-2, -1], [-3, -1], [-1, 0], [-3, 3], [-4, 4]],
      ];

      for (let i = 0; i < sylphCount; i++) {
        const t = reduced ? 0 : tm;
        const dress = DRESS[i % DRESS.length];

        /* dust left behind, dimmer the older it is */
        for (let k = 6; k >= 1; k--) {
          const old = sylphPose(i, t - k * 0.13);

          blendPut(
            old.x + ((k * 7 + i) % 3) - 1,
            old.y + 3 + ((k * 5 + i) % 3) - 1,
            dress,
            0.7 * (1 - k / 7) * asc,
          );
        }

        const pose = sylphPose(i, t);
        const poked = sinceKey(`sylph${i}`, tm);
        const spin = poked < 1.5;
        /* poked, a sylph spins away in a spiral and bursts into glitter */
        const p = spin
          ? {
              ...pose,
              x: Math.round(pose.x + 9 * Math.sin(poked * 13) * (1 - poked / 1.5)),
              y: Math.round(pose.y - 8 * poked + 4 * Math.cos(poked * 13) * (1 - poked / 1.5)),
              flap: (Math.floor(poked * 24) % 2) as 0 | 1,
            }
          : pose;
        const a = Math.min(1, asc * 1.4) * (0.75 + 0.25 * p.glow);

        hitsRef.current.push({ key: `sylph${i}`, x: p.x - 4, y: p.y - 6, w: 9, h: 12 });
        if (hoverRef.current === `sylph${i}`) {
          for (let j = 0; j < 5; j++) {
            if (j !== 3) put(p.x, p.y - 12 + j, [255, 246, 200]);
          }
          put(p.x, p.y - 8, [255, 246, 200]);
        }
        if (spin) {
          for (let k = 0; k < 12; k++) {
            const ang = (k / 12) * 6.283 + poked * 3;
            const r = 3 + poked * 16;

            blendPut(
              Math.round(p.x + Math.cos(ang) * r),
              Math.round(p.y + Math.sin(ang) * r * 0.8),
              k % 2 === 0 ? [255, 236, 170] : DRESS[i % DRESS.length],
              0.9 * (1 - poked / 1.5),
            );
          }
        }
        const at = (dx: number, dy: number): [number, number] => [
          p.x + dx * p.dir,
          p.y + dy,
        ];

        /* the halo */
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            const d = Math.hypot(dx, dy);

            if (d > 5.2) continue;
            blendPut(p.x + dx, p.y + dy, dress, 0.22 * (1 - d / 5.4) * a);
          }
        }

        /* wings behind the body */
        for (const [wx, wy] of WINGS[p.flap]) {
          const [x, y] = at(wx, wy);

          blendPut(x, y, SYLPH_WING, 0.88 * a);
        }

        /* hood, face, body, dress and legs */
        const part = (dx: number, dy: number, c: number[]) => {
          const [x, y] = at(dx, dy);

          put(x, y, c);
        };

        part(0, -4, dress);
        part(1, -4, dress);
        part(1, -3, [255, 232, 214]);
        part(0, -3, [255, 232, 214]);
        part(0, -2, dress);
        part(0, -1, SYLPH_BODY);
        part(-1, 0, dress);
        part(0, 0, dress);
        part(1, 0, dress);
        part(-1, 1, dress);
        part(0, 1, dress);
        part(0, 2, [255, 232, 214]);
        part(-1, 3, [255, 232, 214]);
        part(1, -2, [255, 232, 214]);
        /* a small lantern in the hand */
        blendPut(...at(2, -1), [255, 236, 150], a);
        blendPut(...at(3, -1), [255, 236, 150], 0.5 * a);
      }
    };

    /* One layer of the summit canopy: each clump is a little ring of
       leaves that sways in whole pixels and glints on the idle clock.
       `sm` (0..1) fades the crown in as the climb arrives. */
    const drawCanopy = (layer: 0 | 1, sm: number, sg: number, kx: number) => {
      for (const c of CANOPY) {
        if (c.layer !== layer) continue;

        const X = AX + (c.x - XF) * S * sg * kx;
        const Y = AY + (c.y - YF) * S * sg;
        const rs = c.r * S * sg;

        if (X < -rs || X > W + rs || Y < -rs || Y > H + rs) continue;

        const swX = swayOffset(MT, c.ph, 1.6 * LEAF_LIFE);
        const swY = swayOffset(MT, c.ph + 1.9, 0.8 * LEAF_LIFE);
        const back = layer === 0;
        const n = 8;

        for (let j = 0; j < n; j++) {
          const a = (j / n) * 6.283 + c.ph;
          const jig = hash((c.x * 7) | 0, (c.y * 5) | 0 + j);
          const lx = X + Math.cos(a) * rs * (0.25 + 0.4 * jig) + swX;
          const ly = Y + Math.sin(a) * rs * (0.2 + 0.32 * jig) + swY;

          leafCached(
            lx,
            ly,
            Math.max(1.6, rs * (0.34 + 0.16 * jig)),
            a,
            c.tone -
              (back ? 0.2 : 0) +
              0.2 * shimmerShift(MT, lx, ly, c.ph, LEAF_LIFE),
            leafRampFor((c.x * 3) | 0, ((c.y * 5) | 0) + j),
            sm,
          );
        }
      }
    };

    /* Soft, puffy clouds: a union of discs, light on top and bluish
       underneath, translucent so what is behind shows through. */
    const drawSummitClouds = (front: boolean, sm: number, dt: number) => {
      for (const cl of SUMMIT_CLOUDS) {
        if (cl.front !== front) continue;

        if (!reduced) cl.x += cl.v * dt;
        if (cl.x > W + 10) cl.x = -cl.w;

        const cx0 = Math.round(cl.x);
        const cy0 = Math.round(cl.y) + (reduced ? 0 : Math.round(Math.sin(MT * 0.12 + cl.v) * 1));
        const edge = clamp(Math.min(cl.x + cl.w, W - cl.x) / 24, 0, 1);

        for (let py = 0; py < cl.h; py++) {
          for (let px = 0; px < cl.w; px++) {
            let d = 9;

            /* each puff is an ellipse that stays inside the cloud's
               box, so the outline is round rather than clipped flat */
            for (const b of cl.blobs) {
              const rx = b.r * cl.w;
              const ry = Math.min(cl.h * 0.6, rx * 0.95);
              const dx = (px - b.ox * cl.w) / rx;
              const dy = (py - b.oy * cl.h) / ry;

              d = Math.min(d, Math.hypot(dx, dy));
            }

            /* a flat underside, like a real cumulus, that fades out softly
               instead of ending on a hard line */
            if (d > 1) continue;

            const under = clamp((cl.h * 0.95 - py) / (cl.h * 0.3), 0, 1);

            if (under <= 0) continue;

            const lit = 1 - py / cl.h;
            const a =
              (front ? 0.32 : 0.62) * (1 - d * d) ** 0.6 * under *
              sm * edge * (0.85 + 0.15 * hash(cx0 + px, cy0 + py));

            if (a < 0.02) continue;

            blendPut(
              cx0 + px,
              cy0 + py,
              mixRgb([200, 208, 228], [253, 253, 255], smoothstep(0.1, 0.7, lit)),
              a,
            );
          }
        }
      }
    };

    /* ---- the beanstalk stands in the clouds ----
       Jack's stalk is a road to the land above the sky, so it climbs
       through banks of cloud: a few puffs hide the top of the young
       stalk, more gather every few hundred feet up the climb, and at the
       summit the giant's castle stands on a cloud of its own. Puffs sit in
       the world, so they pass by as the camera climbs; some are behind the
       stalk and some in front of it. */
    const BEAN_PUFFS: { x: number; y: number; r: number; front: boolean; ph: number }[] = [];

    if (isBean) {
      const CR = rng(404);

      for (let tier = 0; tier < 13; tier++) {
        const y0 = 70 - tier * 270 + (tier === 0 ? 20 : 0);

        for (let k = 0; k < 4; k++) {
          const side = k % 2 === 0 ? -1 : 1;

          BEAN_PUFFS.push({
            x: 400 + side * (40 + CR() * 240),
            y: y0 + (CR() - 0.5) * 120,
            r: 70 + CR() * 70,
            front: k >= 2,
            ph: CR() * 6.3,
          });
        }
      }
    }

    const drawBeanClouds = (front: boolean, sg: number, kx: number, fade: number) => {
      const pxu = S * sg;
      /* clouds are far off, so they stop growing once the camera is close */
      const size = S * Math.min(sg, 1.4);
      const discs: [number, number, number][] = [
        [-0.55, 0.1, 0.62],
        [0, -0.22, 0.85],
        [0.58, 0.08, 0.6],
      ];

      for (const c of BEAN_PUFFS) {
        if (c.front !== front) continue;

        const drift = reduced ? 0 : Math.sin(MT * 0.06 + c.ph) * 16;
        const X = AX + (c.x + drift - XF) * pxu * kx;
        const Y = AY + (c.y - YF) * pxu;
        const R = c.r * size;

        if (Y + R < -4 || Y - R * 1.1 > H + 4 || X + R * 2.2 < -4 || X - R * 2.2 > W + 4) continue;

        for (let py = Math.max(0, Math.floor(Y - R * 1.1)); py <= Math.min(H - 1, Math.ceil(Y + R * 0.45)); py++) {
          /* the underside fades out softly rather than ending on a line */
          const under = clamp((Y + R * 0.42 - py) / (R * 0.5), 0, 1);

          if (under <= 0) continue;

          for (let px = Math.max(0, Math.floor(X - R * 2.2)); px <= Math.min(W - 1, Math.ceil(X + R * 2.2)); px++) {
            let d = 9;

            for (const [ox, oy, rr] of discs) {
              const dx = (px + 0.5 - (X + ox * R * 1.4)) / (rr * R * 1.4);
              const dy = (py + 0.5 - (Y + oy * R)) / (rr * R * 0.8);

              d = Math.min(d, Math.hypot(dx, dy));
            }
            if (d > 1) continue;

            const lit = clamp((Y - py) / (R * 0.9) * 0.5 + 0.55, 0, 1);
            const a = (front ? 0.3 : 0.62) * fade * under * (1 - d * d) ** 0.55 * (0.88 + 0.12 * hash(px, py));

            if (a < 0.03) continue;
            blendPut(px, py, mixRgb([186, 198, 224], [253, 253, 255], lit), a);
          }
        }
      }
    };

    /* ---- the castle at the top of the climb ----
       A 128 x 128 castle sprite (utils/castleSprite) stands far behind the
       tree: grey brick in staggered courses, round towers with scalloped
       roofs and gold finials, a round window over an arched door, windows
       that glow amber. The sleeper's castle (the rose supervine) is
       overgrown by thorned canes and roses as the climb reaches the top,
       and its vines go on creeping, very slowly; the giant's castle (the
       beanstalk) is paler and cooler, with a huge door, a golden harp in
       its window, a spill of gold, beanstalk tendrils and heart leaves,
       and a wreath of cloud round its foot. */
    const castleKind = speciesId === "rosevine" ? "rose" : isBean ? "bean" : null;
    /* to the right of the climbing trunk, so the door and the window are clear of it */
    const CASTLE_X = 100;
    const heartCache = new Map<string, { dx: number[]; dy: number[]; shade: number[] }>();
    const castlePainter: CastlePainter = {
      paint: (x, y, c, a) => paint(x, y, c, a),
      leafPixels: (r, ph, tone) => {
        const rq = Math.max(1, Math.round(r * 2) / 2);
        const pq = Math.round((((ph % 6.2832) + 6.2832) % 6.2832) / 0.5236) * 0.5236;
        const tq = Math.round(tone * 10) / 10;
        const key = `${rq}|${pq.toFixed(2)}|${tq}`;
        let px = heartCache.get(key);

        if (!px) {
          px = leafPixels("bean", rq, pq, tq);
          heartCache.set(key, px);
        }

        return px;
      },
    };
    /* the vines grow with the climb, then breathe in and out very slowly */
    const castleGrowth = (sm: number, lo: number, hi: number): number => {
      const base = lo + (hi - lo) * sm;

      if (reduced) return base;

      const tri = 0.5 - 0.5 * Math.cos(MT * 0.035);

      return base + 0.07 * tri;
    };
    const cloudWreath = (sm: number, ox: number, oy: number, rows: number) => {
      for (let k = 0; k < 11; k++) {
        const drift = reduced ? 0 : Math.sin(MT * 0.05 + k * 1.3) * 3;
        const cx = ox + 2 + k * 12 + drift;
        const cy = oy + 118 + (k % 3) * 3 - rows;
        const rx = 11 + (k % 3) * 3;
        const ry = 5 + (k % 2);

        for (let j = -ry; j <= ry; j++) {
          for (let i = -rx; i <= rx; i++) {
            const d = (i * i) / (rx * rx) + (j * j) / (ry * ry);

            if (d > 1) continue;
            paint(Math.round(cx + i), Math.round(cy + j), j < 1 ? [252, 250, 255] : [214, 208, 238], 0.9 * sm * (1 - d * d * 0.3));
          }
        }
      }
    };
    const drawGardenCastle = (sm: number) => {
      if (!castleKind) return;

      const c = castleSprite(castleKind);
      const ox = CASTLE_X;
      const oy = 8;
      const g = castleGrowth(sm, castleKind === "rose" ? 0.14 : 0.1, castleKind === "rose" ? 0.46 : 0.3);
      const t = reduced ? 0 : MT;

      /* a pale mist behind it so it stands apart from the foliage */
      for (let j = -6; j <= 126; j++) {
        for (let i = -20; i <= 148; i++) {
          const d = Math.hypot((i - 64) / 82, (j - 62) / 72);

          if (d > 1) continue;
          paint(ox + i, oy + j, [226, 218, 246], 0.34 * sm * (1 - d) ** 0.6);
        }
      }
      if (castleKind === "rose") cloudWreath(sm, ox, oy, -8);
      paintCastleSprite(c, castlePainter, ox, oy, sm, g, t);
      if (castleKind === "bean") cloudWreath(sm, ox, oy, 0);

      /* the door answers a poke: z's from the sleeper's, gold sparks for the giant's */
      const key = castleKind === "rose" ? "sleeper" : "giant";
      const poked = sinceKey(key, CLOCK);
      const flare = poked < 2.5;

      hitsRef.current.push({ key, x: ox + c.door.x, y: oy + c.door.y, w: c.door.w, h: c.door.h });
      if (reduced) return;
      if (castleKind === "rose") {
        const n = flare ? 4 : 2;

        for (let k = 0; k < n; k++) {
          const ph = (MT * (flare ? 0.55 : 0.26) + k / n) % 1;
          const zx = Math.round(ox + 74 + ph * 12 + Math.sin(ph * 6 + k) * 2);
          const zy = Math.round(oy + 84 - ph * 22);
          const za = (1 - ph) * Math.min(1, ph * 5) * sm;

          for (let i = 0; i < 3; i++) {
            blendPut(zx + i, zy, [244, 236, 255], za);
            blendPut(zx + i, zy + 2, [244, 236, 255], za);
          }
          blendPut(zx + 1, zy + 1, [244, 236, 255], za);
        }
      } else if (flare) {
        for (let k = 0; k < 14; k++) {
          const ph = (poked * 0.7 + k * 0.071) % 1;
          const a = k * 2.4;

          blendPut(Math.round(ox + 64 + Math.cos(a) * 20 * ph), Math.round(oy + 96 - 24 * ph + Math.sin(a) * 6), [255, 224, 120], (1 - ph) * sm);
        }
      }
    };

    /* ---- the top of the climb: magic, cloud and (for the rose) a field of roses ---- */
    const TOP_TONES: Record<string, number[][]> = {
      rose: [[255, 140, 210], [190, 140, 255], [255, 205, 160]],
      bean: [[120, 255, 170], [255, 226, 120], [140, 230, 255]],
    };
    /* A field of magic: slow ribbons of light across the top of the frame, a
       scatter of twinkling sparks, and a ceiling of drifting cloud. */
    const drawTopMagic = (sm: number) => {
      if (!castleKind) return;

      const tones = TOP_TONES[castleKind];
      const t = reduced ? 0 : MT;

      for (let b = 0; b < 3; b++) {
        const col = tones[b];

        for (let x = 0; x < W; x++) {
          const yc = 10 + b * 9 + 5 * Math.sin(x * 0.045 + t * 0.045 + b * 2.1) + 2.5 * Math.sin(x * 0.11 - t * 0.07 + b);
          const wob = 0.55 + 0.45 * Math.sin(x * 0.03 + t * 0.03 + b * 1.7);

          for (let j = -5; j <= 5; j++) {
            const a = 0.2 * sm * wob * (1 - Math.abs(j) / 5.5) ** 1.4;

            if (a > 0.015) blendPut(x, Math.round(yc + j), col, a);
          }
        }
      }
      /* sparks that twinkle and drift upward */
      for (let k = 0; k < 46; k++) {
        const sp = 0.8 + hash(k, 41) * 1.6;
        const y = 46 - (((reduced ? 0 : t * sp * 0.25) + hash(k, 42) * 46) % 46) + 2;
        const x = Math.round(hash(k, 43) * W + 4 * Math.sin(t * 0.05 + k));
        const tw = 0.5 + 0.5 * Math.sin(t * 0.4 + k * 2.3);

        if (tw < 0.3) continue;

        const col = tones[k % 3];
        const a = sm * tw;

        blendPut(x, Math.round(y), [255, 255, 245], a);
        if (tw > 0.75) {
          blendPut(x + 1, Math.round(y), col, a * 0.7);
          blendPut(x - 1, Math.round(y), col, a * 0.7);
          blendPut(x, Math.round(y) + 1, col, a * 0.7);
          blendPut(x, Math.round(y) - 1, col, a * 0.7);
        }
      }
      /* a ceiling of cloud */
      for (let k = 0; k < 10; k++) {
        const cx = ((k * 30 + (reduced ? 0 : t * 0.12)) % (W + 60)) - 30;
        const rx = 17 + (k % 3) * 4;
        const ry = 5 + (k % 2);

        for (let j = -ry; j <= ry; j++) {
          for (let i = -rx; i <= rx; i++) {
            const d = (i * i) / (rx * rx) + (j * j) / (ry * ry);

            if (d > 1) continue;

            const y = Math.round(1 + j + (k % 2));

            if (y < 0) continue;
            blendPut(Math.round(cx + i), y, j < 0 ? [252, 250, 255] : [222, 216, 244], 0.74 * sm * (1 - d * d * 0.5));
          }
        }
      }
    };

    /* The crown the trunk ends in: a bloom of leaves (or blossoms) over the
       flat top of the climbing trunk. */
    const drawTrunkCrown = (sm: number, sg: number, kx: number) => {
      if (!castleKind || !LEAF_RAMPS) return;

      const tx = AX + (cxw(TRUNK_TOP) - XF) * S * sg * kx;
      const ty = AY + (TRUNK_TOP - YF) * S * sg;

      if (tx < -20 || tx > W + 20 || ty < -20 || ty > H + 20) return;
      for (let k = 0; k < 22; k++) {
        const a = hash(k, 51) * 6.283;
        const d = Math.sqrt(hash(k, 52)) * 15;
        const ramp = LEAF_RAMPS[k % 3];

        leafCached(
          tx + Math.cos(a) * d * 1.2,
          ty - 3 + Math.sin(a) * d * 0.7,
          3.4 + hash(k, 53) * 2.2,
          hash(k, 54) * 6,
          0.5 + hash(k, 55) * 0.35,
          ramp,
          sm,
        );
      }
    };

    /* The rose supervine's field of roses, on the cloud at the foot of the
       castle. Click one and it sways and sparkles; double-click and it
       bursts into petals, then grows back. */
    interface FieldRose {
      x: number;
      y: number;
      tone: number;
      ph: number;
      seen: number;
    }
    const FIELD: FieldRose[] =
      speciesId === "rosevine"
        ? Array.from({ length: 15 }, (_, i) => ({
            x: 12 + i * 15.6 + (hash(i, 61) - 0.5) * 5,
            y: 128 + (hash(i, 62) - 0.5) * 6 + (i % 2) * 3,
            tone: i % 4,
            ph: hash(i, 63) * 6.28,
            seen: -1,
          }))
        : [];
    const FIELD_BLOOMS = [
      [[110, 20, 66], [168, 34, 96], [217, 58, 128], [245, 94, 156], [255, 143, 186]],
      [[120, 40, 80], [196, 88, 124], [234, 133, 166], [251, 180, 202], [255, 227, 236]],
      [[90, 10, 40], [150, 20, 60], [200, 30, 70], [235, 70, 100], [255, 130, 150]],
      [[130, 70, 120], [180, 110, 170], [220, 150, 205], [245, 190, 230], [255, 225, 245]],
    ];
    const FIELD_PETALS: { x: number; y: number; vx: number; vy: number; life: number; tone: number; r: number }[] = [];
    const burstAt = (i: number) => burstRef.current[`rosefield${i}`] ?? -1e9;

    const drawRoseField = (sm: number, dt: number) => {
      if (FIELD.length === 0) return;

      const t = reduced ? 0 : MT;

      FIELD.forEach((r, i) => {
        const b = burstAt(i);
        const since = CLOCK - b;

        /* a fresh double-click: throw the petals */
        if (b > r.seen && since >= 0 && since < 0.5) {
          r.seen = b;
          for (let k = 0; k < 20; k++) {
            const a = (k / 20) * 6.283 + hash(k, i) * 0.6;
            const sp = 22 + hash(k, i + 70) * 34;

            FIELD_PETALS.push({
              x: r.x,
              y: r.y - 8,
              vx: Math.cos(a) * sp * 1.3,
              vy: Math.sin(a) * sp * 0.9 - 30,
              life: 0,
              tone: r.tone,
              r: hash(k, i + 80),
            });
          }
        }

        /* the bloom: gone at the burst, a bud, then open again */
        const grow = since < 0 || since > 40 ? 1 : clamp((since - 0.6) / 7, 0, 1);

        if (grow <= 0) return;

        const sway = reduced ? 0 : Math.round(Math.sin(t * 0.06 + r.ph) * 1.2);
        const poked = sinceKey(`rosefield${i}`, CLOCK);
        const wiggle = poked < 1 && !reduced ? Math.round(Math.sin(poked * 24) * (1 - poked) * 2) : 0;
        const x = Math.round(r.x) + sway + wiggle;
        const y = Math.round(r.y);
        const stemH = Math.round(5 + 3 * grow);
        const ramp = FIELD_BLOOMS[r.tone];
        const rad = 1.2 + 2.4 * grow;

        for (let j = 0; j < stemH; j++) paint(x, y - j + 3, [52, 120, 62], sm);
        paint(x - 1, y + 1, [70, 150, 76], sm);
        paint(x - 2, y, [70, 150, 76], sm);
        paint(x + 1, y - 1, [70, 150, 76], sm);
        paint(x + 2, y - 2, [70, 150, 76], sm);

        const cy = y - stemH + 3;

        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const d = Math.hypot(dx, dy);

            if (d > rad + 0.2) continue;

            const q = (Math.atan2(dy, dx) / 6.283 + 1 + r.ph + d * 0.3) % 1;
            let idx = d < 0.8 ? 0 : q < 0.34 ? 2 : q < 0.67 ? 3 : 1;

            if (d > rad - 0.7 && dx >= 0 && dy >= 0) idx = 1;
            if (dx === -1 && dy === -1 && rad > 2) idx = 4;
            paint(x + dx, cy + dy, ramp[idx], sm);
          }
        }
        if (poked < 1 && !reduced) {
          /* a glint on a touched rose */
          paint(x + 3, cy - 3, [255, 250, 220], sm * (1 - poked));
          paint(x + 4, cy - 3, [255, 250, 220], sm * (1 - poked) * 0.6);
          paint(x + 3, cy - 4, [255, 250, 220], sm * (1 - poked) * 0.6);
        }
        if (grow > 0.85) hitsRef.current.push({ key: `rosefield${i}`, x: x - 5, y: cy - 6, w: 11, h: 14 });
      });

      for (let i = FIELD_PETALS.length - 1; i >= 0; i--) {
        const p = FIELD_PETALS[i];

        p.life += dt;
        p.vy += 46 * dt;
        p.vx *= 1 - 0.8 * dt;
        p.x += p.vx * dt + Math.sin(p.life * 7 + p.r * 6) * 8 * dt;
        p.y += p.vy * dt;
        if (p.life > 2.4 || p.y > H + 4) {
          FIELD_PETALS.splice(i, 1);
          continue;
        }

        const ramp = FIELD_BLOOMS[p.tone];
        const a = sm * clamp(1.6 - p.life * 0.6, 0, 1);
        const turn = Math.floor(p.life * 6 + p.r * 4) % 3;
        const x = Math.round(p.x);
        const y = Math.round(p.y);

        /* a petal is a little 2x3 curl that tumbles, with a pale edge */
        const body = ramp[3];
        const edge = ramp[4];

        if (turn === 0) {
          paint(x, y, body, a);
          paint(x + 1, y, edge, a);
          paint(x, y + 1, body, a);
          paint(x + 1, y + 1, ramp[2], a);
        } else if (turn === 1) {
          paint(x, y, edge, a);
          paint(x, y + 1, body, a);
          paint(x, y + 2, ramp[2], a);
          paint(x + 1, y + 1, body, a);
        } else {
          paint(x - 1, y + 1, ramp[2], a);
          paint(x, y, body, a);
          paint(x + 1, y, edge, a);
          paint(x + 2, y + 1, body, a);
        }
      }
    };

    const render = (P: number, dt: number, tm: number) => {
      hitsRef.current.length = 0;
      cov.fill(0);
      /* Transparent window: wipe the alpha channel only, so the
         landscape behind the tree shows through everywhere the
         tree has not painted (no black slab). */
      for (let i = 3; i < buf.length; i += 4) buf[i] = 0;

      const g = clamp(P / PA, 0, 1);
      GG = g;
      BEND_T = tm;
      CLOCK = tm;

      /* Motion clock and how alive the tree is at this growth. Reduced
         motion keeps the static tree. */
      MT = reduced ? 0 : motionTick(tm);
      ROOT_LIFE = reduced ? 0 : smoothstep(0.5, matureG, P);
      LEAF_LIFE = reduced ? 0 : smoothstep(matureG, 1, P);
      const ux = clamp((P - PA) / PB, 0, 1);
      const vx = clamp((P - PA - PB) / PC, 0, 1);
      const m = clamp((g - 0.06) / 0.9, 0, 1);
      const eg = easeInOut(m);
      const eu = easeInOut(ux);
      const ea = easeInOut(vx);
      const Z = Math.exp(Math.log(art.ZM) * eu);
      const sg = (0.2 + 0.8 * eg) * Z;
      CURSG = sg;
      const kx = 0.4 + 0.6 * eg;

      AX = art.BX + (W / 2 - art.BX) * eu;
      YF = 742 - art.DYW * ea;
      XF = art.ROOTX + (cxw(YF - 60) - art.ROOTX) * clamp(vx * 6, 0, 1);
      DY = (742 - YF) * S * Z;

      /* The bark climbs out of the crown while the camera zooms in, and
         the roots creep out from the trunk's foot, instead of both
         appearing whole. */
      const frameTop = YF - (AY + 1) / (S * Z);
      TRUNK_TOP =
        YOUNG_TOP + (frameTop - 50 - YOUNG_TOP) * smoothstep(0.02, 0.34, ux);
      ROOT_REACH = reduced ? 1 : smoothstep(0.2, 0.62, ux);
      /* At the top of the climb the bark ends and the crown takes over. */
      TRUNK_TOP = Math.max(TRUNK_TOP, SUMMIT_Y);
      const SM = smoothstep(0.7, 1, vx);

      const sh = Math.round(AX - art.BX);
      for (const [x, y, c, b] of SP) {
        if (layersRef.current.has("pollen")) break;
        if (g >= b && y + DY < H) {
          const fade = smoothstep(b, b + 0.06, g);
          if (fade >= 0.995) put(x + sh, (y + DY) | 0, c);
          else blendPut(x + sh, (y + DY) | 0, c, fade);
        }
      }

      /* Clouds occasionally pass by once the tree matures: soft
         puffs drifting behind the crown, so the canopy silhoutte
         still reads over them. */
      if (g >= matureG && !layersRef.current.has("clouds")) {
        /* Fade in at the Mature arrival; fade out while entering
           and leaving the frame, so clouds never pop on or off. */
        const growFade = smoothstep(matureG, matureG + 0.06, g);
        for (const cloud of clouds) {
          if (!reduced) cloud.x += cloud.v * dt;
          if (cloud.x > W + 40) cloud.x = -cloud.w;
          if (cloud.x < -cloud.w - 2) cloud.x = W + 40;
          const edgeFade = reduced
            ? 1
            : clamp((cloud.x + 26) / 26, 0, 1) *
              clamp((W + 26 - cloud.x) / 26, 0, 1);
          const cx = Math.round(cloud.x);
          const cy = Math.round(cloud.y);
          const driftY = reduced
            ? 0
            : Math.round(Math.sin(MT * 0.7 + cloud.ph) * 1.2);
          for (let py = 0; py < cloud.h; py++) {
            for (let px = 0; px < cloud.w; px++) {
              const nx = (px / cloud.w - 0.5) * 2;
              const ny = (py / cloud.h - 0.5) * 2;
              const puff = nx * nx + ny * ny * 1.7;
              if (puff > 1) continue;
              const dither = hash(px * 5 + 13, py * 7 + 29) * 0.2;
              const a =
                (0.34 + 0.28 * (1 - puff) + dither) *
                growFade *
                edgeFade;
              if (a < 0.01) continue;
              blendPut(cx + px, cy + py + driftY, [240, 238, 231], a);
            }
          }
        }
      }

      /* Ground-contact shadow: a soft dithered ellipse under the
         root, scaled to the trunk's base width and the current
         growth stage. Fades out once the camera lifts off the
         ground into the zoom/ascent. */
      {
        const shFade = clamp(1 - eu / 0.5, 0, 1) * clamp(eg * 3, 0, 1);
        if (shFade > 0.02) {
          const [rx0, ry0] = pt(
            { sp: [[art.ROOTX, 742]], ws: [1], g0: 0, gd: 1 },
            0,
            sg,
            kx,
          );
          /* Flare the shadow well past the trunk's own half-width
             (baseW0 is the FULL width) so it reads as a puddle the
             trunk sits in rather than being fully eclipsed by the
             trunk's own opaque paint. */
          const baseW0 = lerpArr(TR.ws, 0) * S * sg;
          const srx = Math.max(10, baseW0 * 1.05);
          const sry = Math.max(3, srx * 0.3);
          const scol = mixRgb(ACN[1] ?? [60, 48, 40], [0, 0, 0], 0.5);
          for (
            let py = Math.floor(ry0 + 1 - sry);
            py <= Math.ceil(ry0 + 1 + sry);
            py++
          ) {
            for (
              let px = Math.floor(rx0 - srx);
              px <= Math.ceil(rx0 + srx);
              px++
            ) {
              if (px < 0 || py < 0 || px >= W || py >= H) continue;
              const nx = (px + 0.5 - rx0) / srx;
              const ny = (py + 0.5 - (ry0 + 1)) / sry;
              const nd = nx * nx + ny * ny;
              if (nd > 1) continue;
              const p = Math.pow(1 - nd, 0.55) * 0.9 * shFade;
              if (hash(px * 7, py * 11) < p) put(px, py, scol);
            }
          }
        }
      }

      if (DY <= 0) {
        if (speciesId === "oak") {
          /* the acorn's tuft */
          for (let x = art.BX - 12; x <= art.BX + 12; x++) {
            const d = (x + 0.5 - art.BX) / 12;
            const h = 3 * (1 - d * d);
            if (h <= 0) continue;
            for (let y = Math.floor(GROUND_ROW + 0.2 - h); y <= GROUND_ROW; y++) {
              put(x + sh, y, BARK[hash(x, y) > 0.6 ? 1 : 0]);
            }
          }
          if (g < 0.05) {
            put(art.BX, GROUND_ROW - 2, ACN[0]);
            put(art.BX - 1, GROUND_ROW - 2, ACN[0]);
            put(art.BX, GROUND_ROW - 3, ACN[1]);
            put(art.BX - 1, GROUND_ROW - 3, ACN[1]);
          }
        } else {
          for (let x = art.BX - 3; x <= art.BX + 13; x++) {
            const d = (x + 0.5 - art.BX) / 8;
            const h = 2.8 * (1 - d * d);
            if (h <= 0) continue;
            for (let y = Math.floor(GROUND_ROW + 0.2 - h); y <= GROUND_ROW; y++) {
              put(x + sh, y, BARK[hash(x, y) > 0.6 ? 1 : 0]);
            }
          }
          if (g < 0.05) {
            if (art.mapleLeaf) {
              put(art.BX, GROUND_ROW - 2, ACN[0]);
              put(art.BX + 1, GROUND_ROW - 3, ACN[1]);
              put(art.BX + 2, GROUND_ROW - 4, ACN[1]);
              put(art.BX + 3, GROUND_ROW - 4, ACN[1]);
            } else if (speciesId === "beanstalk") {
              /* the magic bean: a speckled kidney, one pip of light */
              put(art.BX + 5, GROUND_ROW - 2, ACN[0]);
              put(art.BX + 6, GROUND_ROW - 2, ACN[0]);
              put(art.BX + 6, GROUND_ROW - 3, ACN[1]);
              put(art.BX + 7, GROUND_ROW - 3, ACN[0]);
            } else if (speciesId === "rosevine") {
              /* a rose hip: a small red berry on the ground */
              put(art.BX + 5, GROUND_ROW - 2, ACN[0]);
              put(art.BX + 6, GROUND_ROW - 2, ACN[0]);
              put(art.BX + 5, GROUND_ROW - 3, ACN[1]);
              put(art.BX + 6, GROUND_ROW - 3, ACN[0]);
            } else {
              put(art.BX + 6, GROUND_ROW - 2, [120, 84, 62]);
              put(art.BX + 5, GROUND_ROW - 2, [96, 66, 50]);
            }
          }
        }
      }

      /* The crown, far above: while the camera looks up the trunk, its
         underside shows as a faded shadow along the top of the frame,
         drifting and glinting on the idle clock. It sits behind the
         bark and grows heavier the higher the climb. */
      {
        const sa =
          layersRef.current.has("crownshadow")
            ? 0
            : smoothstep(0.3, 0.7, ux) * (1 - 0.85 * smoothstep(0.7, 1, vx));

        if (sa > 0.02) {
          const depth = 8 + 22 * smoothstep(0, 1, vx);
          const dark = mixRgb(FOLI[0], [34, 40, 58], 0.4);
          const mid = mixRgb(FOLI[Math.min(1, FOLI.length - 1)], [58, 66, 84], 0.35);
          const glint = mixRgb(FOLI[Math.min(3, FOLI.length - 1)], [120, 128, 146], 0.35);

          for (let x = 0; x < W; x++) {
            /* two overlapping lumps make the scalloped underside; each
               drifts a whole pixel at a time */
            const drift = swayOffset(MT, x * 0.021, 1.5);
            const lump =
              0.5 +
              0.3 * Math.sin((x + drift) * 0.11 + 1.3) +
              0.2 * Math.sin((x - drift) * 0.047 + 4.1);
            const edge = depth * (0.35 + 0.65 * lump);

            for (let y = 0; y < edge; y++) {
              const depthK = y / Math.max(1, edge);
              /* leafy fringe along the hanging edge only */
              if (edge - y < 3 && hash(x * 3 + 7, y * 5 + 3) < 0.55 - 0.15 * (edge - y)) {
                continue;
              }

              /* leaf clumps are 2x2 blocks, so the shadow reads as
                 pixel-art foliage rather than noise */
              const clump = hash((x >> 1) + 11, (y >> 1) + 29);
              const shim = shimmerShift(MT, x, y, 2.2, 1);
              const c =
                shim > 0 && clump > 0.5
                  ? glint
                  : clump > 0.62
                    ? mid
                    : dark;

              paint(x, y, c, sa * (0.42 - 0.18 * depthK));
            }
          }
        }
      }

      const beanFade = isBean && !layersRef.current.has("summitclouds") ? smoothstep(0.35, 0.65, g) : 0;

      if (beanFade > 0.01) drawBeanClouds(false, sg, kx, beanFade);
      if (SM > 0.01) {
        if (!layersRef.current.has("summitclouds")) drawSummitClouds(false, SM, dt);
        /* the castle terrace stands far behind the tree, in the background */
        if (castleKind && (speciesId === "rosevine" || beanFade > 0.01)) drawGardenCastle(SM);
        if (!castleKind) drawCanopy(0, SM, sg, kx);
      }

      DM = 0;
      if (ux < 0.08) {
        limb(TR, g, sg, kx);
        if (g > 0.45) {
          const N = TR.sp.length;
          const a = clamp((g - 0.45) / 0.3, 0, 1);
          for (let i = (N * 0.04) | 0; i < N * 0.6 * a; i++) {
            const t = i / (N - 1);
            const w = (lerpArr(TR.ws, t) * S * sg) / 2;
            const [X, Y] = pt(TR, t, sg, kx);
            const px = Math.round(X + Math.sin(t * 38) * w * 0.55);
            const py = Math.round(Y);
            if (
              px >= 0 && px < W && py >= 0 && py < H &&
              cov[py * W + px]
            ) {
              put(px, py, MOSS);
            }
          }
        }
      }

      DM = clamp(ux / 0.3, 0, 1);
      if (DM < 1) {
        BR.forEach((o) => limb(o, g, sg, kx));
      }

      if (ux > 0) {
        const bl = Math.min(1, ux / 0.08);
        refreshRootMask(Z, eu);
        for (let sy = 0; sy < H; sy++) {
          for (let sx = 0; sx < W; sx++) {
            const rc = rootPx(sx, sy);
            if (rc) {
              put(sx, sy, rc);
            } else if (hash(sx * 3, sy) < bl) {
              const c = trunkPx(sx, sy, Z, eu, tm);
              if (c) put(sx, sy, c);
            }
          }
        }
      }

      if (vx > 0) {
        for (const stub of ascentStubs) {
          const [tX, tY] = pt(
            { sp: [[stub.tipX, stub.tipY]], ws: [1], g0: 0, gd: 1 },
            0,
            sg,
            kx,
          );
          if (tY < -40 - stub.lr[0] * S * sg || tY > H + 40) continue;
          /* at the top of the climb the castle stands behind the boughs: let
             the limbs and tufts that would hide it go, and keep a few at its edges */
          const castleX = CASTLE_X;
          const hides =
            castleKind !== null &&
            tX > castleX - 4 &&
            tX < castleX + CASTLE_W + 4 &&
            tY > 4 &&
            tY < 136;
          const opened =
            castleKind !== null &&
            hash((stub.tipX * 7) | 0, (stub.tipY * 3) | 0) < (hides ? 0.97 : 0.55) * SM;

          const topX = AX + (cxw(TRUNK_TOP) - XF) * S * sg * kx;
          const topY = AY + (TRUNK_TOP - YF) * S * sg;
          const nearTop = Math.abs(tX - topX) < 30 && tY < topY + 40;

          if (!(hides && !nearTop && hash((stub.tipX * 5) | 0, (stub.tipY * 11) | 0) < 0.85 * SM)) ascentLimb(stub, sg, kx);
          if (stub.leafy && !opened) drawAscentTuft(stub, sg, kx);
        }
      }

      if (SM > 0.01) {
        if (!castleKind) drawCanopy(1, SM, sg, kx);
        if (!layersRef.current.has("summitclouds")) drawSummitClouds(true, SM, dt);
      }
      if (beanFade > 0.01) drawBeanClouds(true, sg, kx, beanFade);
      if (castleKind && SM > 0.01) {
        drawTrunkCrown(SM, sg, kx);
        drawTopMagic(SM);
        drawRoseField(SM, dt);
      }

      const uT = clamp((g - 0.03) / 0.2, 0, 1);
      const cr = 1.9 * clamp(uT * 3, 0, 1) * (1 - clamp((g - 0.35) / 0.2, 0, 1));
      if (cr > 0.5) {
        const [tx, ty] = pt(TR, uT, sg, kx);
        leaf(tx - 1.8, ty + 0.4, cr, 0, 0.7);
        leaf(tx + 1.8, ty + 0.4, cr, 2, 0.7);
      }

      if (ux < 0.5) {
        const dens = clamp(
          0.08 + 1.1 * Math.pow(clamp((g - 0.2) / 0.7, 0, 1), 1.5),
          0,
          1,
        );
        for (const L of leaves) {
          const k = hash((L.x * 97) | 0, (L.y * 89) | 0);
          if (k > dens || ux > 0.1 + 0.38 * k) continue;
          const p = (g - (0.2 + (L.b - 0.34) * 1.2)) / 0.07;
          if (p <= 0) continue;
          drawLeaf(L, 1 - Math.pow(1 - Math.min(1, p), 3), sg, kx);
        }
      }

      if (g >= 1) {
        if (!layersRef.current.has("fall")) fall(dt, ux > 0, tm);
        if (!reduced && !layersRef.current.has("bigfall")) bigFall(dt, ux > 0, tm);
      }

      /* Birds rest on the crown once it has filled out: 2-3 perched on the
         top leaves, hopping to a fresh leaf now and then, wings flicking
         on the flap. They fly in from above as the crown completes and
         lift off again if the tree shrinks. */
      {
        const want = g >= BIRDS_AT && perches.length > 0 && !layersRef.current.has("birds") ? 1 : 0;
        const step = reduced ? 1 : Math.min(dt, 0.1) / 1.4;

        BIRDS_HERE = clamp(
          BIRDS_HERE + (want > BIRDS_HERE ? step : want < BIRDS_HERE ? -step : 0),
          0,
          1,
        );
      }

      if (BIRDS_HERE > 0.001) {
        const body = [38, 32, 24];
        const head = [46, 40, 30];
        const beak = [238, 200, 110];
        const hop = reduced ? 0 : Math.floor(tm / 2.4);
        const n = Math.min(3, perches.length);
        const arrive = smoothstep(0, 1, BIRDS_HERE);
        const hopPhase = reduced ? 0.5 : tm % 2.4;
        const hopFade = reduced
          ? 1
          : Math.min(
              smoothstep(0, 0.3, hopPhase),
              1 - smoothstep(2.1, 2.4, hopPhase),
            );
        const bf = arrive * hopFade;
        const fput = (x: number, y: number, c: number[]) => {
          if (bf >= 0.995) put(x, y, c);
          else blendPut(x, y, c, bf);
        };
        /* in flight: high above the leaf, sliding in from the side */
        const air = 1 - arrive;

        for (let i = 0; i < n; i++) {
          const spot = perches[(hop * 3 + i * 3) % perches.length];
          /* the leaf, where drawLeaf puts it, and its top edge */
          const lx = AX + (spot.x + bendWorld(spot.y / S, sg) * S - XF * S) * sg * kx;
          const ly = AY + (spot.y - YF * S) * sg;
          const lr = spot.r * (0.55 + 0.45 * sg);
          const bx = Math.round(lx + (i - 1) * 3 + air * (i % 2 ? 26 : -26));
          const by = Math.round(ly - lr * 0.7 - 1 - air * 22);

          if (bx < 3 || bx > W - 8 || by < 3 || by > H - 4) continue;

          const wing = reduced || air > 0.02
            ? air > 0.02
              ? Math.floor(tm * 9 + i) % 2
              : 0
            : Math.floor(tm * 2.2 + i * 1.7) % 2;

          fput(bx - 1, by - 1, body);
          fput(bx, by - 1, body);
          fput(bx + 1, by - 1, body);
          if (wing) fput(bx + 1, by - 2, body);
          if (air > 0.02 && wing) fput(bx - 1, by - 2, body);
          fput(bx + 3, by - 1, head);
          fput(bx + 4, by - 1, beak);
          fput(bx, by, body);
          if (air <= 0.02) blendPut(bx, by + 1, [20, 18, 14], 0.3 * bf);
        }
      }

      if (charmsRef.current.length > 0) {
        const pxu = S * sg;
        /* places where things can hang: crown leaves in the whole-tree
           view, the tips of the climb's branches higher up */
        const anchors: { id: number; x: number; y: number }[] = [];

        if (ux < 0.5) {
          for (let i = 0; i < leaves.length && anchors.length < 16; i += 9) {
            const L = leaves[i];

            if (L.b > GG) continue;

            const ax = AX + (L.x + bendWorld(L.y / S, sg) * S - XF * S) * sg * kx;
            const ay = AY + (L.y - YF * S) * sg + L.r * (0.55 + 0.45 * sg) * 0.7;

            if (ax > 4 && ax < W - 4 && ay > 4 && ay < H - 12) {
              anchors.push({ id: i, x: ax, y: ay });
            }
          }
        }
        if (vx > 0) {
          ascentStubs.forEach((stub, i) => {
            if (!stub.leafy || anchors.length >= 22) return;

            const ax = AX + (stub.tipX - XF) * pxu * kx;
            const ay = AY + (stub.tipY - YF) * pxu + 2;

            if (ax > 4 && ax < W - 4 && ay > 4 && ay < H - 12) {
              anchors.push({ id: 5000 + i, x: ax, y: ay });
            }
          });
        }

        const charmEnv: CharmEnv = {
          W,
          H,
          tm,
          dt: Math.min(dt, 0.1),
          memo: memoRef.current,
          tick: MT,
          reduced,
          put,
          blend: blendPut,
          proj: (wx, wy) => [AX + (wx - XF) * pxu * kx, AY + (wy - YF) * pxu],
          scale: pxu,
          trunk: (wy) => {
            const yi = clamp(Math.round(wy), 0, 799);
            const w =
              ((wy >= art.trunkFracY ? RW[yi] : art.trunkLowW) * (1 - eu) +
                wW(wy) * eu) *
              (1 + 0.8 * Math.exp(-(742 - wy) / 38));

            return { cx: cxw(wy), half: Math.max(3, w / 2) };
          },
          groundY: AY + (742 - YF) * pxu,
          barkTop:
            ux > 0.02
              ? TRUNK_TOP
              : Math.max(
                  YOUNG_TOP,
                  TR.sp[
                    Math.min(
                      TR.sp.length - 1,
                      Math.floor(clamp((GG - TR.g0) / TR.gd, 0, 1) * (TR.sp.length - 1)),
                    )
                  ][1],
                ),
          trunkTop:
            ux > 0.02
              ? TRUNK_TOP
              : TR.sp[
                  Math.min(
                    TR.sp.length - 1,
                    Math.floor(clamp((GG - TR.g0) / TR.gd, 0, 1) * (TR.sp.length - 1)),
                  )
                ][1],
          asc: smoothstep(0.04, 0.5, vx),
          since: (key) => sinceKey(key, tm),
          hit: (key, x, y, w, h) => {
            hitsRef.current.push({ key, x, y, w, h });
          },
          hover: hoverRef.current,
          anchors,
          foliage: FOLI,
          bark: BARK,
          moss: MS,
        };

        drawCharms(charmsRef.current, charmEnv);

        /* For tests and tools: how tall the trunk is and how big the world is on screen. */
        if (ref.current) {
          ref.current.dataset.trunk = `${Math.round(charmEnv.trunkTop)},${charmEnv.scale.toFixed(3)},${Math.round(charmEnv.groundY)}`;
        }
      }

      drawAscentAccents(smoothstep(0.04, 0.5, vx), tm);

      /* Where the creatures are, for assistive tools and tests. */
      if (ref.current) {
        const summary = hitsRef.current
          .map((h) => `${h.key}:${h.x},${h.y},${h.w},${h.h}`)
          .join(";");

        if (ref.current.dataset.creatures !== summary) {
          ref.current.dataset.creatures = summary;
        }
      }

      off.putImageData(img, 0, 0);

      /* Blit the whole frame: the canvas is the stage, so there is no
         window to crop to, and no pan or zoom to resample. */
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offRef.current!, 0, 0);
    };

    try {
      render(dispRef.current, 0, performance.now() / 1000);
    } catch (err) {
      console.error("tree first paint failed (will retry):", err);
    }

    /* Snapshots paint one frame at the target growth and stop the
       loop: no replay, no sway, no leaf fall. */
    if (staticFrame) {
      dispRef.current = clamp(growthRef.current, 0, 1);
      try {
        render(dispRef.current, 0, 0);
      } catch (err) {
        console.error("tree snapshot paint failed:", err);
      }
      return () => undefined;
    }

    let raf = 0;
    let last = performance.now();
    let broken = false;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const target = clamp(growthRef.current, 0, 1);
      if (!reduced) {
        const gap = target - dispRef.current;
        const step = FOLLOW_RATE * dt;

        dispRef.current =
          Math.abs(gap) <= step ? target : dispRef.current + Math.sign(gap) * step;
      } else {
        dispRef.current = target;
      }

      if (!broken) {
        try {
          render(dispRef.current, dt, now / 1000);
        } catch (err) {
          /* Never die silently: report once and keep retrying so
             the tree appears (or recovers) on the next frame. */
          broken = true;
          console.error("tree render failed:", err);
          window.setTimeout(() => {
            broken = false;
          }, 250);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [shape, pal, speciesId, speciesKey, reduced, variantId]);

  return (
    <div
      className="flex w-full flex-col items-center"
      data-pixel-growth-tree
    >
      <div
        className="relative"
        style={{
          height: `${H * pxScale}px`,
          width: `${W * pxScale}px`,
        }}
      >
      <canvas
        ref={ref}
        width={W}
        height={H}
        role="img"
        aria-label="Pixel art tree growing"
        className="block h-full w-full touch-none cursor-pointer"
        style={{ imageRendering: "pixelated" }}
        onClick={(event) => {
          const key = creatureAt(event.clientX, event.clientY);

          if (key) {
            pokesRef.current[key] = performance.now() / 1000;
            onCreature?.(key.startsWith("sylph") ? "sylph" : key.startsWith("rosefield") ? "rosefield" : key);

            return;
          }
          onTreeClick?.();
        }}
        onDoubleClick={(event) => {
          const key = creatureAt(event.clientX, event.clientY);

          if (key && key.startsWith("rosefield")) {
            burstRef.current[key] = performance.now() / 1000;
            onCreature?.("rosefield-burst");
          }
        }}
        onPointerMove={(event) => {
          hoverRef.current = creatureAt(event.clientX, event.clientY);
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
        }}
      />
      </div>
    </div>
  );
}

/* A garden-style miniature of a species: the same pixel art the
   garden uses, snapped to the tree's YOUNG stage (the Sapling, its
   own stage-fert threshold), on a transparent background so the
   card shows through behind the tree. */
export function PixelSprite({
  speciesId,
  scale = 0.25,
  className = "",
}: {
  speciesId: TreeSpeciesId;
  /** Css pixels per art pixel: 0.25 keeps a 256x144 canvas at 64x36. */
  scale?: number;
  className?: string;
}) {
  /* The young tree snapshot: each species' Sapling threshold as a
     fraction of the ancient tree. */
  const youngGrowth =
    SPECIES_STAGE_FERT[speciesId][2] / TREE_GROWTH_TARGET;

  return (
    <div
      className={`pointer-events-none shrink-0 select-none overflow-hidden rounded-sm border-[2px] border-gray-900 bg-transparent ${className}`}
      style={{ width: W * scale, height: H * scale }}
      aria-hidden="true"
    >
      <PixelGrowthTree
        speciesId={speciesId}
        growth={youngGrowth}
        cssScale={scale}
        static
      />
    </div>
  );
}

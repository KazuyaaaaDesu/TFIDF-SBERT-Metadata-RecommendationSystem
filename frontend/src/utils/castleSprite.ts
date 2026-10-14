/**
 * The castles at the top of the Garden's climbs, built as 128 x 128 pixel
 * sprites in the manner of the "Briar Rose Castle" study: a keep of grey
 * brick laid in three-pixel courses with staggered six-pixel bricks, two
 * round towers with scalloped cone roofs and gold finials, arrow slits, a
 * rose window over an arched wooden door, and a thorned vine that climbs
 * the towers until the castle is overgrown.
 *
 * Two variants share the craft:
 *   rose  the sleeper's castle: warm grey stone, pink roofs, pink briars
 *         with cream thorns and roses, a door ajar on a bed
 *   bean  the giant's castle: cooler, paler stone and pale slate roofs, a
 *         huge door, a golden harp in the round window, green beanstalk
 *         tendrils with heart leaves in place of thorns, gold accents
 *
 * The stone is painted once into a colour buffer with a material mask; the
 * vines are lists of points that each carry the growth at which they
 * appear, so one number (0..1) says how far the castle is overgrown. Pure
 * and DOM-free, so it runs under `node --test`.
 */

export type CastleKind = "rose" | "bean";

export const CASTLE_W = 128;
export const CASTLE_H = 128;

/** Material codes in the mask. */
export const MAT = {
  none: 0,
  stone: 1,
  roof: 2,
  door: 3,
  glass: 4,
  gold: 5,
  plant: 6,
  glow: 7,
} as const;

type Rgb = number[];

export interface CanePoint {
  x: number;
  y: number;
  /** Visible (false where the cane passes behind a tower). */
  v: boolean;
  /** The growth at which the cane reaches this point. */
  tb: number;
  w: number;
  u: number;
  nx: number;
  ny: number;
}

export interface Cane {
  pts: CanePoint[];
  th: { x: number; y: number; tb: number }[];
  kind: number;
  /** Seen against the sky rather than the wall. */
  sky: boolean;
}

export interface CastleLeaf {
  x: number;
  y: number;
  tb: number;
  s: number;
  a: number;
  t: number;
  fg: boolean;
  sky: boolean;
}

export interface CastleBloom {
  x: number;
  y: number;
  tb: number;
  r: number;
  ph: number;
  sky: boolean;
}

export interface Castle {
  kind: CastleKind;
  /** RGB per pixel. */
  C: Uint8Array;
  /** Material per pixel. */
  M: Uint8Array;
  /** Pixels that glow (the windows). */
  glass: Int32Array;
  /** Pixels where leaves may be drawn (close to the castle). */
  near: Uint8Array;
  canes: Cane[];
  leaves: CastleLeaf[];
  blooms: CastleBloom[];
  /** Where to click: the sleeper's door or the giant's door. */
  door: { x: number; y: number; w: number; h: number };
  palette: {
    cane: Rgb[];
    tip: Rgb[];
    thorn: Rgb;
    leaf: Rgb[];
    bloom: Rgb[];
    glow: Rgb;
    dark: Rgb;
  };
}

/* ------------------------------------------------------------ */
/* small helpers                                                 */
/* ------------------------------------------------------------ */

const hx = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const PAL = (a: string[]): Rgb[] => a.map(hx);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const hash = (x: number, y: number): number => {
  let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);

  h ^= h >>> 13;

  return (h & 0xffff) / 65535;
};

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;

  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PALETTES = {
  rose: {
    ST: PAL(["#cdc9dc", "#b2aec7", "#9894b0", "#7e7a98", "#656280", "#4d4b66"]),
    RF: PAL(["#ffb8d2", "#ff7da9", "#ec508a", "#c4346d", "#92234f", "#651541"]),
    GOLD: PAL(["#ffe07a", "#d49a2e"]),
  },
  bean: {
    ST: PAL(["#f3f7fd", "#dfe8f5", "#c9d7ec", "#aebfdc", "#93a6c8", "#7388b0"]),
    RF: PAL(["#e8f4ff", "#c4e3f7", "#9ccdec", "#74b0dc", "#5590c4", "#3e6fa2"]),
    GOLD: PAL(["#fff0a0", "#e8b03a"]),
  },
};
const WD = PAL(["#74403d", "#5a2d33", "#40212b", "#2b1620"]);
const GRN = PAL(["#14302d", "#1e463a", "#2c6446", "#418354", "#66a766"]);
const DK = hx("#2a2439");
const AMB = hx("#ffcf6a");

const cache = new Map<CastleKind, Castle>();

/** The castle of this kind, built once. */
export function castleSprite(kind: CastleKind): Castle {
  let c = cache.get(kind);

  if (!c) {
    c = buildCastle(kind);
    cache.set(kind, c);
  }

  return c;
}

/* ------------------------------------------------------------ */
/* building                                                      */
/* ------------------------------------------------------------ */

function buildCastle(kind: CastleKind): Castle {
  const W = CASTLE_W;
  const H = CASTLE_H;
  const { ST, RF, GOLD } = PALETTES[kind];
  const bean = kind === "bean";
  const R = mulberry(bean ? 2024 : 1009);
  const C = new Uint8Array(W * H * 3);
  const M = new Uint8Array(W * H);
  const WIN: number[] = [];

  const px = (x: number, y: number, c: Rgb, m: number) => {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;

    const k = y * W + x;

    C[k * 3] = c[0];
    C[k * 3 + 1] = c[1];
    C[k * 3 + 2] = c[2];
    M[k] = m;
    if (m === MAT.glow) WIN.push(k);
  };

  /* brick: courses three pixels high, bricks six wide, staggered */
  const wall = (x: number, y: number, light: number, sx: number): Rgb => {
    const row = Math.floor(y / 3);
    const my = y - row * 3;
    const bx = Math.floor(sx) + (row & 1) * 3 + 240;
    const col = Math.floor(bx / 6);
    const mx = bx - col * 6;
    let v = light + (hash(col, row) - 0.5) * 0.2;

    if (my === 1) v += 0.06;
    if (my === 2) v -= 0.05;

    let i = clamp(Math.floor((1 - v) * 6), 0, 5);

    if (my === 0 || mx === 0) i = Math.min(5, i + 2);

    return ST[i];
  };

  /* ---- the keep ---- */
  for (let y = 47; y < 110; y++) {
    for (let x = 32; x < 96; x++) {
      if (y < 52 && (x - 32) % 8 > 4) continue;

      const fx = (x - 32) / 64;
      let l = 0.68 - 0.14 * fx;

      if (y < 52) {
        l += y === 47 ? 0.24 : 0.12;
      } else if (y < 56) {
        l = 0.78 - 0.1 * fx + (y === 52 ? 0.12 : 0);
      } else if (y === 56) {
        l = 0.38;
      } else {
        const dl = x - 35;
        const dr = 93 - x;

        if (dl < 7) l -= 0.22 * (1 - dl / 7);
        if (dr < 7) l -= 0.22 * (1 - dr / 7);
        if (y < 62) l -= 0.1 * (1 - (y - 56) / 6);
      }
      px(x, y, wall(x, y, l, x), MAT.stone);
    }
  }

  /* ---- the round window over the door ---- */
  const winCy = bean ? 66 : 76;
  const winR = bean ? 6.4 : 9.5;
  const winInner = bean ? 4.4 : 6.9;

  for (let y = winCy - 12; y < winCy + 12; y++) {
    for (let x = 52; x < 77; x++) {
      const dx = x + 0.5 - 64;
      const dy = y + 0.5 - winCy;
      const d = Math.hypot(dx, dy);

      if (d > winR) continue;
      if (d > winInner) {
        const k = Math.floor((Math.atan2(dy, dx) + 7) * 3.4);
        let i = k & 1 ? 1 : 2;

        if (dx + dy > 4) i++;
        px(x, y, ST[Math.min(5, i)], MAT.stone);
      } else if (bean) {
        /* the giant's window frames a golden harp: strings across, a bow on the left */
        let c: Rgb = DK;
        let m: number = MAT.glow;

        if (Math.abs(dy + dx * 0.2) < 0.6 || d < 1) {
          m = MAT.gold;
          c = GOLD[0];
        }
        if (dx > -3.6 && dx < 3.6 && Math.abs(Math.round(dx * 1.1) % 2) === 0 && dy > -3.4 && dy < 3.6) {
          m = MAT.gold;
          c = GOLD[1];
        }
        if (dx < -3 && dx > -4.4) {
          m = MAT.gold;
          c = GOLD[0];
        }
        px(x, y, c, m);
      } else {
        let c: Rgb = DK;
        let m: number = MAT.glow;

        if (Math.abs(dx) < 0.7 || Math.abs(dy) < 0.7) {
          c = ST[3];
          m = MAT.stone;
        }
        if (d < 1.6) {
          c = ST[2];
          m = MAT.stone;
        }
        px(x, y, c, m);
      }
    }
  }
  if (!bean) {
    /* roses in the petals of the window */
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      const X = 64 + 4.8 * Math.cos(a);
      const Y = 76 + 4.8 * Math.sin(a);
      const RS = PAL(["#6e1442", "#a82260", "#d93a80", "#f55e9c", "#ff8fba", "#ffc4dc"]);

      px(X - 1, Y - 1, RS[3], MAT.plant);
      px(X, Y - 1, RS[2], MAT.plant);
      px(X - 1, Y, RS[2], MAT.plant);
      px(X, Y, RS[1], MAT.plant);

      const b = a + Math.PI / 8;

      px(64 + 4.8 * Math.cos(b), 76 + 4.8 * Math.sin(b), PAL(["#12332f", "#1c4d3c", "#2b6f48", "#43914f"])[3], MAT.plant);
    }
  }

  /* ---- the door ---- */
  const doorCy = bean ? 90 : 92;
  const doorR = bean ? 15.5 : 9.2;
  const doorIn = bean ? 12.6 : 6.6;
  const doorX0 = bean ? 46 : 53;
  const doorX1 = bean ? 83 : 76;

  for (let y = bean ? 72 : 82; y < 110; y++) {
    for (let x = doorX0; x < doorX1; x++) {
      const dx = x + 0.5 - 64;
      const dy = y + 0.5 - doorCy;
      const d = y + 0.5 < doorCy ? Math.hypot(dx, dy) : Math.abs(dx);

      if (d > doorR) continue;
      if (d > doorIn) {
        const k = Math.floor((Math.atan2(dy, dx) + 7) * 3);
        let i = k & 1 ? 1 : 2;

        if (y + 0.5 >= doorCy) i = Math.floor(y / 3) & 1 ? 1 : 2;
        if (dx > 0) i++;
        px(x, y, ST[Math.min(5, i)], MAT.stone);
      } else {
        const pl = Math.floor((x - doorX0) / 3);
        let c = WD[pl & 1];

        if (Math.abs(dx) < 0.6) c = WD[3];
        if ((y >= 97 && y <= 98) || (y >= 103 && y <= 104)) c = WD[3];
        if (bean) {
          /* iron bands, studs and a great ring */
          if ((y >= 86 && y <= 87) || (y >= 100 && y <= 101)) c = [58, 58, 72];
          if (hash(x, y) > 0.985) c = [180, 180, 196];
        }
        if (y < doorCy && d > doorIn - 1.2) c = WD[2];
        px(x, y, c, MAT.door);
      }
    }
  }
  if (bean) {
    /* the ring knocker, and a bar of light under the door */
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2;

      px(58 + Math.cos(t) * 2.8, 96 + Math.sin(t) * 2.8, GOLD[a % 2], MAT.gold);
      px(70 + Math.cos(t) * 2.8, 96 + Math.sin(t) * 2.8, GOLD[a % 2], MAT.gold);
    }
    for (let x = 49; x < 79; x++) px(x, 109, AMB, MAT.glow);
  } else {
    /* the leaf on the right stands open: a warm room, and a bed in it */
    for (let y = 88; y < 109; y++) {
      for (let x = 65; x < 70; x++) px(x, y, DK, MAT.glow);
    }
    px(66, 104, hx("#fcf8fc"), MAT.stone);
    px(67, 104, hx("#fcf8fc"), MAT.stone);
    px(66, 103, hx("#fad65a"), MAT.stone);
    for (let x = 67; x < 70; x++) {
      px(x, 105, hx("#e8788f"), MAT.stone);
      px(x, 104, hx("#e8788f"), MAT.stone);
    }
    for (let x = 65; x < 70; x++) px(x, 106, hx("#76463a"), MAT.stone);
  }

  /* ---- arrow slits ---- */
  for (const sx of [44, 82]) {
    for (let y = 85; y < 96; y++) {
      for (let x = sx - 2; x < sx + 3; x++) {
        const inn = x >= sx - 1 && x < sx + 2 && y >= 87 && y < 95 && !(y === 87 && x !== sx);

        px(x, y, inn ? DK : ST[x > sx ? 2 : 1], inn ? MAT.glow : MAT.stone);
      }
    }
  }

  /* ---- the towers ---- */
  const tower = (cx: number) => {
    const rr = (y: number) => (y < 36 ? 13.5 : y < 53 ? 12 : y < 58 ? 13 : 11 + Math.max(0, y - 100) * 0.15);

    /* the scalloped cone roof */
    for (let y = 10; y < 33; y++) {
      const hw = y === 32 ? 14 : Math.max(1, ((y - 10) / 21) * 13.5);

      for (let x = Math.floor(cx - hw); x < Math.ceil(cx + hw); x++) {
        const d = x + 0.5 - cx;

        if (Math.abs(d) > hw) continue;

        const l = 0.93 - 0.62 * ((d / hw + 1) / 2);
        const row = Math.floor(y / 3);
        const my = y - row * 3;
        const col = Math.floor((x + (row & 1) * 2 + 100) / 4);
        let v = l + (hash(col, row + 50) - 0.5) * 0.14 + (my === 2 ? -0.12 : my === 0 ? 0.05 : 0);

        if (y === 32) v = 0.18;
        px(x, y, RF[clamp(Math.floor((1 - v) * 6), 0, 5)], MAT.roof);
      }
    }

    /* the round body, with a ledge and a ring of merlons */
    for (let y = 28; y < 113; y++) {
      const r = rr(y);

      for (let x = Math.floor(cx - r - 1); x < Math.ceil(cx + r + 1); x++) {
        const d = x + 0.5 - cx;

        if (Math.abs(d) > r) continue;

        const u = clamp(d / r, -1, 1);
        const s = r * Math.asin(u);

        if (y < 33 && (Math.floor(s) + 100) % 5 >= 3) continue;

        let l = 0.9 - 0.62 * ((u + 1) / 2);

        if (u > 0.8) l -= 0.12;
        if (y === 28 || y === 33) l += 0.14;
        if (y === 35) l -= 0.14;
        if (y >= 53 && y < 58) l += y === 53 ? 0.12 : y === 57 ? -0.2 : 0;
        if (y >= 58 && y < 62) l -= 0.12 * (1 - (y - 58) / 4);
        px(x, y, wall(x, y, l, s * (y >= 53 && y < 58 ? 0.5 : 1)), MAT.stone);
      }
    }

    /* three arrow windows under the roof */
    for (const u of [-0.74, 0, 0.74]) {
      const wx = cx + 12 * u;
      const ww = Math.max(2, Math.round(4 * Math.sqrt(1 - u * u)));
      const x0 = Math.round(wx - ww / 2);

      for (let y = 39; y < 50; y++) {
        for (let x = x0 - 1; x <= x0 + ww; x++) {
          const inn = x >= x0 && x < x0 + ww && y >= 41 && y < 49 && !(y === 41 && ww > 2 && (x === x0 || x === x0 + ww - 1));

          px(x, y, inn ? DK : ST[x > x0 + ww / 2 ? 2 : 1], inn ? MAT.glow : MAT.stone);
        }
      }
    }

    /* the gold finial: a cross on the sleeper's, an orb and spike on the giant's */
    if (bean) {
      for (let y = 1; y < 10; y++) {
        px(cx - 1, y, GOLD[0], MAT.gold);
        px(cx, y, GOLD[1], MAT.gold);
      }
      for (let y = 0; y < 4; y++) {
        for (let x = cx - 3; x < cx + 3; x++) {
          if ((x - cx + 0.5) ** 2 + (y - 1.5) ** 2 < 6) px(x, y + 1, x < cx ? GOLD[0] : GOLD[1], MAT.gold);
        }
      }
    } else {
      for (let y = 2; y < 10; y++) {
        px(cx - 1, y, GOLD[0], MAT.gold);
        px(cx, y, GOLD[1], MAT.gold);
      }
      for (let y = 4; y < 6; y++) for (let x = cx - 3; x < cx + 3; x++) px(x, y, x < cx ? GOLD[0] : GOLD[1], MAT.gold);
    }

    /* a few weeds in the crenels */
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * 3.14 - 1.57;
      const s = 13.5 * Math.sin(a);

      if (hash(i, cx) > 0.45) px(cx + s, 28, hash(i, cx + 1) > 0.5 ? [232, 208, 96] : [126, 168, 74], MAT.plant);
    }
  };

  tower(24);
  tower(104);

  /* ---- plants, the plinth, the steps ---- */
  const bush = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const e = dx * dx + dy * dy + (hash(x, y) - 0.5) * 0.4;

        if (e > 1) continue;

        const v = 0.5 - 0.38 * dy * 0.9 - 0.14 * dx + (hash(x * 3, y) - 0.5) * 0.4;

        px(x, y, GRN[clamp(Math.floor(v * 5), 0, 4)], MAT.plant);
      }
    }
  };
  const cyp = (cx: number, y0: number, y1: number, w: number) => {
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / (y1 - y0);
      const hw = w * (0.15 + 0.85 * Math.pow(t, 0.9));

      for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw); x++) {
        const d = x + 0.5 - cx;

        if (Math.abs(d) > hw + (hash(x, y) - 0.5) * 1.2) continue;

        const v = 0.5 - 0.25 * (d / hw) + (hash(x * 3, y * 5) - 0.5) * 0.5 + 0.15 * (1 - t);

        px(x, y, GRN[clamp(Math.floor(v * 5), 0, 4)], MAT.plant);
      }
    }
  };

  if (!bean) {
    cyp(46, 82, 107, 5);
    cyp(85, 80, 107, 5);
    cyp(78, 92, 107, 3.5);
  }
  for (let y = 109; y < 119; y++) {
    for (let x = 8; x < 121; x++) {
      let l = 0.62;

      if (y < 111) l = 0.92 - (y - 109) * 0.06;
      if (x < 11) l -= (0.16 * (11 - x)) / 3;
      if (x > 117) l -= (0.16 * (x - 117)) / 3;
      px(x, y, wall(x, y, l, x), MAT.stone);
    }
  }
  for (let y = 109; y < H; y++) {
    const t = (y - 109) / 18;
    const half = (bean ? 12 : 10) + t * 13;

    for (let x = Math.floor(64 - half); x < Math.ceil(64 + half); x++) {
      const d = x + 0.5 - 64;

      if (Math.abs(d) > half) continue;

      const rail = Math.abs(d) > half - 3.2;
      const c = rail
        ? wall(x, y, 0.72 - (d > 0 ? 0.14 : 0) + ((y - 109) % 2 ? -0.06 : 0), x)
        : (y - 109) % 2 === 0
          ? ST[Math.floor((y - 109) / 2) & 1 ? 0 : 1]
          : ST[3];

      px(x, y, c, MAT.stone);
    }
  }
  if (!bean) {
    for (const a of [[14, 118, 10, 7], [27, 121, 8, 6], [6, 123, 6, 5], [38, 123, 6, 4], [114, 118, 10, 7], [101, 121, 8, 6], [122, 123, 6, 5], [90, 123, 6, 4], [48, 107, 6, 4], [81, 107, 6, 4]]) {
      bush(a[0], a[1], a[2], a[3]);
    }
  } else {
    /* a spill of gold at the giant's doorstep */
    for (let i = 0; i < 26; i++) {
      const x = 46 + Math.floor(hash(i, 5) * 36);
      const y = 107 + Math.floor(hash(i, 6) * 4);

      px(x, y, hash(i, 7) > 0.5 ? GOLD[0] : GOLD[1], MAT.gold);
      if (hash(i, 8) > 0.6) px(x + 1, y, GOLD[1], MAT.gold);
    }
  }

  /* ---- what is close enough to the castle for leaves to cling ---- */
  const near = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!M[y * W + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const X = x + dx;
          const Y = y + dy;

          if (X >= 0 && Y >= 0 && X < W && Y < H) near[Y * W + X] = 1;
        }
      }
    }
  }
  const near1 = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!M[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;

          if (X >= 0 && Y >= 0 && X < W && Y < H) near1[Y * W + X] = 1;
        }
      }
    }
  }
  const m1 = (x: number, y: number) => {
    x = Math.floor(x);
    y = Math.floor(y);

    return x >= 0 && y >= 0 && x < W && y < H && near1[y * W + x] === 1;
  };

  /* ---- the vines ---- */
  const canes: Cane[] = [];
  const leaves: CastleLeaf[] = [];
  const blooms: CastleBloom[] = [];

  const spl = (p: number[][], n: number): number[][] => {
    const o: number[][] = [];
    const m = p.length - 1;

    for (let i = 0; i < m; i++) {
      const a = p[Math.max(i - 1, 0)];
      const b = p[i];
      const c = p[i + 1];
      const d = p[Math.min(i + 2, m)];

      for (let k = 0; k < n; k++) {
        const t = k / n;
        const t2 = t * t;
        const t3 = t2 * t;

        o.push([0, 1].map((j) => 0.5 * (2 * b[j] + (-a[j] + c[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * t3)));
      }
    }
    o.push(p[m]);

    return o;
  };
  const wob = (pts: number[][], A: number, f: number, ph = 0): number[][] =>
    pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const s = A * Math.sin(i * f + ph) * Math.min(1, i / 6);

      return [p[0] - (dy / l) * s, p[1] + (dx / l) * s, p[2]];
    });
  const mk = (pts: number[][], o: { t0: number; dur: number; w0: number; w1: number; kind?: number; sky?: boolean }): Cane => {
    const n = pts.length;
    const c: Cane = { pts: [], th: [], kind: o.kind ?? 6, sky: !!o.sky };

    for (let i = 0; i < n; i++) {
      const u = i / Math.max(1, n - 1);

      c.pts.push({
        x: pts[i][0],
        y: pts[i][1],
        v: pts[i][2] !== 0,
        tb: Math.min(0.97, o.t0 + o.dur * Math.pow(u, 0.92)),
        w: lerp(o.w0, o.w1, u),
        u,
        nx: 0,
        ny: 1,
      });
    }
    for (let i = 0; i < n; i++) {
      const a = c.pts[Math.max(0, i - 1)];
      const b = c.pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;

      dx /= l;
      dy /= l;

      let nx = -dy;
      let ny = dx;

      if (nx < 0 || (nx === 0 && ny < 0)) {
        nx = -nx;
        ny = -ny;
      }

      const p = c.pts[i];

      p.nx = nx;
      p.ny = ny;
      /* thorns: the sleeper's briars have them, the beanstalk's tendrils do not */
      if (!bean && p.v && i % 3 === 1 && hash(i * 7, n) > 0.12) {
        const sd = (i / 3 | 0) & 1 ? 1 : -1;
        const off = p.w / 2 + 0.9;

        c.th.push({ x: p.x + nx * off * sd, y: p.y + ny * off * sd, tb: p.tb });
      }
    }
    canes.push(c);

    return c;
  };
  const walk = (x: number, y: number, hd: number, len: number, wb: number, mask?: (x: number, y: number) => boolean, tx?: number): number[][] => {
    const pts: number[][] = [];
    const ph = R() * 6.28;

    for (let i = 0; i < len; i++) {
      hd += (R() - 0.5) * wb + Math.sin(i * 0.28 + ph) * wb * 0.45;
      if (tx !== undefined) hd += clamp((tx - x) * 0.006, -0.05, 0.05);

      let nx = x + Math.cos(hd);
      let ny = y + Math.sin(hd);

      if (mask && !mask(nx, ny)) {
        let ok = false;

        for (const d of [0.5, -0.5, 1, -1, 1.6, -1.6, 2.4]) {
          const hh = hd + d;
          const mx = x + Math.cos(hh);
          const my = y + Math.sin(hh);

          if (mask(mx, my)) {
            hd = hh;
            nx = mx;
            ny = my;
            ok = true;
            break;
          }
        }
        if (!ok) break;
      }
      x = nx;
      y = ny;
      pts.push([x, y]);
    }

    return pts;
  };
  const curl = (x: number, y: number, hd: number, turn: number, len: number): number[][] => {
    const pts: number[][] = [];

    for (let i = 0; i < len; i++) {
      hd += turn * (0.25 + (i / len) * 1.8);
      x += Math.cos(hd) * 0.9;
      y += Math.sin(hd) * 0.9;
      pts.push([x, y]);
    }

    return pts;
  };
  const shoots = (c: Cane, step: number, l0: number, l1: number, tdur: number, kindOf?: number) => {
    for (let j = 5; j < c.pts.length - 4; j += step + ((R() * step * 0.6) | 0)) {
      const p = c.pts[j];

      if (!p.v) continue;

      const hd = -Math.PI / 2 + (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.9);
      const sp = walk(p.x, p.y, hd, l0 + R() * (l1 - l0), 0.6, m1);

      if (sp.length < 3) continue;
      mk([[p.x, p.y], ...sp], { t0: p.tb, dur: tdur * (0.7 + R() * 0.6), w0: 1.3, w1: 0.8, kind: kindOf ?? 6 });
    }
  };

  /* ground brambles */
  for (const [x, y] of [[9, 117], [21, 120], [34, 121], [44, 123], [84, 123], [94, 121], [107, 120], [119, 117], [58, 121], [70, 121]]) {
    const nC = 1 + ((R() * 2) | 0);

    for (let i = 0; i < nC; i++) {
      const hd = -Math.PI / 2 + (R() - 0.5) * 2.4;
      const sp = walk(x, y, hd, 10 + R() * 14, 0.5, m1);

      mk([[x, y], ...sp], { t0: 0.03 + R() * 0.12, dur: 0.1 + 0.08 * R(), w0: 2.2, w1: 1, kind: 2 });
    }
  }
  /* canes up the keep */
  const keepC: Cane[] = [];

  for (const x0 of [37, 42, 47, 81, 86, 91]) {
    const sp = walk(x0, 112, -Math.PI / 2 + (R() - 0.5) * 0.3, 66, 0.34, m1, x0);
    const c = mk([[x0, 114], ...sp], { t0: 0.08 + R() * 0.12, dur: 0.34 + R() * 0.1, w0: 2.4, w1: 1, kind: 3 });

    keepC.push(c);
    shoots(c, 9, 8, 18, 0.08);
  }
  keepC.forEach((c, i) => {
    if (i % 2 === 0) {
      const t = c.pts[c.pts.length - 1];

      mk([[t.x, t.y], ...curl(t.x, t.y, -Math.PI / 2 + (R() - 0.5), (R() < 0.5 ? -1 : 1) * 0.26, 18)], { t0: t.tb, dur: 0.1, w0: 1.1, w1: 0.7, kind: 7, sky: true });
    }
  });
  /* helices round the towers */
  const rf = (y: number) => (y < 10 ? 0.4 : y < 32 ? (13.5 * (y - 10)) / 21 + 0.4 : y < 36 ? 13.9 : y < 53 ? 12.4 : y < 58 ? 13.4 : 11.4 + Math.max(0, y - 100) * 0.15);
  const helix = (cx: number, phi0: number, om: number, t0: number, dur: number, w0: number, w1: number) => {
    const pts: number[][] = [];

    for (let y = 116; y >= 11; y -= 0.55) {
      const ph = phi0 + om * (116 - y);

      pts.push([cx + rf(y) * Math.sin(ph), y, Math.cos(ph) > 0.1 ? 1 : 0]);
    }

    return mk(pts, { t0, dur, w0, w1, kind: 1 });
  };

  for (const [cx, ph, om, dt] of [[24, [0.3, 2.5, 4.6], [0.135, -0.12, 0.145], 0], [104, [1.4, 3.6, 5.4], [-0.135, 0.12, -0.145], 0.015]] as [number, number[], number[], number][]) {
    for (let i = 0; i < 3; i++) {
      const c = helix(cx, ph[i], om[i], 0.07 + i * 0.05 + dt, 0.5 - i * 0.04, 2.8 - i * 0.3, 1.1);

      shoots(c, 9, 6, 12, 0.06);
    }
  }
  /* feeders to the window and the door, a wreath round the window */
  const feeders = bean
    ? [[[40, 110], [42, 100], [44, 90], [46, 80], [50, 70]], [[88, 110], [86, 100], [84, 90], [82, 80], [78, 70]]]
    : [[[44, 110], [46, 100], [49, 90], [52, 82], [53.5, 77]], [[84, 110], [82, 100], [79, 90], [76, 82], [74.5, 77]]];

  for (const p of feeders) mk(wob(spl(p, 9), 1.2, 0.5), { t0: 0.3, dur: 0.22, w0: 2, w1: 1.2, kind: 4 });
  {
    const ring: number[][] = [];

    for (let a = Math.PI; a < Math.PI + 6.6; a += 0.07) ring.push([64 + (winR + 1.1) * Math.cos(a), winCy + (winR + 1.1) * Math.sin(a)]);
    mk(ring, { t0: 0.5, dur: 0.14, w0: 1.6, w1: 1.6, kind: 4 });
  }
  const doorTangle = bean
    ? [[[44, 108], [44, 96], [48, 84], [56, 74], [64, 70]], [[84, 108], [84, 96], [80, 84], [72, 74], [64, 70]]]
    : [[[56, 107], [58, 100], [62, 97], [66, 92], [71, 88]], [[72, 107], [69, 102], [64, 100], [60, 95], [57, 90]], [[56, 92], [61, 89], [67, 87], [72, 91]]];

  doorTangle.forEach((p, i) => mk(wob(spl(p, 9), 0.9, 0.7, i), { t0: 0.62 + i * 0.04, dur: 0.14, w0: 1.5, w1: 1.2, kind: 4 }));
  /* the arch of vines between the towers */
  const arch = [[[35, 44], [38, 35], [45, 27], [55, 22], [64, 20.5]], [[93, 44], [90, 35], [83, 27], [73, 22], [64, 20.5]]];

  arch.forEach((p, i) => {
    const c = mk(wob(spl(p, 9), 1.1, 0.6, i * 2), { t0: 0.56 + i * 0.04, dur: 0.2, w0: 1.7, w1: 1.3, kind: 5, sky: true });

    for (let j = 8; j < c.pts.length - 4; j += 9) {
      const q = c.pts[j];
      const sp = walk(q.x, q.y, Math.PI / 2 + (R() - 0.5) * 0.9, 6 + R() * 7, 0.5);

      if (sp.length < 3) continue;

      const e = sp[sp.length - 1];

      mk([[q.x, q.y], ...sp, ...curl(e[0], e[1], Math.PI / 2, (R() < 0.5 ? -1 : 1) * 0.3, 10)], { t0: q.tb, dur: 0.06, w0: 1.2, w1: 0.7, kind: 5, sky: true });
    }
  });

  /* leaves and blooms along every cane */
  const LP: Record<number, number[]> = {
    1: [3.2, 4.4, 0.95, 1.5, 0.03, 0.25],
    2: [3.4, 4.4, 1, 1.6, 0.03, 0.22],
    3: [2.8, 4, 0.95, 1.5, 0.03, 0.25],
    4: [2, 3, 0.9, 1.3, 0.05, 0.22],
    5: [1.5, 2.6, 0.9, 1.3, 0.05, 0.2],
    6: [2, 3, 0.9, 1.4, 0.04, 0.22],
    7: [0.8, 1.6, 0.8, 1.1, 0.04, 0.1],
  };
  const RP: Record<number, number> = { 1: 0.05, 2: 0.07, 3: 0.04, 4: 0.09, 5: 0.09, 6: 0.03, 7: 0 };

  for (const c of canes) {
    const [per, off, s0, s1, d0, d1] = LP[c.kind];

    for (const p of c.pts) {
      if (!p.v) continue;

      const pp = per * (c.kind === 1 && p.y < 32 ? 0.5 : 1);
      const n = Math.floor(pp + R());

      for (let k = 0; k < n; k++) {
        const a = R() * 6.283;
        const q = Math.pow(R(), 0.75);
        const o = q * off;

        leaves.push({
          x: p.x + Math.cos(a) * o,
          y: p.y + Math.sin(a) * o * 0.9,
          tb: Math.min(0.985, p.tb + lerp(d0, d1, R()) + q * 0.08),
          s: lerp(s0, s1, R()),
          a: R() * 3.14,
          t: R(),
          fg: R() < 0.25,
          sky: c.sky,
        });
      }
    }

    const n = c.pts.length;

    c.pts.forEach((p, i) => {
      if (!p.v || p.u < 0.15) return;
      if (R() < RP[c.kind] * (bean ? 0.45 : 1) || (c.kind === 6 && i === n - 1 && R() < 0.6)) {
        const a = R() * 6.28;
        const o = R() * 2;
        const big = c.kind === 2;

        blooms.push({
          x: p.x + Math.cos(a) * o,
          y: p.y + Math.sin(a) * o,
          tb: Math.min(0.97, p.tb + 0.1 + R() * 0.2),
          r: big ? lerp(2, 2.8, R()) : lerp(1.5, 2.3, R()),
          ph: R(),
          sky: c.sky,
        });
      }
    });
  }
  for (const cx of [24, 104]) blooms.push({ x: cx - 0.5, y: 12, tb: 0.82, r: 2.7, ph: 0.2, sky: true });
  leaves.sort((a, b) => a.tb - b.tb);
  blooms.sort((a, b) => a.tb - b.tb);

  return {
    kind,
    C,
    M,
    glass: Int32Array.from(WIN),
    near,
    canes,
    leaves,
    blooms,
    door: bean ? { x: 46, y: 72, w: 37, h: 37 } : { x: 53, y: 82, w: 23, h: 27 },
    palette: bean
      ? {
          cane: PAL(["#1d4a24", "#2f7a34", "#4aa648", "#7cd060"]),
          tip: PAL(["#d6f5a0", "#a6e070"]),
          thorn: hx("#d6f5a0"),
          leaf: PAL(["#0f3a22", "#1a6a34", "#2e9a46", "#52c058", "#8be07c", "#c6f59a"]),
          bloom: PAL(["#fff2a8", "#ffd860", "#e8b03a", "#c78820", "#9a6212", "#6e420a"]),
          glow: AMB,
          dark: DK,
        }
      : {
          cane: PAL(["#3a1c2e", "#57293f", "#78394f", "#97506a"]),
          tip: PAL(["#b9ea7a", "#7fc65a"]),
          thorn: hx("#ead9a8"),
          leaf: PAL(["#12332f", "#1c4d3c", "#2b6f48", "#43914f", "#6cb85f", "#a2dc78"]),
          bloom: PAL(["#6e1442", "#a82260", "#d93a80", "#f55e9c", "#ff8fba", "#ffc4dc"]),
          glow: AMB,
          dark: DK,
        },
  };
}

/* ------------------------------------------------------------ */
/* drawing                                                       */
/* ------------------------------------------------------------ */

export interface CastlePainter {
  /** Paint a pixel with alpha (already clipped by the caller's canvas). */
  paint: (x: number, y: number, c: Rgb, a: number) => void;
  /** The pixels of a leaf of the given design (heart leaflets for the beanstalk). */
  leafPixels?: (r: number, ph: number, tone: number) => { dx: number[]; dy: number[]; shade: number[] };
}

/**
 * Draw the castle with its top-left corner at (ox, oy). `alpha` fades the
 * whole thing in, `g` (0..1) is how far the vines have grown, `tm` drives
 * the window glow. Leaves are drawn behind the canes and then, for a
 * quarter of them, in front.
 */
export function drawCastle(c: Castle, p: CastlePainter, ox: number, oy: number, alpha: number, g: number, tm: number) {
  const W = CASTLE_W;
  const H = CASTLE_H;
  const { C, M, palette: pal } = c;
  const bean = c.kind === "bean";
  const glow = clamp(0.7 + 0.3 * Math.sin(tm * 0.7), 0, 1);
  /* nothing is painted outside the sprite's own frame */
  const paint = (x: number, y: number, col: Rgb, a: number) => {
    if (x < ox || y < oy || x >= ox + W || y >= oy + H) return;
    p.paint(x, y, col, a);
  };

  for (let k = 0; k < W * H; k++) {
    const m = M[k];

    if (m === MAT.none) continue;

    const x = k % W;
    const y = (k / W) | 0;

    if (m === MAT.glow) {
      const f = glow * (0.8 + 0.2 * Math.sin(tm * 2.2 + k * 0.37));

      paint(ox + x, oy + y, [lerp(DK[0], AMB[0], f), lerp(DK[1], AMB[1], f), lerp(DK[2], AMB[2], f)], alpha);
    } else {
      paint(ox + x, oy + y, [C[k * 3], C[k * 3 + 1], C[k * 3 + 2]], alpha);
    }
  }

  const leaf = (L: CastleLeaf) => {
    const s = L.s * (0.35 + 0.65 * clamp((g - L.tb) / 0.05, 0, 1));

    if (bean && p.leafPixels) {
      const px = p.leafPixels(Math.max(1.5, s * 1.9), L.a * 2, 0.55 + L.t * 0.3);
      const bx = Math.floor(L.x);
      const by = Math.floor(L.y);

      for (let i = 0; i < px.dx.length; i++) {
        const X = bx + px.dx[i];
        const Y = by + px.dy[i];

        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        if (!L.sky && !c.near[Y * W + X]) continue;
        paint(ox + X, oy + Y, pal.leaf[clamp(px.shade[i] + 1, 0, 5)], alpha);
      }

      return;
    }

    const ca = Math.cos(L.a);
    const sa = Math.sin(L.a);
    const A = 1.7 * s;
    const B = 0.95 * s;
    const ex = Math.ceil(A);
    const bx = Math.floor(L.x);
    const by = Math.floor(L.y);

    for (let dy = -ex; dy <= ex; dy++) {
      for (let dx = -ex; dx <= ex; dx++) {
        const u = (dx * ca + dy * sa) / A;
        const v = (-dx * sa + dy * ca) / B;

        if (u * u + v * v > 1) continue;

        const X = bx + dx;
        const Y = by + dy;

        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        if (!L.sky && !c.near[Y * W + X]) continue;

        let ti = 1 + Math.floor(L.t * 4);
        const lit = (-dx * 0.5 - dy * 0.9) / (ex + 0.1);

        if (lit > 0.35) ti++;
        else if (lit < -0.35) ti--;
        paint(ox + X, oy + Y, pal.leaf[clamp(ti, 0, 5)], alpha);
      }
    }
  };

  for (const L of c.leaves) {
    if (L.tb > g) break;
    if (!L.fg) leaf(L);
  }

  /* the canes, with a bright growing tip and thorns */
  for (const cane of c.canes) {
    const ps = cane.pts;
    const n = ps.length;

    if (ps[0].tb > g) continue;

    let lo = 0;
    let hi = n - 1;

    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;

      if (ps[m].tb <= g) lo = m;
      else hi = m - 1;
    }
    for (let i = 0; i <= lo; i++) {
      const q = ps[i];

      if (!q.v) continue;

      const tip = lo < n - 1 && lo - i < 4;

      paint(ox + Math.floor(q.x), oy + Math.floor(q.y), tip ? pal.tip[lo - i > 1 ? 1 : 0] : pal.cane[1 + ((i >> 1) & 1) + (q.u > 0.5 ? 1 : 0)], alpha);
      if (q.w > 1.5) paint(ox + Math.floor(q.x + q.nx), oy + Math.floor(q.y + q.ny), pal.cane[0], alpha);
      if (q.w > 2.3) paint(ox + Math.floor(q.x - q.nx), oy + Math.floor(q.y - q.ny), pal.cane[3], alpha);
    }
    for (const t of cane.th) if (t.tb <= g) paint(ox + Math.floor(t.x), oy + Math.floor(t.y), pal.thorn, alpha);
  }

  for (const L of c.leaves) {
    if (L.tb > g) break;
    if (L.fg) leaf(L);
  }

  /* roses on the sleeper's briars; golden beans and sparks on the beanstalk */
  for (const b of c.blooms) {
    if (b.tb > g) break;

    const open = clamp((g - b.tb) / 0.07, 0, 1);
    const X = Math.floor(b.x);
    const Y = Math.floor(b.y);

    if (bean) {
      const a = alpha * open;
      const tw = 0.7 + 0.3 * Math.sin(tm * 3 + b.ph * 9);

      paint(ox + X, oy + Y, pal.bloom[1], a);
      paint(ox + X + 1, oy + Y, pal.bloom[2], a);
      paint(ox + X, oy + Y - 1, pal.bloom[0], a * tw);
      paint(ox + X - 1, oy + Y, pal.bloom[2], a * 0.8);
      paint(ox + X, oy + Y + 1, pal.bloom[3], a * 0.8);

      continue;
    }
    if (open < 0.4) {
      paint(ox + X, oy + Y, pal.bloom[1], alpha);
      paint(ox + X, oy + Y - 1, pal.bloom[3], alpha);
      paint(ox + X, oy + Y + 1, pal.leaf[3], alpha);

      continue;
    }

    const r = 1 + (b.r - 1) * ((open - 0.4) / 0.6);

    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy);

        if (d > r + 0.2) continue;

        let col: Rgb;

        if (d < 0.6) col = pal.bloom[0];
        else {
          const q = (Math.atan2(dy, dx) / 6.283 + 1 + b.ph + d * 0.28) % 1;

          col = q < 0.34 ? pal.bloom[2] : q < 0.67 ? pal.bloom[3] : pal.bloom[1];
          if (d > r - 0.6 && dx >= 0 && dy >= 0) col = pal.bloom[1];
          if (dx === -1 && dy === -1 && r > 1.9) col = pal.bloom[5];
        }
        paint(ox + X + dx, oy + Y + dy, col, alpha);
      }
    }
  }
}

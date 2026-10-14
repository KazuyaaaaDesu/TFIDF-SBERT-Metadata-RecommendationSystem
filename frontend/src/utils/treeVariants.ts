/**
 * Tree color variants: painted skins for each species.
 *
 * A variant recolors the same pixel art: its foliage is turned in hue,
 * saturation and lightness, and its bark and moss are washed with a tint.
 * Nothing about the shape changes. Each species has its original colors
 * plus three more palettes.
 *
 * Pure and dependency-free (no browser APIs outside the storage helpers,
 * which are guarded), so it runs under `node --test`.
 */

export type VariantSpeciesId =
  | "crimson"
  | "oak"
  | "birch"
  | "elm"
  | "redwood"
  | "beanstalk"
  | "rosevine";

export interface TreeVariant {
  id: string;
  label: string;
  /** Foliage: hue turn in degrees, saturation multiplier, lightness shift. */
  foliage: { hue: number; sat: number; light: number };
  /** Bark and moss are washed toward this color by `amount` (0..1). */
  wash: { rgb: [number, number, number]; amount: number };
}

export const ORIGINAL_VARIANT: TreeVariant = {
  id: "original",
  label: "Original",
  foliage: { hue: 0, sat: 1, light: 0 },
  wash: { rgb: [0, 0, 0], amount: 0 },
};

export const TREE_VARIANTS: Record<VariantSpeciesId, TreeVariant[]> = {
  crimson: [
    ORIGINAL_VARIANT,
    { id: "golden-hour", label: "Golden Hour", foliage: { hue: 20, sat: 0.9, light: 0.03 }, wash: { rgb: [150, 110, 50], amount: 0.1 } },
    { id: "spring-green", label: "Spring Green", foliage: { hue: 98, sat: 0.68, light: -0.05 }, wash: { rgb: [90, 120, 60], amount: 0.1 } },
    { id: "plum-dusk", label: "Plum Dusk", foliage: { hue: -78, sat: 0.62, light: -0.05 }, wash: { rgb: [120, 90, 140], amount: 0.16 } },
  ],
  oak: [
    ORIGINAL_VARIANT,
    { id: "autumn-russet", label: "Autumn Russet", foliage: { hue: -82, sat: 1.05, light: -0.02 }, wash: { rgb: [130, 80, 50], amount: 0.12 } },
    { id: "frosted-blue", label: "Frosted Blue", foliage: { hue: 96, sat: 0.8, light: 0.04 }, wash: { rgb: [90, 110, 140], amount: 0.14 } },
    { id: "cherry-blossom", label: "Cherry Blossom", foliage: { hue: -128, sat: 0.8, light: 0.14 }, wash: { rgb: [150, 100, 110], amount: 0.12 } },
  ],
  birch: [
    ORIGINAL_VARIANT,
    { id: "spring-green", label: "Spring Green", foliage: { hue: 62, sat: 0.74, light: -0.05 }, wash: { rgb: [210, 245, 210], amount: 0.14 } },
    { id: "rose-gold", label: "Rose Gold", foliage: { hue: -40, sat: 0.9, light: 0.04 }, wash: { rgb: [255, 214, 222], amount: 0.2 } },
    { id: "moonlit-blue", label: "Moonlit Blue", foliage: { hue: 168, sat: 0.7, light: -0.03 }, wash: { rgb: [205, 222, 255], amount: 0.22 } },
  ],
  elm: [
    ORIGINAL_VARIANT,
    { id: "emerald-shade", label: "Emerald Shade", foliage: { hue: 78, sat: 0.7, light: -0.08 }, wash: { rgb: [70, 90, 55], amount: 0.1 } },
    { id: "copper-red", label: "Copper Red", foliage: { hue: -30, sat: 0.92, light: -0.05 }, wash: { rgb: [125, 72, 42], amount: 0.14 } },
    { id: "wisteria", label: "Wisteria", foliage: { hue: 228, sat: 0.7, light: 0.06 }, wash: { rgb: [95, 75, 115], amount: 0.14 } },
  ],
  redwood: [
    ORIGINAL_VARIANT,
    { id: "autumn-rust", label: "Autumn Rust", foliage: { hue: -135, sat: 0.85, light: -0.01 }, wash: { rgb: [140, 70, 40], amount: 0.12 } },
    { id: "blue-spruce", label: "Blue Spruce", foliage: { hue: 46, sat: 0.85, light: 0.0 }, wash: { rgb: [60, 80, 100], amount: 0.14 } },
    { id: "golden-dawn", label: "Golden Dawn", foliage: { hue: -100, sat: 0.95, light: 0.07 }, wash: { rgb: [140, 110, 50], amount: 0.12 } },
  ],
  beanstalk: [
    ORIGINAL_VARIANT,
    { id: "golden-harvest", label: "Golden Harvest", foliage: { hue: -58, sat: 0.95, light: 0.02 }, wash: { rgb: [150, 120, 50], amount: 0.14 } },
    { id: "moonvine", label: "Moonvine", foliage: { hue: 96, sat: 0.7, light: 0.06 }, wash: { rgb: [90, 120, 150], amount: 0.16 } },
    { id: "magic-bean", label: "Magic Bean", foliage: { hue: 168, sat: 0.8, light: 0.02 }, wash: { rgb: [130, 90, 160], amount: 0.16 } },
  ],
  rosevine: [
    ORIGINAL_VARIANT,
    { id: "blue-rose", label: "Blue Rose", foliage: { hue: -118, sat: 0.9, light: 0.0 }, wash: { rgb: [70, 90, 150], amount: 0.16 } },
    { id: "white-rose", label: "White Rose", foliage: { hue: 20, sat: 0.28, light: 0.16 }, wash: { rgb: [200, 195, 205], amount: 0.2 } },
    { id: "golden-rose", label: "Golden Rose", foliage: { hue: 76, sat: 0.95, light: 0.03 }, wash: { rgb: [150, 110, 50], amount: 0.14 } },
  ],
};

export function variantsFor(species: string): TreeVariant[] {
  return TREE_VARIANTS[species as VariantSpeciesId] ?? [ORIGINAL_VARIANT];
}

/** The variant with this id for the species, or the original. */
export function resolveVariant(species: string, id: string | null | undefined): TreeVariant {
  return variantsFor(species).find((variant) => variant.id === id) ?? ORIGINAL_VARIANT;
}

/* ------------------------------------------------------------ */
/* Color maths                                                  */
/* ------------------------------------------------------------ */

type Rgb = number[];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l];

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;

  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;

  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): number[] {
  const hue = (((h % 360) + 360) % 360) / 360;

  if (s === 0) {
    const v = Math.round(l * 255);

    return [v, v, v];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    let t = t0;

    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;

    return p;
  };

  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((v) =>
    Math.round(clamp01(v) * 255),
  );
}

/** Turn a foliage color: hue rotated, saturation scaled, lightness shifted. */
export function tintFoliage(variant: TreeVariant, color: Rgb): number[] {
  const { hue, sat, light } = variant.foliage;

  if (hue === 0 && sat === 1 && light === 0) return color.slice();

  const [h, s, l] = rgbToHsl(color);

  return hslToRgb(h + hue, clamp01(s * sat), clamp01(l + light));
}

/** Wash a bark or moss color toward the variant's tint, keeping its value. */
export function tintBark(variant: TreeVariant, color: Rgb): number[] {
  const { rgb, amount } = variant.wash;

  if (amount <= 0) return color.slice();

  /* Keep the color's own lightness so the bark's shading survives. */
  const [, , l0] = rgbToHsl(color);
  const mixed = [0, 1, 2].map((i) => color[i] + (rgb[i] - color[i]) * amount);
  const [h, s] = rgbToHsl(mixed);

  return hslToRgb(h, s, l0);
}

/* ------------------------------------------------------------ */
/* Swatches for the picker                                       */
/* ------------------------------------------------------------ */

/** Three foliage tones and the bark of each species' original art. */
const SWATCH_BASE: Record<VariantSpeciesId, { leaf: string[]; bark: string }> = {
  crimson: { leaf: ["#c42a1c", "#e8472a", "#ff7a4d"], bark: "#524a45" },
  oak: { leaf: ["#2f7a2e", "#4fa83e", "#8fd45c"], bark: "#4a3a2a" },
  birch: { leaf: ["#d9a21b", "#f2c53a", "#ffe16b"], bark: "#c8c4bc" },
  elm: { leaf: ["#e0a028", "#f5c042", "#ffe070"], bark: "#4d453d" },
  redwood: { leaf: ["#276e3c", "#44985a", "#80c88a"], bark: "#6e3620" },
  beanstalk: { leaf: ["#2f8a2a", "#5cc23a", "#b6f06a"], bark: "#4a7a26" },
  rosevine: { leaf: ["#b3173f", "#e8366f", "#ff8fb4"], bark: "#4a2236" },
};

const hexRgb = (hex: string): number[] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Four CSS colors that show a variant at a glance: three leaves and bark. */
export function variantSwatch(species: string, variant: TreeVariant): string[] {
  const base = SWATCH_BASE[species as VariantSpeciesId] ?? SWATCH_BASE.crimson;
  const css = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

  return [
    ...base.leaf.map((hex) => css(tintFoliage(variant, hexRgb(hex)))),
    css(tintBark(variant, hexRgb(base.bark))),
  ];
}

/* ------------------------------------------------------------ */
/* The choice, remembered per species                            */
/* ------------------------------------------------------------ */

export const VARIANT_KEY = "paperrec_tree_variants";

export function readVariantChoices(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(VARIANT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeVariantChoice(species: string, id: string): void {
  try {
    window.localStorage.setItem(
      VARIANT_KEY,
      JSON.stringify({ ...readVariantChoices(), [species]: id }),
    );
  } catch {
    /* private mode: the choice just doesn't persist */
  }
}

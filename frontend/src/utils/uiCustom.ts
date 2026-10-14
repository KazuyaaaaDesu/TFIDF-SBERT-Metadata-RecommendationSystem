/**
 * Customizations of the whole UI: looks (skins), effects, and the live
 * background. They are the hidden cheats' rewards and the developer panel's
 * switches.
 *
 * A skin replaces the theme's color tokens (canvas, surface, ink, accent,
 * the gray ramp ...) while it is on, and sets `data-skin` on the document so
 * the style sheet can add its own touches (fonts, grain, grids). Effects are
 * plain data attributes. Nothing here changes layout or content.
 *
 * The apply step only touches the document; the theme provider re-applies
 * the theme first and then this, so turning a skin off restores the theme
 * exactly.
 */

export type SkinId =
  | "gameboy"
  | "wood"
  | "terminal"
  | "blueprint"
  | "synthwave"
  | "parchment";

export interface UiSkin {
  id: SkinId;
  label: string;
  mode: "light" | "dark";
  /** Space-separated RGB triplets, as the theme tokens are. */
  canvas: string;
  surface: string;
  surfaceAlt: string;
  hairline: string;
  ink: string;
  muted: string;
  field: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
}

const t = (s: string) => s.split(" ").map(Number);
const mix = (a: number[], b: number[], k: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(" ");

export const SKINS: UiSkin[] = [
  {
    id: "gameboy",
    label: "Pocket Green",
    mode: "light",
    canvas: "155 188 15",
    surface: "139 172 15",
    surfaceAlt: "125 158 14",
    hairline: "48 98 48",
    ink: "15 56 15",
    muted: "15 56 15",
    field: "155 188 15",
    accent: "15 56 15",
    accentSoft: "139 172 15",
    onAccent: "155 188 15",
  },
  {
    id: "wood",
    label: "Lumberyard",
    mode: "light",
    canvas: "217 185 131",
    surface: "236 214 168",
    surfaceAlt: "226 198 146",
    hairline: "150 110 60",
    ink: "43 26 10",
    muted: "90 58 26",
    field: "240 224 190",
    accent: "140 80 20",
    accentSoft: "240 224 190",
    onAccent: "255 244 220",
  },
  {
    id: "terminal",
    label: "Phosphor",
    mode: "dark",
    canvas: "6 14 8",
    surface: "10 24 12",
    surfaceAlt: "14 34 18",
    hairline: "30 90 45",
    ink: "120 255 140",
    muted: "80 200 100",
    field: "8 20 10",
    accent: "60 255 100",
    accentSoft: "16 48 24",
    onAccent: "0 20 5",
  },
  {
    id: "blueprint",
    label: "Blueprint",
    mode: "dark",
    canvas: "14 48 88",
    surface: "18 62 112",
    surfaceAlt: "22 74 130",
    hairline: "90 150 210",
    ink: "220 238 255",
    muted: "160 200 235",
    field: "16 56 104",
    accent: "120 200 255",
    accentSoft: "28 84 148",
    onAccent: "6 30 60",
  },
  {
    id: "synthwave",
    label: "Neon Horizon",
    mode: "dark",
    canvas: "24 8 48",
    surface: "40 14 72",
    surfaceAlt: "56 20 96",
    hairline: "140 60 200",
    ink: "255 220 250",
    muted: "210 160 235",
    field: "32 10 60",
    accent: "255 60 180",
    accentSoft: "70 24 120",
    onAccent: "20 4 40",
  },
  {
    id: "parchment",
    label: "Old Parchment",
    mode: "light",
    canvas: "238 226 196",
    surface: "247 238 214",
    surfaceAlt: "232 216 178",
    hairline: "170 140 90",
    ink: "62 44 24",
    muted: "104 80 50",
    field: "250 244 226",
    accent: "140 60 30",
    accentSoft: "226 208 166",
    onAccent: "250 240 220",
  },
];

export interface LiveBackground {
  on: boolean;
  /** A garden scene id, or "garden" to follow the garden's own scene. */
  scene: string;
  /** How much the page color covers the scene, 0.6..0.95. */
  dim: number;
  /** Still picture instead of moving. */
  still: boolean;
}

/** A typeface the developer panel can try. `google` is the css2 family query (no weights when the face has one). */
export interface FontChoice {
  id: string;
  label: string;
  stack: string;
  google?: string;
}

export const FONT_CHOICES: FontChoice[] = [
  { id: "inter", label: "Inter", stack: '"Inter", system-ui, sans-serif', google: "Inter:wght@400;500;600;700;800" },
  { id: "pixelify", label: "Pixelify Sans", stack: '"Pixelify Sans", "Inter", system-ui, sans-serif', google: "Pixelify+Sans:wght@400;500;600;700" },
  { id: "plex-sans", label: "IBM Plex Sans", stack: '"IBM Plex Sans", system-ui, sans-serif', google: "IBM+Plex+Sans:wght@400;500;600;700" },
  { id: "plex-serif", label: "IBM Plex Serif", stack: '"IBM Plex Serif", Georgia, serif', google: "IBM+Plex+Serif:wght@400;500;600;700" },
  { id: "dm-sans", label: "DM Sans", stack: '"DM Sans", system-ui, sans-serif', google: "DM+Sans:wght@400;500;600;700" },
  { id: "space-grotesk", label: "Space Grotesk", stack: '"Space Grotesk", system-ui, sans-serif', google: "Space+Grotesk:wght@400;500;600;700" },
  { id: "atkinson", label: "Atkinson Hyperlegible", stack: '"Atkinson Hyperlegible", system-ui, sans-serif', google: "Atkinson+Hyperlegible:wght@400;700" },
  { id: "lora", label: "Lora", stack: '"Lora", Georgia, serif', google: "Lora:wght@400;500;600;700" },
  { id: "merriweather", label: "Merriweather", stack: '"Merriweather", Georgia, serif', google: "Merriweather:wght@400;700" },
  { id: "source-serif", label: "Source Serif 4", stack: '"Source Serif 4", Georgia, serif', google: "Source+Serif+4:wght@400;600;700" },
  { id: "playfair", label: "Playfair Display", stack: '"Playfair Display", Georgia, serif', google: "Playfair+Display:wght@400;600;700" },
  { id: "roboto-slab", label: "Roboto Slab", stack: '"Roboto Slab", Georgia, serif', google: "Roboto+Slab:wght@400;500;700" },
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, monospace', google: "JetBrains+Mono:wght@400;500;700" },
  { id: "fira-code", label: "Fira Code", stack: '"Fira Code", ui-monospace, monospace', google: "Fira+Code:wght@400;500;700" },
  { id: "press-start", label: "Press Start 2P", stack: '"Press Start 2P", monospace', google: "Press+Start+2P" },
  { id: "vt323", label: "VT323", stack: '"VT323", monospace', google: "VT323" },
  { id: "georgia", label: "Georgia (system)", stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  { id: "system", label: "System UI", stack: "system-ui, -apple-system, sans-serif" },
  { id: "mono-system", label: "System mono", stack: "ui-monospace, Menlo, Consolas, monospace" },
];

export const CUSTOM_FONT = "custom";

/** The face for one role: a catalog id, or `custom` with a family name typed by the developer. */
export interface FontSlot {
  id: string | null;
  custom: string;
}

export interface TypeTweaks {
  body: FontSlot;
  heading: FontSlot;
  /** Root size multiplier: everything in rem follows. */
  scale: number;
  /** Extra letter spacing in em. */
  tracking: number;
  /** Body line height multiplier, 0 = leave to the page. */
  lineHeight: number;
}

export const TYPE_LIMITS = {
  scale: { min: 0.8, max: 1.4, step: 0.05 },
  tracking: { min: -0.03, max: 0.12, step: 0.005 },
  lineHeight: { min: 0, max: 2.2, step: 0.05 },
} as const;

export const DEFAULT_TYPE: TypeTweaks = {
  body: { id: null, custom: "" },
  heading: { id: null, custom: "" },
  scale: 1,
  tracking: 0,
  lineHeight: 0,
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function normalizeSlot(raw: unknown): FontSlot {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<FontSlot>;
  const custom = typeof o.custom === "string" ? o.custom.replace(/[^\w .-]/g, "").trim().slice(0, 60) : "";
  const known = o.id === CUSTOM_FONT || FONT_CHOICES.some((f) => f.id === o.id);

  return { id: known && (o.id !== CUSTOM_FONT || custom) ? (o.id as string) : null, custom };
}

export function normalizeType(raw: unknown): TypeTweaks {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<TypeTweaks>;
  const L = TYPE_LIMITS;

  return {
    body: normalizeSlot(o.body),
    heading: normalizeSlot(o.heading),
    scale: clamp(o.scale, L.scale.min, L.scale.max, 1),
    tracking: clamp(o.tracking, L.tracking.min, L.tracking.max, 0),
    lineHeight: clamp(o.lineHeight, L.lineHeight.min, L.lineHeight.max, 0),
  };
}

/** The css font stack and Google query for a slot, or null for "leave the page's own". */
export function resolveFont(slot: FontSlot): { stack: string; google?: string } | null {
  if (slot.id === CUSTOM_FONT && slot.custom) {
    return {
      stack: `"${slot.custom}", system-ui, sans-serif`,
      google: slot.custom.trim().replace(/\s+/g, "+"),
    };
  }
  const choice = FONT_CHOICES.find((f) => f.id === slot.id);

  return choice ? { stack: choice.stack, google: choice.google } : null;
}

const loadedFonts = new Set<string>();

/** Fetch a Google font once, on demand (a bad name simply falls back to the stack). */
export function ensureGoogleFont(query: string | undefined): void {
  if (!query || loadedFonts.has(query) || typeof document === "undefined") return;
  loadedFonts.add(query);
  const link = document.createElement("link");

  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
  document.head.appendChild(link);
}

export interface UiCustom {
  skin: SkinId | null;
  crt: boolean;
  pixelFont: boolean;
  live: LiveBackground;
  /** Each look brings its own live wallpaper (on by default). */
  wallpaper: boolean;
  /** Typefaces and type tweaks (developer panel). */
  type: TypeTweaks;
  /** Hidden cheats the player has found. */
  discovered: string[];
}

export const DEFAULT_UI_CUSTOM: UiCustom = {
  skin: null,
  crt: false,
  pixelFont: false,
  live: { on: false, scene: "garden", dim: 0.78, still: false },
  wallpaper: true,
  type: DEFAULT_TYPE,
  discovered: [],
};

export const UI_CUSTOM_KEY = "paperrec_ui_custom";
export const UI_CUSTOM_EVENT = "paperrec:ui-custom";

export function normalize(raw: unknown): UiCustom {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<UiCustom> & {
    live?: Partial<LiveBackground>;
  };
  const skin = SKINS.some((s) => s.id === o.skin) ? (o.skin as SkinId) : null;
  const live: Partial<LiveBackground> = o.live ?? {};
  const dim = typeof live.dim === "number" ? Math.min(0.95, Math.max(0.6, live.dim)) : DEFAULT_UI_CUSTOM.live.dim;

  return {
    skin,
    crt: o.crt === true,
    pixelFont: o.pixelFont === true,
    live: {
      on: live.on === true,
      scene: typeof live.scene === "string" ? live.scene : "garden",
      dim,
      still: live.still === true,
    },
    wallpaper: o.wallpaper !== false,
    type: normalizeType(o.type),
    discovered: Array.isArray(o.discovered)
      ? o.discovered.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function readUiCustom(): UiCustom {
  try {
    const raw = window.localStorage.getItem(UI_CUSTOM_KEY);

    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_UI_CUSTOM;
  }
}

export function writeUiCustom(next: UiCustom): void {
  try {
    window.localStorage.setItem(UI_CUSTOM_KEY, JSON.stringify(normalize(next)));
  } catch {
    /* private mode: it just doesn't persist */
  }
  window.dispatchEvent(new Event(UI_CUSTOM_EVENT));
}

/** The gray ramp the style sheet reads (gray-50 .. gray-950), canvas to ink. */
export function grayRamp(skin: UiSkin): Record<string, string> {
  const from = t(skin.canvas);
  const to = t(skin.ink);
  const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  /* the light end of a skin's ramp stays near the canvas, the dark end
     near the ink, and gray-600 (muted text) lands on the skin's muted */
  const out: Record<string, string> = {};

  for (const step of steps) {
    const k = step <= 100 ? step / 1000 : step >= 800 ? 0.8 + (step - 800) / 750 : step / 1000;

    out[String(step)] = step === 600 ? skin.muted : mix(from, to, Math.min(1, k));
  }

  return out;
}

const SKIN_VARS = [
  "--accent",
  "--accent-soft",
  "--canvas",
  "--surface",
  "--surface-alt",
  "--hairline",
  "--ink",
  "--muted",
  "--field",
  "--on-accent",
  "--on-ink",
  "--signal-tfidf",
  "--signal-sbert",
  "--signal-meta",
  "--tag-cs",
  "--tag-math",
];

/** Put the customizations on the document. Call after the theme is applied. */
export function applyUiCustom(root: HTMLElement = document.documentElement): void {
  const custom = readUiCustom();
  const skin = SKINS.find((s) => s.id === custom.skin) ?? null;

  if (skin) {
    const set = (name: string, value: string) => root.style.setProperty(name, value);

    set("--accent", skin.accent);
    set("--accent-soft", skin.accentSoft);
    set("--canvas", skin.canvas);
    set("--surface", skin.surface);
    set("--surface-alt", skin.surfaceAlt);
    set("--hairline", skin.hairline);
    set("--ink", skin.ink);
    set("--muted", skin.muted);
    set("--field", skin.field);
    set("--on-accent", skin.onAccent);
    set("--on-ink", skin.canvas);
    /* the pipeline and subject colors follow the skin's own accent family */
    const accent = t(skin.accent);
    const ink = t(skin.ink);

    set("--signal-tfidf", mix(accent, ink, 0.0));
    set("--signal-sbert", mix(accent, t(skin.canvas), 0.35));
    set("--signal-meta", mix(accent, ink, 0.45));
    set("--tag-cs", mix(accent, ink, 0.2));
    set("--tag-math", mix(accent, t(skin.canvas), 0.5));
    for (const [step, value] of Object.entries(grayRamp(skin))) {
      set(`--gray-${step}`, value);
    }
    root.dataset.skin = skin.id;
    root.dataset.mode = skin.mode;
    root.style.colorScheme = skin.mode;
  } else {
    delete root.dataset.skin;
  }

  const flag = (name: string, on: boolean) => {
    if (on) root.setAttribute(name, "");
    else root.removeAttribute(name);
  };

  const body = resolveFont(custom.type.body);
  const heading = resolveFont(custom.type.heading);
  const style = root.style;

  for (const [name, font] of [["--font-body", body], ["--font-display", heading]] as const) {
    if (font) {
      ensureGoogleFont(font.google);
      style.setProperty(name, font.stack);
    } else {
      style.removeProperty(name);
    }
  }
  flag("data-font-body", body !== null);
  flag("data-font-heading", heading !== null);
  style.fontSize = custom.type.scale === 1 ? "" : `${custom.type.scale * 100}%`;
  if (custom.type.tracking) style.setProperty("--type-tracking", `${custom.type.tracking}em`);
  else style.removeProperty("--type-tracking");
  if (custom.type.lineHeight) style.setProperty("--type-leading", String(custom.type.lineHeight));
  else style.removeProperty("--type-leading");

  flag("data-crt", custom.crt);
  flag("data-pixelfont", custom.pixelFont);
  flag("data-live-bg", custom.live.on || (skin !== null && custom.wallpaper));
}

export { SKIN_VARS };

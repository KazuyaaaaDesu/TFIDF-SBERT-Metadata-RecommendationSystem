/* ============================================================
   TREE OF KNOWLEDGE — the Lab's knowledge garden.

   A Plants-vs-Zombies-style lawn: a seed bank of the four
   species across the top, a striped grass field, the planted
   tree on the left with its own speech bubble, and an "Ask the
   tree" button that hands out the next stored system trivia.

   Growth comes from real progress (treasures, achievements,
   discovered tips) and only changes the tree's size and the
   trivia tier it can answer; the species is cosmetic and
   persisted per browser. Nothing here is generated — every
   bubble is a stored trivia from data/trivia.ts.
   ============================================================ */

import { GARDEN_FRAME_KEY, applyGardenFrame } from "../../utils/gardenFrame";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  CHEAT_HEIGHTS,
  CHEAT_SETS,
  DEFAULT_SPECIES,
  KNOWLEDGE_STAGES,
  STAGE_HEIGHTS,
  SPECIES_GROWTH_MARKERS,
  SPECIES_STAGE_FERT,
  knowledgePoints,
  knowledgeStageFromHeight,
  nextKnowledgeHeight,
  nextTrivia,
  TREE_SPECIES,
  treeSpecies,
  type TreeSpeciesId,
} from "../../data/knowledge";
import { TRIVIA, type Trivia } from "../../data/trivia";
import { SPECIES_INFO } from "../../data/knowledge";
import {
  BACKDROP_H,
  BACKDROP_THEMES,
  BACKDROP_W,
  DEFAULT_BACKDROP_THEME,
} from "../../data/backdrops";
import type { BackdropThemeId } from "../../data/backdrops";
import { usePixelStage } from "../../hooks/usePixelStage";
import { milestonesCrossed } from "../../utils/gardenMilestones";
import { grumpyLine, registerAsk } from "../../utils/treeAsk";
import { GardenToastStack, useGardenToasts } from "./GardenToasts";
import TreeVariantPicker from "./TreeVariantPicker";
import { useTreeVariant } from "../../state/treeVariant";
import { useSceneLayers } from "../../state/sceneLayers";
import { activeCharms, charmsFor } from "../../data/charms";
import GardenAlmanac from "./GardenAlmanac";
import { useHunt } from "../../state/hunt";
import { useAchievements } from "../../state/achievements";
import { readSeenTipCount, useSun } from "../../state/sun";
import { addOwnedSkin, SKINS_KEY, useOwnedSkins } from "../../state/skins";
import {
  TREE_GROWTH_TARGET,
  treeHeightByFertilizer,
  SPECIES_IDLE_LINES,
  STAGE_IDLE_LINES,
  TREE_SKIN_PRICES,
} from "../../data/knowledge";
import { PixelSprite } from "./PixelGrowthTree";
import PixelGrowthTree from "./PixelGrowthTree";
import GardenBackdrop from "./GardenBackdrop";
import SunShop from "./SunShop";
import ThemeShop from "./ThemeShop";
import SparkleGlyph from "./SparkleGlyph";
import SunGlyph from "./SunGlyph";
import TokenGlyph from "./TokenGlyph";
import { useSiteMode } from "../../state/siteMode";
import RetroDialog from "./RetroDialog";
import { Palette, Sparkles, Sprout } from "lucide-react";

const BACKDROP_THEMES_KEY = "paperrec_backdrop_themes";
const BACKDROP_ACTIVE_KEY = "paperrec_backdrop_theme";

const TRIVIA_KEY = "paperrec_knowledge_trivia";
const LEGACY_TRIVIA_KEY = "paperrec_wisdom_trivia";
/* Each species' tree learns its OWN trunk of trivia: the bank maps
   species id -> learned trivia ids. The old global list migrates
   into the starter maple's trunk. */
const TRIVIA_BANK_KEY = "paperrec_knowledge_trivia_bank";
const SPECIES_KEY = "paperrec_knowledge_species";
const ASKS_KEY = "paperrec_tree_asks";

const LAWN_COLS = 5;
const LAWN_ROWS = 4;

function emptyBank(): Record<TreeSpeciesId, string[]> {
  return {
    crimson: [],
    oak: [],
    birch: [],
    elm: [],
    redwood: [],
    beanstalk: [],
    rosevine: [],
  };
}

function readTriviaBank(): Record<TreeSpeciesId, string[]> {
  try {
    const raw = window.localStorage.getItem(TRIVIA_BANK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const bank = emptyBank();
        for (const id of Object.keys(bank) as TreeSpeciesId[]) {
          const list = parsed[id];
          bank[id] = Array.isArray(list)
            ? list.filter((value) => typeof value === "string")
            : [];
        }
        return bank;
      }
    }
    /* No bank yet: migrate the old single trunk into the starter
       maple so nothing already learned is lost. */
    const legacy = window.localStorage.getItem(TRIVIA_KEY) ??
      window.localStorage.getItem(LEGACY_TRIVIA_KEY);
    const bank = emptyBank();
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        bank[DEFAULT_SPECIES] = parsed.filter(
          (value) => typeof value === "string",
        );
      }
    }
    try {
      window.localStorage.setItem(TRIVIA_BANK_KEY, JSON.stringify(bank));
    } catch {
      // best-effort
    }
    return bank;
  } catch {
    return emptyBank();
  }
}

function writeTriviaBank(bank: Record<TreeSpeciesId, string[]>) {
  try {
    window.localStorage.setItem(TRIVIA_BANK_KEY, JSON.stringify(bank));
    window.localStorage.removeItem(TRIVIA_KEY);
    window.localStorage.removeItem(LEGACY_TRIVIA_KEY);
  } catch {
    // best-effort
  }
}

function readSpecies(): TreeSpeciesId {
  try {
    const raw = window.localStorage.getItem(SPECIES_KEY);
    if (raw && TREE_SPECIES.some((species) => species.id === raw)) {
      return raw as TreeSpeciesId;
    }
  } catch {
    // best-effort
  }
  return DEFAULT_SPECIES;
}

function writeSpecies(id: TreeSpeciesId) {
  try {
    window.localStorage.setItem(SPECIES_KEY, id);
  } catch {
    // best-effort
  }
}


function readAskCount(): number {
  try {
    return Number(window.localStorage.getItem(ASKS_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeAskCount(count: number) {
  try {
    window.localStorage.setItem(ASKS_KEY, String(count));
  } catch {
    // best-effort
  }
}

/* ---------------- menu bar pieces ----------------
   The garden menu groups its controls by purpose (the tree, feeding it,
   the shops). Every chip shows an icon, a word and, where it has one, a
   value, and takes its colors from the adaptive theme tokens (ink,
   surface, accentSoft): fixed navy text on the accent-soft fill was
   unreadable in dark mode. */

/* ---------------- frame themes ----------------
   The garden's carved frame comes in six looks. The choice is remembered
   and written on <html> while the garden is on screen, so the dialogs
   (which live outside the card) wear the same frame. */

const FRAME_KEY = GARDEN_FRAME_KEY;

const FRAMES: { id: string; label: string; a: string; b: string }[] = [
  { id: "wood", label: "Carved wood", a: "#5b3a1e", b: "#f0b848" },
  { id: "stone", label: "Slate stone", a: "#4b505c", b: "#7fe0cc" },
  { id: "parchment", label: "Parchment", a: "#e6d5aa", b: "#f1ac3a" },
  { id: "midnight", label: "Midnight", a: "#1c2246", b: "#ffd36e" },
  { id: "meadow", label: "Meadow", a: "#2e5a30", b: "#ffe36a" },
  { id: "blossom", label: "Blossom", a: "#7a2c52", b: "#ffd36e" },
];

function readFrame(): string {
  try {
    const raw = window.localStorage.getItem(FRAME_KEY);

    if (raw && FRAMES.some((frame) => frame.id === raw)) return raw;
  } catch {
    // best-effort
  }

  return "wood";
}

function FramePicker({
  frame,
  onPick,
}: {
  frame: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const current = FRAMES.find((entry) => entry.id === frame) ?? FRAMES[0];

  useEffect(() => {
    if (!open) return;

    const away = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);

    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* a menu rather than a row of swatches, so any number of frames fits */
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change the menu's frame"
        onClick={() => setOpen((value) => !value)}
        className={`${CHIP} wood-chip`}
      >
        <Palette className="h-3.5 w-3.5" />
        <span className="text-[10px] uppercase tracking-wider">Frame</span>
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 rounded-sm border-2 border-[color:var(--gm-edge2)]"
          style={{ background: `linear-gradient(135deg, ${current.a} 0 55%, ${current.b} 55% 100%)` }}
        />
        <span aria-hidden="true" className="text-[9px]">{open ? "\u25B4" : "\u25BE"}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Menu frame"
          className="wood-board right-0 top-full z-50 mt-1.5 grid max-h-64 w-52 gap-1 overflow-y-auto rounded p-1.5 shadow-[4px_4px_0_rgba(0,0,0,0.4)]"
          style={{ position: "absolute" }}
        >
          {FRAMES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={frame === entry.id}
              onClick={() => {
                onPick(entry.id);
                setOpen(false);
              }}
              className={`${CHIP} ${frame === entry.id ? "wood-chip-lit" : "wood-chip"} w-full justify-start`}
            >
              <span
                aria-hidden="true"
                className="h-4 w-6 shrink-0 rounded-sm border-2 border-[color:var(--gm-edge2)]"
                style={{ background: `linear-gradient(135deg, ${entry.a} 0 55%, ${entry.b} 55% 100%)` }}
              />
              <span className="text-[10px] uppercase tracking-wider">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How rare a tree is, from its skin price: one to five pips. */
function rarityOf(price: number): number {
  if (price <= 0) return 1;
  if (price <= 25) return 2;
  if (price <= 40) return 3;
  if (price <= 60) return 4;

  return 5;
}

/**
 * A tree as a trading card: a rarity strip on top, the tree in an art
 * window, a name banner in the tree's own colors, and a footer that says
 * whether it is planted, in the seed bank, or locked behind its price.
 */
function SpeciesCard({
  species,
  planted,
  owned,
  price,
  onChoose,
  onBuy,
}: {
  species: (typeof TREE_SPECIES)[number];
  planted: boolean;
  owned: boolean;
  price: number;
  onChoose: () => void;
  onBuy: () => void;
}) {
  const pips = rarityOf(price);

  return (
    <button
      type="button"
      className="gm-card"
      style={
        {
          "--card-a": species.leafLight,
          "--card-b": species.leafDeep,
        } as CSSProperties
      }
      aria-pressed={owned ? planted : undefined}
      data-locked={owned ? undefined : ""}
      onClick={owned ? onChoose : onBuy}
      title={
        owned
          ? planted
            ? `${species.label} planted — swap with \u2190 \u2192`
            : `Plant the ${species.label}`
          : `Locked — buy the ${species.label} skin for ${price} growth tokens`
      }
    >
      <span className="gm-card-top" aria-hidden="true">
        <span className="gm-card-pips">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} data-off={i < pips ? undefined : ""} />
          ))}
        </span>
        <span>{price <= 0 ? "free" : `${price}`}</span>
      </span>
      <span className="gm-card-art">
        {owned ? (
          <span
            className="pointer-events-none absolute left-1/2 bottom-0 block select-none"
            style={{ width: 256 * 0.4, height: 144 * 0.4, marginLeft: -(256 * 0.4) / 2 }}
            aria-hidden="true"
          >
            <PixelGrowthTree
              speciesId={species.id}
              growth={SPECIES_STAGE_FERT[species.id][3] / TREE_GROWTH_TARGET}
              cssScale={0.4}
              static
            />
          </span>
        ) : (
          <span className="gm-card-lock" aria-hidden="true">
            {"\uD83D\uDD12"}
          </span>
        )}
      </span>
      <span className="gm-card-name">{species.label}</span>
      <span className="gm-card-foot">
        {owned ? (
          planted ? (
            "\u2605 planted"
          ) : (
            "in seed bank"
          )
        ) : (
          <>
            <TokenGlyph className="inline-block h-2.5 w-2.5" /> {price} tokens
          </>
        )}
      </span>
    </button>
  );
}

function MenuGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="wood-plaque flex flex-col gap-1 px-2 pb-2 pt-1.5"
    >
      <span className="wood-label font-mono text-[9px] font-bold uppercase tracking-[0.22em]">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

const CHIP =
  "flex items-center gap-1.5 rounded border-[3px] px-2 py-1 font-mono text-xs font-bold";

function ChipBody({
  icon,
  label,
  value,
  test,
}: {
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
  test?: boolean;
}) {
  return (
    <>
      {icon}
      <span className="text-[10px] uppercase tracking-wider">{label}</span>
      {value !== undefined && (
        <span className="rounded bg-[var(--gm-inset)] px-1 text-[color:var(--gm-text)]">{value}</span>
      )}
      {test && (
        <span className="rounded border-[2px] border-current px-1 text-[8px] tracking-widest">
          TEST
        </span>
      )}
    </>
  );
}

/** A read-out in the menu bar (not clickable). */
function MenuReadout(props: {
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
  title: string;
}) {
  return (
    <div title={props.title} className={`${CHIP} wood-chip-inset`}>
      <ChipBody {...props} />
    </div>
  );
}

/** A button in the menu bar that opens a shop; `test` marks a developer tool. */
function MenuButton({
  active,
  onClick,
  title,
  test,
  ...body
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  test?: boolean;
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={`${CHIP} transition-colors pixel-ease ${
        test ? "border-dashed" : ""
      } ${active ? "wood-chip-lit" : "wood-chip"}`}
    >
      <ChipBody {...body} test={test} />
    </button>
  );
}

export default function TreeOfKnowledge({
  onOpenShop,
  hideMarkers = false,
}: {
  /** Jump to the Sun Shop tab (the tree's growth store). */
  onOpenShop?: () => void;
  /** Hide the inline marker chips (shown in the Garden band). */
  hideMarkers?: boolean;
}) {
  // Developer controls (the Dev tab and what it opens) are Researcher-only.
  const { mode: siteMode } = useSiteMode();
  const devControls = siteMode === "researcher";

  const { count: treasures } = useHunt();
  const { unlocked } = useAchievements();
  const {
    bonusGrowth,
    balance,
    height,
    fertilizer,
    spent,
    tokens,
    grantTokens,
    spendTokens,
    fertilizerHold,
    applyFertilizer,
    resetTree,
    plantSpecies,
    cheats,
    activeCheats,
  } = useSun();

  /* The bottom-left Tree info card. On a phone the 16:9 stage is so
     short that the open card would hide the whole tree, so it starts
     folded there. */
  const [infoOpen, setInfoOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 640,
  );

  /* The shops open on click/tap only. The fertilizer HOLD applies
     by clicking the badge or dragging its ghost onto the tree —
     pick the amount below the badge first. */
  const [fertMultiplier, setFertMultiplier] = useState<1 | 2 | 10>(1);
  const [dropActive, setDropActive] = useState(false);
  const dropDepthRef = useRef(0);

  function applyHeldFertilizer(count: number) {
    const result = applyFertilizer(count);
    setFeedNote(result.text);
    if (result.ok) {
      spawnSparkles(6);
    }
  }

  const [triviaBank, setTriviaBank] = useState<Record<TreeSpeciesId, string[]>>(
    readTriviaBank,
  );
  /* Dropping a fertilizer pack feeds the tree; the outcome echoes
     in the speech bubble. */
  const [feedNote, setFeedNote] = useState<string | null>(null);

  /* The frame the menu wears (wood, stone, parchment, ...): remembered,
     and written on <html> while the garden is on screen so the dialogs
     wear it too. */
  const [frame, setFrameState] = useState(readFrame);
  const setFrame = (id: string) => {
    setFrameState(id);
    try {
      window.localStorage.setItem(FRAME_KEY, id);
    } catch {
      // best-effort
    }
  };

  useEffect(() => {
    // Stays on <html> after the garden closes: the cheat console and
    // dialogs elsewhere in the app wear the same frame.
    applyGardenFrame(frame);
  }, [frame]);

  /* The tree card's own menu: the shop, skins, and wallet panes. */
  const [menu, setMenu] = useState<
    "info" | "shop" | "skins" | "themes" | "earn" | "wallet" | "charms" | "scene" | null
  >(null);
  /* "Get info" reveals the research the tree holds; the default
     sidebar itself always shows the tree's name and fact card. */
  const [infoExpanded, setInfoExpanded] = useState(false);
  /* The card is anchored to the stage's bottom edge, so expanding it
     grows it upward and would leave the reader staring at the top of
     the old content. Instead, once "Get info" opens, scroll the card's
     own body to the newly revealed section and hand it focus without
     scrolling the page. `infoOpen` is a dependency too: collapsing the
     card unmounts the body, so re-opening it must land on the reveal
     again rather than back at the tree's name. */
  const infoBodyRef = useRef<HTMLDivElement | null>(null);
  const infoRevealRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!infoOpen || !infoExpanded) return;
    const body = infoBodyRef.current;
    const reveal = infoRevealRef.current;
    if (!body || !reveal) return;
    body.scrollTop = Math.max(0, reveal.offsetTop - 6);
    reveal.focus({ preventScroll: true });
  }, [infoExpanded, infoOpen]);

  /* Backdrop themes: Meadow is the default; the Theme shop adds
     and applies the rest. */
  const [themes, setThemes] = useState<BackdropThemeId[]>(() => {
    try {
      const raw = window.localStorage.getItem(BACKDROP_THEMES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((id): id is BackdropThemeId =>
          BACKDROP_THEMES.some((theme) => theme.id === id),
        );
        if (ids.length > 0) return ids;
      }
    } catch {
      // best-effort
    }
    return [DEFAULT_BACKDROP_THEME];
  });
  const [activeTheme, setActiveTheme] = useState<BackdropThemeId>(() => {
    try {
      const raw = window.localStorage.getItem(BACKDROP_ACTIVE_KEY);
      if (raw && BACKDROP_THEMES.some((theme) => theme.id === raw)) {
        return raw as BackdropThemeId;
      }
    } catch {
      // best-effort
    }
    return DEFAULT_BACKDROP_THEME;
  });
  function adoptTheme(
    nextOwned: BackdropThemeId[],
    nextActive: BackdropThemeId,
  ) {
    setThemes(nextOwned);
    setActiveTheme(nextActive);
    try {
      window.localStorage.setItem(BACKDROP_THEMES_KEY, JSON.stringify(nextOwned));
      window.localStorage.setItem(BACKDROP_ACTIVE_KEY, nextActive);
    } catch {
      // best-effort
    }
  }

  /* The landscape stage is sized in WHOLE art pixels (usePixelStage):
     the backdrop and the tree share one pixel grid at one whole-number
     scale, so no art pixel is ever drawn wider than its neighbor.
     "Immersive" is the full-screen view: the stage takes the whole
     screen and the menus tuck into a drawer. */
  const stageColRef = useRef<HTMLDivElement | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pixelStage = usePixelStage(
    stageColRef,
    BACKDROP_W,
    BACKDROP_H,
    immersive,
  );

  /* The card itself is the fullscreen element. A CSS-only
     `position: fixed` overlay cannot work here: the page's route
     animation leaves a transform on <main>, which turns it into the
     containing block and confines "fixed" children to its box. The
     browser's top layer ignores ancestors' transforms. The dialogs
     portal into the fullscreen element (see RetroDialog). */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const canFullscreen =
    typeof document !== "undefined" && document.fullscreenEnabled === true;

  const enterImmersive = useCallback(() => {
    void cardRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  const exitImmersive = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  /* The drawer sits between the menu bar and the action row, which are
     overlays in full screen; their real heights are measured rather
     than guessed. */
  const barRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLDivElement | null>(null);
  const [overlayH, setOverlayH] = useState({ top: 49, bottom: 60 });

  useEffect(() => {
    if (!immersive || !drawerOpen) return;

    const measure = () =>
      setOverlayH({
        top: barRef.current?.offsetHeight ?? 49,
        bottom: actionRef.current?.offsetHeight ?? 60,
      });

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);

    if (barRef.current) observer.observe(barRef.current);
    if (actionRef.current) observer.observe(actionRef.current);

    return () => observer.disconnect();
  }, [immersive, drawerOpen]);

  /* The browser is the source of truth: Esc, the Exit button and a
     denied request all arrive as a fullscreenchange. */
  useEffect(() => {
    const card = cardRef.current;

    const onChange = () => {
      const on = document.fullscreenElement === card;

      setImmersive(on);

      if (!on) setDrawerOpen(false);
    };

    document.addEventListener("fullscreenchange", onChange);

    return () => {
      document.removeEventListener("fullscreenchange", onChange);

      /* Leaving the page must not strand the browser in full screen. */
      if (card && document.fullscreenElement === card) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);
  /* Themed confirm / notice pop-ups (no browser dialogs). */
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    onYes: () => void;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Toggled growth preview: tapping a stage chip shows the tree
     as it looks at that stage; tapping again returns to live. */
  const [previewStage, setPreviewStage] = useState<number | null>(null);
  /* The stage strip is an accordion: collapsed to one small
     trigger chip by default (hover peeks it open on desktop),
     pressing the trigger pins it open for touch devices. */
  const [stagesOpen, setStagesOpen] = useState(false);

  

  const [speciesId, setSpeciesId] =
    useState<TreeSpeciesId>(readSpecies);
  /* The ACTIVE tree's own trunk; every species keeps its own. */
  const seenTrivia = triviaBank[speciesId] ?? [];
  const [current, setCurrent] = useState<Trivia | null>(null);
  const [tipsSeen] = useState<number>(readSeenTipCount);
  const ownedSkins = useOwnedSkins();
  const [treeVariant] = useTreeVariant(speciesId);
  const { off: layersOff } = useSceneLayers();
  /* The garden charms that are unlocked and switched on. */
  const charms = activeCharms(speciesId, cheats, activeCheats);
  const charmCount = charmsFor(speciesId).filter((c) => cheats.includes(c.word)).length;

  /* The tree's growth: sun consumed by fertilizer, then extra sun
     zooms into the world tree. */
  /* Every fertilizer is one step on the original's growth
     timeline: 3,000 packets take the tree from seed to ancient,
     extra packets beyond that rise into the world tree. */
  const growth = Math.min(1, fertilizer / TREE_GROWTH_TARGET);

/* The tree morphs between stages: every chip press animates the
     climb up or the descent down — never a jump. */
  const [morphG, setMorphG] = useState(growth);
  const morphRef = useRef(growth);
  morphRef.current = morphG;
  /* Bump the tree view when a stage chip navigates (the viewer
     itself no longer pans or zooms). */
  /* Cheat-bloom burst: a golden ring + the word + extra sparkles. */
  const [cheatFx, setCheatFx] = useState<{
    id: number;
    word: string;
  } | null>(null);
  const fxId = useRef(0);
  function triggerCheatFx(word: string) {
    const id = fxId.current + 1;
    fxId.current = id;
    setCheatFx({ id, word });
    spawnSparkles(16);
    window.setTimeout(() => {
      setCheatFx((current) => (current?.id === id ? null : current));
    }, 1800);
  }
  useEffect(() => {
    const to =
      previewStage === null
        ? growth
        : growthMarkers[previewStage].fert / TREE_GROWTH_TARGET;
    const from = morphRef.current;
    if (Math.abs(from - to) < 0.001) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 900);
      const ease = t * t * (3 - 2 * t);
      setMorphG(from + (to - from) * ease);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewStage, growth]);

  const growthMarkers = SPECIES_GROWTH_MARKERS[speciesId];
  const activeMarker = [...growthMarkers]
    .reverse()
    .find((marker) => fertilizer >= marker.fert);
  function resetTreeProgress() {
    setConfirm({
      title: "Reset the tree",
      body:
        "Wipe the garden? Trivia, fertilizer, growth, species, and " +
        "skins reset — sun, tokens, and the pet stay. The starter " +
        "maple grows back from its seed.",
      onYes: () => {
        doResetTreeProgress();
      },
    });
  }

  function doResetTreeProgress() {

    try {
      window.localStorage.removeItem(TRIVIA_KEY);
      window.localStorage.removeItem(LEGACY_TRIVIA_KEY);
      window.localStorage.removeItem(TRIVIA_BANK_KEY);
      window.localStorage.removeItem(ASKS_KEY);
      window.localStorage.removeItem(SPECIES_KEY);
      window.localStorage.removeItem(SKINS_KEY);
      window.localStorage.removeItem("paperrec_tree_size");
    } catch {
      // best-effort

    }

    setTriviaBank(emptyBank());
    writeTriviaBank(emptyBank());
    setCurrent(null);
    setFeedNote(null);
    setIdleLine(null);
    setBubbleClosed(false);
    resetTree();

    /* A fresh mount reflects the cleared species and skins: reload
       (the growth also replays from the seed — ideal for testing). */
    window.setTimeout(() => window.location.reload(), 250);
  }

  /* Interaction sparkles. */
  const [sparkles, setSparkles] = useState<
    { id: number; x: number; y: number }[]
  >([]);
  const sparkleId = useRef(0);


  function spawnSparkles(count: number) {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const items = Array.from({ length: count }, () => ({
      id: sparkleId.current++,
      x: Math.round(Math.random() * 70 - 35),
      y: Math.round(Math.random() * 30 - 15),
    }));

    setSparkles((current) => [...current, ...items]);

    const ids = new Set(items.map((item) => item.id));
    window.setTimeout(
      () =>
        setSparkles((current) =>
          current.filter((sparkle) => !ids.has(sparkle.id)),
        ),
      1000,
    );
  }

  const earnedPoints = knowledgePoints({
    treasures,
    achievements: unlocked.length,
    tips: tipsSeen,
  });
  const points = earnedPoints + bonusGrowth;
  /* The tree only knows as deep as it has grown: trivia tiers are
     capped by its height, not by abstract points. */
  const stage = knowledgeStageFromHeight(height);
  const handout = nextTrivia(stage, seenTrivia);
  const tree = treeSpecies(speciesId);

  const nextAt = nextKnowledgeHeight(height);

  /* Pop-ups at the tree's milestones: a height in feet is reached by
     growing past it, so nothing fires on load, when another species is
     planted (a different bed), or when the tree is reset. */
  const { toasts, push: pushToast, dismiss: dismissToast } = useGardenToasts();
  const heightRef = useRef<{ species: TreeSpeciesId; height: number } | null>(
    null,
  );
  useEffect(() => {
    const before = heightRef.current;

    heightRef.current = { species: speciesId, height };

    if (!before || before.species !== speciesId) return;

    for (const milestone of milestonesCrossed(
      before.height,
      height,
      STAGE_HEIGHTS,
      CHEAT_HEIGHTS,
    )) {
      if (milestone.kind === "knowledge") {
        pushToast({
          tone: "milestone",
          title: `${milestone.at} ft reached`,
          body:
            milestone.index === STAGE_HEIGHTS.length - 1
              ? "The tree stands ancient and knows everything it can hold. Ask it for its deepest facts."
              : "The tree has grown wise enough for deeper questions. Ask it again.",
        });
      } else {
        const cheat = CHEAT_SETS[speciesId][milestone.index];

        if (!cheat) continue;

        pushToast({
          tone: "milestone",
          title: `Charm unlocked: ${cheat.word}`,
          body: `${milestone.at} ft reached. Open the Almanac and flip “${cheat.word}” on. ${cheat.effect}`,
        });
        triggerCheatFx(cheat.word);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, speciesId]);

  /* A creature in the garden was clicked or tapped: it reacts on the
     canvas, and the tree says what happened. */
  function pokeCreature(kind: string) {
    const lines: Record<string, string> = {
      squirrel: "Chk-chk-chk! The squirrel scolds you and flings an acorn.",
      jay: "Rakk! The jay bursts away, loops round and lands again.",
      woodpecker: "Rat-a-tat-tat! A drumroll on the bark.",
      oriole: "The oriole flits round its nest, singing.",
      slug: "The slug curls up and blows a slow bubble.",
      hen: "Bawk! The giant's hen squats, and out rolls a golden egg.",
      sleeper: "Hush. Beyond the briars a sleeper lies, a hundred years deep in a dream.",
      rosefield: "A rose of the field. Double-click it and it bursts into petals.",
      "rosefield-burst": "Pop! A burst of petals, and the rose will bloom again.",
      giant: "Fee-fi-fo-fum! The great door booms, and somewhere a golden harp plays on.",
      butterfly: "The butterfly startles, circles once and settles on another bloom.",
      sylph: "A sylph giggles, spins away and bursts into glitter.",
    };

    setFeedNote(lines[kind] ?? "It notices you.");
    setBubbleClosed(false);
    spawnSparkles(4);
  }

  function announceCheat(word: string, armed: boolean, effect: string) {
    pushToast({
      tone: armed ? "cheat-on" : "cheat-off",
      title: armed ? `“${word}” is armed` : `“${word}” is off`,
      body: armed
        ? effect || "The cheat is active until you type it again."
        : "The cheat is switched off. Type it again to arm it.",
    });
  }

  function chooseSpecies(id: TreeSpeciesId) {
    setPreviewStage(null);
    setSpeciesId(id);
    writeSpecies(id);
    plantSpecies(id);
  }

  function buySkin(id: TreeSpeciesId) {
    const price = TREE_SKIN_PRICES[id];
    if (ownedSkins.includes(id)) return;

    const label = treeSpecies(id).label;

    setConfirm({
      title: "Buy this skin",
      body: `Adopt the ${label} for ${price} growth tokens? It unlocks in the seed bank and plants right away.`,
      onYes: () => {
        if (!spendTokens(price)) {
          setNotice(
            `Not enough growth tokens — ${price - tokens} more needed.` +
              " Earn more by using the app: daily visits, hunts, asks," +
              " treasures, and achievements all pay tokens.",
          );
          return;
        }
        addOwnedSkin(id);
        setSpeciesId(id);
        writeSpecies(id);
        plantSpecies(id);
        spawnSparkles(6);
      },
    });
  }

  /* The speech bubble rides the tree's crown: a seed's bubble sits
     low over the sprout, an elder's high under the canopy. */
  /* Always visible: the bubble rides the crown but stays clear of
     the marker chips below and the bed's top edge above — clamped
     so no text is ever covered or clipped at any canvas size. */
  const bubbleBottomPct = Math.max(
    32,
    Math.min(78, 18 + 58 * growth + Math.min(5, height / 200)),
  );



  useEffect(() => {
    if (!feedNote) return;
    const id = window.setTimeout(() => setFeedNote(null), 4200);
    return () => window.clearTimeout(id);
  }, [feedNote]);

  /* Ask too much, too fast, and the tree sometimes just grumbles. */
  const askTimes = useRef<number[]>([]);

  function askTree() {
    const patience = registerAsk(askTimes.current, Date.now(), Math.random);

    askTimes.current = patience.times;

    if (patience.brushOff) {
      /* No fact, no sparkles, no token: a grumble is not an answer. */
      setCurrent({
        id: `grumpy-${Date.now()}`,
        tier: 0,
        topic: "Not now",
        text: grumpyLine(speciesId, Math.random),
      });
      setBubbleClosed(false);

      return;
    }

    const knowledgeHandout = nextTrivia(stage, seenTrivia);
    if (!knowledgeHandout) return;

    const nextSeen = [...seenTrivia, knowledgeHandout.trivia.id];
    setTriviaBank((bank) => {
      const next = { ...bank, [speciesId]: nextSeen };
      writeTriviaBank(next);
      return next;
    });
    setCurrent(knowledgeHandout.trivia);
    setBubbleClosed(false);
    spawnSparkles(5);

    /* Every 5th ask pays a growth token (capped per day). */
    const nextAsks = readAskCount() + 1;
    writeAskCount(nextAsks);
    if (nextAsks % 5 === 0) {
      grantTokens(1, undefined, "asks");
    }
  }

  /* ---- idle speech: like the pet, the tree speaks on its own.
     The trivia bubble auto-dismisses after a minute of idle, then
     ambient grove lines appear at random gates from 1 second to
     2 minutes, each held open briefly. ---- */
  const [idleLine, setIdleLine] = useState<{
    text: string;
    topic: string;
  } | null>(null);
  const [bubbleClosed, setBubbleClosed] = useState(false);
  /* The bubble rests after speaking: every whisper or trivia piece
     auto-closes on a random cooldown between 4 and 7 seconds. */
  useEffect(() => {
    if (bubbleClosed || (!feedNote && !current)) return;
    const delay = 4000 + Math.floor(Math.random() * 3000);
    const id = window.setTimeout(() => setBubbleClosed(true), delay);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedNote, current, bubbleClosed]);
  const hoverRef = useRef(false);
  /* The idle timer reads the latest progress without restarting. */
  const progressRef = useRef({ fertilizer, growthMarkers: [] as { fert: number }[] });
  progressRef.current = { fertilizer, growthMarkers };

  useEffect(() => {
    if (bubbleClosed) return;

    if (current) {
      /* The trivia holds for a minute, then the tree falls silent. */
      const t = window.setTimeout(
        () => setCurrent(null),
        60_000,
      );
      return () => window.clearTimeout(t);
    }

    if (idleLine) {
      /* The line lingers a few seconds, then the tree hushes. */
      const t = window.setTimeout(
        () => setIdleLine(null),
        6_000 + Math.random() * 2_000,
      );
      return () => window.clearTimeout(t);
    }

    /* Random gate between lines: 1 second to 2 minutes. */
    const t = window.setTimeout(() => {
      if (hoverRef.current) {
        /* Someone is looking close: try again soon instead. */
        setIdleLine(null);
        return;
      }
      /* Half the time the tree speaks about where it is in its growth,
         the rest it shares its species' lore. */
      const growthStage = Math.max(
        0,
        progressRef.current.growthMarkers.reduce(
          (found, marker, index) =>
            progressRef.current.fertilizer >= marker.fert ? index : found,
          0,
        ),
      );
      const stagePool = STAGE_IDLE_LINES[growthStage] ?? [];
      const pool =
        stagePool.length > 0 && Math.random() < 0.5
          ? stagePool
          : SPECIES_IDLE_LINES[speciesId];
      const line = pool[Math.floor(Math.random() * pool.length)];
      setIdleLine(line);
    }, 1_000 + Math.random() * 119_000);
    return () => window.clearTimeout(t);
  }, [current, idleLine, bubbleClosed, speciesId]);

  return (
    <div
      ref={cardRef}
      data-tree-card=""
      data-immersive={immersive ? "" : undefined}
      className={
        immersive
          ? "overflow-hidden bg-[#14110c]"
          : "overflow-hidden rounded border-[3px] border-gray-900 bg-white"
      }
    >
      {/* ---------------- menu bar: tree, feed, shop --------------- */}
      <div
        ref={barRef}
        className={`wood-board wood-rope-top flex flex-col gap-2.5 rounded-none border-x-0 border-t-0 px-3 pb-3 pt-4 ${
          immersive
            ? drawerOpen
              ? "absolute inset-x-0 top-0 z-40 pr-40"
              : "hidden"
            : ""
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="gm-title font-pixelify text-base font-bold uppercase tracking-[0.18em]">
              The Garden
            </span>
            <span className="wood-label font-mono text-[10px] font-bold uppercase tracking-[0.15em]">
              {KNOWLEDGE_STAGES[stage]}
              {" · "}
              {height} ft
              {" · "}
              {handout
                ? `${handout.learned}/${handout.eligible} learned`
                : "0/0 learned"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <FramePicker frame={frame} onPick={setFrame} />
            {/* the developer switch stands apart from the shops */}
            {devControls && (
              <MenuButton
                test
                active={menu === "wallet"}
                onClick={() => setMenu(menu === "wallet" ? null : "wallet")}
                title="Developer tab: test wallet, growth, looks and scenery controls"
                label="Dev"
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-[1_1_22rem] lg:max-w-[min(100%,36rem)]">
        <MenuGroup label="Seed bank">
        {/* the species picker: character-selector cards */}
        <div
          role="group"
          aria-label="Species picker"
          className="gm-bank"
          onKeyDown={(event) => {
            const owned = TREE_SPECIES.filter((sp) =>
              ownedSkins.includes(sp.id),
            );
            const index = owned.findIndex((sp) => sp.id === speciesId);
            if (event.key === "ArrowRight") {
              event.preventDefault();
              if (owned.length > 0) chooseSpecies(owned[(index + 1) % owned.length].id);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              if (owned.length > 0) {
                chooseSpecies(
                  owned[(index - 1 + owned.length) % owned.length].id,
                );
              }
            }
          }}
        >

        {TREE_SPECIES.map((species) => (
          <SpeciesCard
            key={species.id}
            species={species}
            planted={species.id === speciesId}
            owned={ownedSkins.includes(species.id)}
            price={TREE_SKIN_PRICES[species.id]}
            onChoose={() => chooseSpecies(species.id)}
            onBuy={() => buySkin(species.id)}
          />
        ))}

        </div>

        </MenuGroup>
        </div>

        {/* the rest of the controls fill the space beside the seed bank, and
            wrap under it when the card is narrow */}
        <div className="flex min-w-0 flex-1 basis-[19rem] flex-wrap content-start items-start gap-3">
        <MenuGroup label="Feed">
          <MenuReadout
            icon={<Sprout className="h-3.5 w-3.5" />}
            label="Growth"
            value={points}
            title={`Growth points: ${earnedPoints} earned + ${bonusGrowth} from fertilizer`}
          />
        {/* fertilizer: badge + amount selector, one compact unit */}
        <div className="wood-chip flex items-stretch overflow-hidden rounded border-[3px]">
          <button
            type="button"
            title="Click to fertilize with the selected amount, or drag the icon onto the tree"
            onClick={() => applyHeldFertilizer(fertMultiplier)}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                "application/x-fertilizer",
                String(fertMultiplier),
              );
              event.dataTransfer.effectAllowed = "copy";

              /* The drag ghost is the fertilizer icon itself,
                 badge-styled, with the chosen amount on it. */
              const svgNS = "http://www.w3.org/2000/svg";
              const icon = document.createElementNS(svgNS, "svg");
              icon.setAttribute("viewBox", "0 0 32 32");
              icon.setAttribute("width", "40");
              icon.setAttribute("height", "40");
              icon.setAttribute("aria-hidden", "true");
              icon.style.display = "block";
              icon.innerHTML =
                '<rect x="7" y="10" width="18" height="18" rx="2" fill="#a9762f" stroke="#5a3a14" stroke-width="2"></rect>' +
                '<rect x="10" y="4" width="12" height="8" rx="2" fill="#8a5a2b" stroke="#5a3a14" stroke-width="2"></rect>' +
                '<path d="M16 14 l4 5 h-3 v5 h-2 v-5 h-3 z" fill="#7ec850" stroke="#3b6d11" stroke-width="1"></path>';

              const ghost = document.createElement("div");
              ghost.style.cssText =
                "position:fixed;left:0;top:0;display:grid;place-items:center;" +
                "gap:2px;width:56px;height:56px;border:3px solid #1a1a1a;" +
                "border-radius:10px;background:#d9b382;box-shadow:3px 3px 0 rgba(0,0,0,0.35);";
              ghost.appendChild(icon);
              const badge = document.createElement("span");
              badge.textContent = `${fertMultiplier}x`;
              badge.style.cssText =
                "font:700 11px ui-monospace,monospace;color:#3b6d11;background:#f5e08a;" +
                "border:2px solid #1a1a1a;border-radius:4px;padding:0 4px;";
              ghost.appendChild(badge);
              document.body.appendChild(ghost);
              event.dataTransfer.setDragImage(ghost, 28, 28);
              window.setTimeout(() => ghost.remove(), 0);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs font-bold hover:bg-white/15"
          >
            <svg viewBox="0 0 32 32" className="h-4 w-4" aria-hidden="true">
              <rect x="6" y="11" width="20" height="17" rx="2" fill="#a9762f" stroke="#5a3a14" strokeWidth="2" />
              <rect x="10" y="5" width="12" height="8" rx="2" fill="#8a5a2b" stroke="#5a3a14" strokeWidth="2" />
              <path d="M16 15 l4 5 h-3 v5 h-2 v-5 h-3 z" fill="#7ec850" stroke="#3b6d11" strokeWidth="1" />
            </svg>
            <span className="text-[10px] uppercase tracking-wider">Fertilizer</span>
            {fertilizerHold}
          </button>

          <span aria-hidden="true" className="w-[2px] bg-[var(--gm-edge)]" />

          <div
            className="flex items-stretch"
            title="Amount applied per click or drop"
          >
            {([1, 2, 10] as const).map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setFertMultiplier(amount)}
                aria-pressed={fertMultiplier === amount}
                title={`Apply ${amount}× from your hold`}
                className={`w-8 border-l-[2px] border-[color:var(--gm-edge)] font-mono text-[11px] font-bold transition-colors pixel-ease ${
                  fertMultiplier === amount
                    ? "wood-chip-lit"
                    : "text-[color:var(--gm-ink)] hover:bg-white/15"
                }`}
              >
                {amount}×
              </button>
            ))}
          </div>
        </div>

        </MenuGroup>

        <MenuGroup label="Almanac">
          <MenuButton
            active={menu === "charms"}
            onClick={() => setMenu(menu === "charms" ? null : "charms")}
            title="The tree's charms: parts of the garden it unlocks as it grows"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="Charms"
            value={`${charmCount}/5`}
          />
          <MenuButton
            active={menu === "scene"}
            onClick={() => setMenu(menu === "scene" ? null : "scene")}
            title="Switch the garden's scenery on and off"
            icon={<SunGlyph />}
            label="Scene"
          />
          <MenuButton
            active={menu === "earn"}
            onClick={() => setMenu(menu === "earn" ? null : "earn")}
            title="How to earn sun"
            icon={<Sprout className="h-3.5 w-3.5" />}
            label="Earn"
          />
        </MenuGroup>

        <MenuGroup label="Shop">
          <MenuButton
            active={menu === "shop"}
            onClick={() => setMenu(menu === "shop" ? null : "shop")}
            title="Sun shop — buy fertilizer"
            icon={<SunGlyph />}
            label="Sun shop"
            value={balance}
          />
          <MenuButton
            active={menu === "skins"}
            onClick={() => setMenu(menu === "skins" ? null : "skins")}
            title="Tree skins — buy with growth tokens"
            icon={<TokenGlyph />}
            label="Skins"
            value={tokens}
          />
          <MenuButton
            active={menu === "themes"}
            onClick={() => setMenu(menu === "themes" ? null : "themes")}
            title="Theme shop — change the garden's scenery"
            icon={<Palette className="h-3.5 w-3.5" />}
            label="Themes"
          />
        </MenuGroup>

        </div>
        </div>
      </div>

      {/* ---------------- garden bed: the animated landscape ------ */}
      {/* the tree and its menus sit side by side so the pop-ups
          always fit within the window */}
      <div
        className={
          immersive
            ? "absolute inset-0"
            : "relative"
        }
      >
      <div
        ref={stageColRef}
        className={
          immersive
            ? "absolute inset-0 flex items-center justify-center overflow-hidden bg-[#14110c]"
            : "relative w-full overflow-hidden bg-[#14110c] px-3 pb-1.5 pt-6"
        }
      >
        {/* TREE INFO — bottom-left card over the stage (in full
            screen it clears the action row while the menu is open) */}
        <div
          className={`absolute left-3 z-30 flex w-[min(20rem,calc(100%-1.5rem))] flex-col [overflow-anchor:none] ${
            immersive && drawerOpen
              ? "bottom-16 max-h-[calc(100%-5.25rem)]"
              : "bottom-3 max-h-[calc(100%-1.5rem)]"
          }`}
        >
          <div className="flex min-h-0 flex-col overflow-hidden rounded border-[3px] border-gray-900 bg-white/95">
            <button
              type="button"
              onClick={() => setInfoOpen((value) => !value)}
              aria-expanded={infoOpen}
              className="flex w-full shrink-0 items-center justify-between gap-2 border-b-[2px] border-gray-900 bg-canvas px-3 py-1.5 font-pixelify text-xs font-bold uppercase tracking-[0.15em] text-ink"
            >
              Tree info
              <span>{infoOpen ? "\u25BE" : "\u25B8"}</span>
            </button>

            {infoOpen && (
              <div
                ref={infoBodyRef}
                className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
              >
                <p className="font-pixelify text-base font-bold leading-tight text-ink">
                  {SPECIES_INFO[speciesId].name}
                </p>
                <p className="mt-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-accent">
                  {treeSpecies(speciesId).label}
                </p>

                <p className="mt-2 text-xs leading-5 text-ink">
                  {SPECIES_INFO[speciesId].fact}
                </p>

                {!infoExpanded ? (
                  <button
                    type="button"
                    onClick={() => setInfoExpanded(true)}
                    className="mt-3 w-full rounded border-[3px] border-gray-900 bg-accent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-[#2b3347] transition-all pixel-ease hover:brightness-110"
                  >
                    Get info
                  </button>
                ) : (
                  <div ref={infoRevealRef} tabIndex={-1} className="outline-none">
                    <span
                      role="status"
                      className="mb-2 mt-3 inline-block rounded border-[2px] border-gray-900 bg-accentSoft px-2 py-1 font-mono text-[10px] font-bold text-[#2b6e1e]"
                    >
                      {handout && handout.eligible > 0
                        ? `${handout.learned}/${handout.eligible} learned`
                        : "0/0 learned"}
                    </span>

                    <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-wide text-muted">
                      Research on the tree
                    </p>
                    <p className="mt-1 text-xs leading-5 text-ink">
                      {SPECIES_INFO[speciesId].research}
                    </p>

                    <p className="mt-3 font-mono text-[10px] font-bold uppercase tracking-wide text-muted">
                      The trunk's knowledge
                    </p>
                    {seenTrivia.length === 0 ? (
                      <p className="mt-1 text-xs italic text-muted">
                        Nothing yet — ask the tree while it grows.
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-2">
                        {TRIVIA.filter((item) =>
                          seenTrivia.includes(item.id),
                        ).map((item) => (
                          <li
                            key={item.id}
                            className="rounded border-[2px] border-gray-900 bg-white px-2 py-1.5"
                          >
                            <p className="font-mono text-[9px] font-bold uppercase tracking-wide text-accent">
                              {item.topic}
                            </p>
                            <p className="text-[11px] leading-4 text-ink">
                              {item.text}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}

                    {nextAt !== undefined && (
                      <p className="mt-3 font-mono text-[9px] font-bold uppercase tracking-wider text-muted">
                        Next knowledge at {nextAt} ft — grow it to ask
                        deeper.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* the landscape stage is an exact 16:9 box: wide enough to
            cover the column, never stretched, never letterboxed */}
        <div
          className={`relative ${
            pixelStage
              ? immersive
                ? "shrink-0"
                : "mx-auto"
              : "aspect-[16/9] w-full"
          }`}
          style={
            pixelStage
              ? {
                  width: `${pixelStage.cssW}px`,
                  height: `${pixelStage.cssH}px`,
                }
              : undefined
          }
        >
        <GardenBackdrop
          theme={activeTheme}
          parallax={morphG}
          speciesId={speciesId}
          layersOff={layersOff}
        />

        <TreeVariantPicker
          speciesId={speciesId}
          className={`right-3 ${
            immersive && drawerOpen ? "bottom-16" : "bottom-3"
          }`}
        />

        {!immersive && canFullscreen && (
          <button
            type="button"
            onClick={enterImmersive}
            aria-label="Full screen"
            title="Full screen (Esc to leave)"
            className="retro-shadow-light absolute right-2 top-2 z-20 grid h-7 w-7 place-items-center rounded-md border-[2px] border-gray-900 bg-white/85 text-[#2b3347] transition-colors pixel-ease hover:bg-accentSoft dark:bg-[#241c12]/90 dark:text-[#cfc3b4]"
          >
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" />
            </svg>
          </button>
        )}

      <div className="absolute inset-0 z-10">
          <div
            className={`relative h-full w-full transition-all duration-200 pixel-ease ${
              dropActive
                ? "rounded-xl ring-4 ring-[#f5e08a]/90 ring-offset-2 ring-offset-[#8a5a2b]/20"
                : ""
            }`}
            onMouseEnter={() => {
              hoverRef.current = true;
            }}
            onMouseLeave={() => {
              hoverRef.current = false;
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("application/x-fertilizer")) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropActive(true);
            }}
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes("application/x-fertilizer")) {
                return;
              }
              dropDepthRef.current += 1;
              setDropActive(true);
            }}
            onDragLeave={() => {
              dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
              if (dropDepthRef.current === 0) {
                setDropActive(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropDepthRef.current = 0;
              setDropActive(false);
              const raw = event.dataTransfer.getData(
                "application/x-fertilizer",
              );
              const count = Number(raw);
              if (count === 1 || count === 2 || count === 10) {
                applyHeldFertilizer(count);
              }
            }}
          >
            <PixelGrowthTree
              speciesId={speciesId}
              variantId={treeVariant}
              layersOff={layersOff}
              charms={charms}
              onCreature={pokeCreature}
              growth={morphG}
              cssScale={pixelStage?.cssScale}
              onTreeClick={() => setBubbleClosed(false)}
            />

            {/* the bubble's tail points at the crown; it climbs as
                the tree grows and settles under the canopy. Closing
                it (x) hides it entirely — even the prompt — so the
                grown tree can be admired; ask or click the tree to
                call it back. */}
            {!bubbleClosed && (
            <div
              className="absolute left-[calc(50%+3.5rem)] z-10 w-max max-w-[min(30rem,calc(100%-1.5rem))] -translate-x-1/2 rounded border-[3px] border-gray-900 bg-white px-3.5 py-2.5 font-mono text-[15px] leading-[22px] text-ink shadow-[3px_3px_0_rgba(0,0,0,0.25)] transition-[bottom] duration-700 pixel-ease"
              data-tree-bubble
              style={{
                bottom: `${bubbleBottomPct * (128 / BACKDROP_H)}%`,
              }}
            >
              {feedNote ? (
                <>
                  <span className="font-bold">{feedNote}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wide text-muted">
                    Garden
                  </span>
                </>
              ) : current ? (
                <>
                  <span className="font-bold">{current.text}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wide text-muted">
                    {current.topic}
                    {" · "}
                    {tree.label}
                  </span>
                </>
              ) : idleLine ? (
                <>
                  <span className="font-bold">{idleLine.text}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-wide text-muted">
                    {idleLine.topic}
                  </span>
                </>
              ) : (
                <span className="text-muted">
                  Ask the tree for a piece of system knowledge.
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setCurrent(null);
                  setIdleLine(null);
                  setBubbleClosed(true);
                }}
                title="Close the speech bubble to see the tree"
                aria-label="Close speech bubble"
                className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded border-[2px] border-gray-900 bg-white font-mono text-[11px] font-bold leading-none text-ink transition-colors pixel-ease hover:bg-accentSoft"
              >
                {"\u00D7"}
              </button>
              <span
                aria-hidden="true"
                className="absolute -bottom-[9px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b-[3px] border-r-[3px] border-gray-900 bg-white"
              />
            </div>
            )}


            {/* ground shadow stays put; the canvas tree adds its own */}
            <span
              aria-hidden="true"
              className="absolute -bottom-1 left-1/2 h-2 w-20 -translate-x-1/2 rounded-full bg-black/20"
            />

              {/* cheat bloom: ring + word burst */}
            {cheatFx && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
                <span
                  aria-hidden="true"
                  className="absolute h-40 w-40 animate-ping rounded-full border-4 border-[#f0c161] opacity-70"
                />
                <span
                  className="animate-pulse rounded-lg border-[3px] border-gray-900 bg-white/95 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-accent shadow-[3px_3px_0_rgba(0,0,0,0.2)]"
                >
                  Cheat unlocked — {"\u201C"}{cheatFx.word}{"\u201D"}
                </span>
              </div>
            )}

            {/* sparkle burst when the tree dispenses trivia */}
            {sparkles.map((sparkle) => (
              <span
                key={sparkle.id}
                aria-hidden="true"
                className="sparkle-pop pointer-events-none absolute top-8 z-10"
                style={{
                  left: `calc(50% + ${sparkle.x}px)`,
                  marginTop: sparkle.y,
                }}
              >
                <SparkleGlyph />
              </span>
            ))}
          </div>
        </div>
            {/* growth markers: the tree visibly grows at each sun value;
                relocated to the top-left corner of the meadow as a
                toggleable stage strip. Collapsed to one trigger chip
                by default — hover peeks the full strip open, a press
                pins it open (so it still works without a mouse). */}
            {!hideMarkers && (
            <div className="group absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setStagesOpen((open) => !open)}
                aria-expanded={stagesOpen}
                aria-label="Show growth stages"
                className="retro-shadow-light flex items-center gap-1 rounded-md border-[2px] border-gray-900 bg-white/85 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide text-[#2b3347] transition-colors pixel-ease hover:bg-accentSoft dark:bg-[#241c12]/90 dark:text-[#cfc3b4]"
              >
                <span aria-hidden="true" className="text-[8px]">
                  {"○"}
                </span>
                {activeMarker?.label ?? "Stages"}
                <span aria-hidden="true" className="text-[7px] opacity-70">
                  {"▾"}
                </span>
              </button>
              {growthMarkers.map((marker, index) => {
                const reached = fertilizer >= marker.fert;
                const live = activeMarker?.label === marker.label;
                const active = previewStage === index;
                const nextFert =
                  growthMarkers[index + 1]?.fert ?? marker.fert;

                return (
                  <button
                    key={marker.label}
                    type="button"
                    aria-pressed={active}
                    title={
                      active
                        ? "Back to the tree as it grows"
                        : `Preview the ${marker.label} stage`
                    }
                    onClick={() => {
                      setPreviewStage(active ? null : index);
                    }}
                    className={`${
                      stagesOpen ? "flex" : "hidden group-hover:flex"
                    } retro-shadow-light items-center gap-1 rounded-md border-[2px] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide transition-colors pixel-ease ${
                      active ? "animate-pulse" : ""
                    }
                    ${
                      active
                        ? "border-gray-900 bg-accent text-[#2b3347] shadow-[2px_2px_0_rgba(0,0,0,0.2)]"
                        : live
                          ? "border-gray-900 bg-accentSoft text-[#2b3347]"
                          : reached
                            ? "border-[#4a7a2f] bg-accentSoft text-[#2b6e1e] hover:bg-[#dff0d2]"
                            : "border-gray-300/80 bg-white/85 text-[#6a6053] dark:bg-[#241c12]/90 dark:text-[#cfc3b4] hover:border-gray-900 hover:text-gray-800"
                    }`}
                  >
                    <span aria-hidden="true" className="text-[8px]">
                      {reached
                        ? "\u2713"
                        : index === growthMarkers.length - 1
                          ? "\u2605"
                          : "\u25CB"}
                    </span>
                    {marker.label}
                    {!reached && (
                      <span className="opacity-60">
                        {"\u00B7"}{" "}
                        {treeHeightByFertilizer(nextFert, speciesId) -
                          treeHeightByFertilizer(fertilizer, speciesId)}{" "}
                        ft
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            )}
        </div>
      </div>


      </div>

      {/* The Sun shop / skins / wallet open as a pop-up now —
          hover-opened, so focus is not seated into it. */}
      <RetroDialog
        open={menu === "charms" || menu === "scene"}
        title="Garden almanac"
        size="lg"
        skin="wood"
        woodBody
        confirmLabel="Close"
        onConfirm={() => setMenu(null)}
        onCancel={() => setMenu(null)}
        showCancelButton={false}
        focusOnOpen={false}
      >
        {menu === "charms" || menu === "scene" ? (
          <GardenAlmanac
            key={menu}
            speciesId={speciesId}
            height={height}
            tab={menu}
            onToggled={announceCheat}
          />
        ) : null}
      </RetroDialog>

      <RetroDialog
        skin="wood"
        open={
          menu === "shop" ||
          menu === "skins" ||
          menu === "themes" ||
          menu === "earn" ||
          menu === "wallet"
        }
        title={
          menu === "shop"
            ? "Sun shop"
            : menu === "skins"
              ? "Tree skins"
              : menu === "themes"
                ? "Theme shop"
                : menu === "earn"
                  ? "Earn sun"
                  : "Developer"
        }
        size="lg"
        confirmLabel="Close"
        onConfirm={() => setMenu(null)}
        onCancel={() => setMenu(null)}
        showCancelButton={false}
        focusOnOpen={false}
      >
        {menu === "shop" ||
        menu === "skins" ||
        menu === "themes" ||
        menu === "earn" ||
        menu === "wallet" ? (
        <SunShop
          embedded
          tab={menu}
          onSelect={(id) => setMenu(id)}
          themes={themes}
          activeTheme={activeTheme}
          onThemeChanged={adoptTheme}
          plantedSpecies={speciesId}
          onPlantSpecies={chooseSpecies}
          hidePreview
          onWhisper={(text) => {
            setFeedNote(text);
            setBubbleClosed(false);
          }}
        />
        ) : null}
      </RetroDialog>


      {/* centered action row under the bed */}
      <div
        ref={actionRef}
        className={`flex flex-wrap items-center justify-center gap-2.5 border-t-[3px] border-gray-900 bg-accentSoft px-4 py-3 ${
          immersive
            ? drawerOpen
              ? "absolute inset-x-0 bottom-0 z-40"
              : "hidden"
            : ""
        }`}
      >

        <button
          type="button"
          onClick={askTree}
          className="retro-shadow-dark rounded-lg border-[3px] border-gray-900 bg-accent px-5 py-2 font-mono text-xs font-bold uppercase tracking-[0.1em] text-onAccent shadow-[3px_3px_0_rgba(0,0,0,0.18)] transition-all pixel-ease hover:brightness-110 hover:bg-accent hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_rgba(0,0,0,0.18)] active:translate-y-[3px] active:shadow-none"
        >
          Ask the tree
        </button>

        <p className="rounded-md border-[2px] border-gray-900 bg-white px-2.5 py-1 font-mono text-[10px] font-bold text-gray-800">
          {nextAt === undefined
            ? "knows all it can hold"
            : `next knowledge at ${nextAt} ft`}
        </p>

        {nextAt !== undefined && (
          <button
            type="button"
            onClick={() => setMenu(menu === "shop" ? null : "shop")}
            className="rounded border-[2px] border-gray-900 bg-[#d3f9d8] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-[#2b8a3e] transition-colors pixel-ease hover:bg-[#b2f2bb]"
          >
            Buy fertilizer {"\u2192"}
          </button>
        )}

        <button
          type="button"
          onClick={resetTreeProgress}
          title="Clears the tree's learned trivia and regrows it"
          className="rounded border-[2px] border-gray-900 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-muted transition-colors pixel-ease hover:bg-accentSoft"
        >
          Reset progress
        </button>
      </div>

      {immersive && (
        <>
          <div className="absolute right-3 top-2 z-50 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-expanded={drawerOpen}
              className="retro-shadow-dark rounded-lg border-[3px] border-gray-900 bg-accent px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.1em] text-onAccent transition-all pixel-ease hover:brightness-110"
            >
              {drawerOpen ? "Hide menu" : "Menu"}
            </button>
            <button
              type="button"
              onClick={exitImmersive}
              className="retro-shadow-dark rounded-lg border-[3px] border-gray-900 bg-white px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.1em] text-ink transition-all pixel-ease hover:bg-accentSoft"
            >
              Exit
            </button>
          </div>

          {!drawerOpen && (
            <button
              type="button"
              onClick={askTree}
              className="retro-shadow-dark absolute bottom-3 right-3 z-30 rounded-lg border-[3px] border-gray-900 bg-accent px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.1em] text-onAccent transition-all pixel-ease hover:brightness-110"
            >
              Ask the tree
            </button>
          )}
        </>
      )}

      <RetroDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.onYes();
          setConfirm(null);
        }}
      >
        {confirm?.body}
      </RetroDialog>

      <GardenToastStack toasts={toasts} onDismiss={dismissToast} />

      <RetroDialog
        open={notice !== null}
        title="Heads up"
        autoCloseMs={10_000}
        onCancel={() => setNotice(null)}
        onConfirm={() => setNotice(null)}
        confirmLabel="OK"
      >
        {notice}
      </RetroDialog>
    </div>
  );
}

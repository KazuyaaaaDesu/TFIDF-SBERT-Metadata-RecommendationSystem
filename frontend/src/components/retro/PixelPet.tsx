import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTypewriter } from "../../hooks/useTypewriter";
import {
  TIPS,
  EXTRA_TIPS,
  TIP_BY_ID,
  type Tip,
} from "../../data/tips";
import { HUNT_ITEMS } from "../../data/hunt";
import { ACHIEVEMENTS } from "../../data/achievements";
import { PET_FORMS } from "../../data/petForms";
import type { PetAnimState } from "./PetBlob";
import { usePetForm } from "../../state/petForm";
import PetBlob from "./PetBlob";
import CrumpledPaper from "./CrumpledPaper";
import {
  getPetLines,
  getDestructionLine,
  getDropMode,
  getHungryLine,
  getPetCorpus,
  type DropMode,
} from "../../data/petlines";
import { PET_CHAT_EVENT } from "../../utils/petChat";
import {
  buildChain,
  composeChatLine,
  type PetChatContext,
} from "../../utils/petMarkov";
import { removeFromLibrary } from "../../api";
import { answerQuestion } from "../../data/help";
import { useHunt, HUNT_FOUND_EVENT } from "../../state/hunt";
import { SLIME_ANIMATION_EVENT, type SlimeAnimationMode } from "../../utils/slimeEvents";
import {
  useAchievements,
  ACHIEVEMENT_UNLOCKED_EVENT,
} from "../../state/achievements";
import { useSun } from "../../state/sun";
import { ArrowDown, BlockCursor, CloseX, Diamond, Star } from "./PixelIcons";

/* ============================================================
   PIXEL PET — the resident arcade companion / clipper-style
   guide.

   Three ways to get tips:

   1. HOVER (the main way): hold your pointer on any element
      annotated with data-tips="<tip id>" for HOVER_DELAY_MS
      and the pet reveals that tip. A progress ring + percent
      chip on the pet shows the dwell charging up. After a tip
      is revealed the engine rests for HOVER_COOLDOWN_MS before
      it will dwell again, and a brief pointer excursion (under
      HOVER_GRACE_MS) does not reset the dwell.
   2. CLICK: the pet cycles through the tips you have already
      discovered — plus, while the scavenger hunt is running,
      a hint for the next missing treasure; once every treasure
      is found, the locked DEEP TIPS join the cycle too and
      EVERY tip is unlocked (the counter shows FOUND n/n).
   3. ASK (after the hunt): the pet becomes a help library —
      type a question and it answers from the full tip
      catalog (see src/data/help.ts).

   The pet is also draggable: grab it and move it anywhere in the
   viewport (position persists in localStorage). The tooltip flips
   to the other side of the pet when it would leave the screen.
   Double-click opens a pet menu with quick actions, docking
   presets and the achievement rack.

   Discovered tips persist in localStorage (paperrec_tips_seen);
   treasures persist in paperrec_hunt_found.
   ============================================================ */

const HOVER_DELAY_MS = 1_000;
const HOVER_COOLDOWN_MS = 3_000;
const HOVER_GRACE_MS = 500;
const TICK_MS = 100;

const TIP_SPEED = 18;

const SEEN_KEY = "paperrec_tips_seen";
const PET_POS_KEY = "paperrec_pet_pos";
const PET_SIZE_KEY = "paperrec_pet_size";

/* Resizable pet: the native Petdex frame is 192×208, so the pet can
   grow up to its original dimensions (208 CSS px tall). */
const DEFAULT_PET_SIZE = 68;
const MIN_PET_SIZE = 48;
const MAX_PET_SIZE = 208;

/* The sprite is drawn at `size` tall but the draggable box is a little
   larger, so the pet is easy to grab and the bob animation has room.
   Everything that needs the pet's footprint (viewport clamping, the
   dock presets, the tooltip/bubble flips) must go through this
   multiplier — never the bare sprite size. */
const PET_BOX_RATIO = 1.2;

/* Every core tip. Finding all treasures unlocks all of them. */
const CORE_TIP_IDS = TIPS.map((tip) => tip.id);

const RING_RADIUS = 46;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/* Draggable pet: sizes used to clamp the pet inside the viewport
   and to flip the tooltip when it would leave the screen. */
const PET_MARGIN = 20;
const DRAG_THRESHOLD = 6;
const TOOLTIP_W = 288;
const TOOLTIP_H = 320;
const TOOLTIP_GAP = 12;

/* Speech bubble: width cap, estimated height, gap to the pet. */
const BUBBLE_W = 220;
const BUBBLE_H = 44;
const BUBBLE_GAP = 10;

/* Ways the pet can dispose of a library paper dropped on it.
   Which one it picks is the CURRENT FORM's call — only the slime
   forms eat (see FORM_DROP_MODES in petlines.ts). */
const DESTRUCTION_MS = 1_600;

/* Custom drag payload set by the My Library rows. */
const PAPER_DROP_MIME = "application/x-research-paper";

/* Double-click menu */
const MENU_W = 320;

/* Shown when the pet is clicked before any tip has been discovered. */
const INTRO: Tip = {
  id: "__intro__",
  title: "Re:Search Pet",
  body:
    "Hold your cursor on any part of the app and I will explain it. " +
    "Click me to replay the tips you have already found, and keep " +
    "an eye out: six hidden treasures are scattered across the " +
    "pages. Find them all and I become a full help library.",
};

const QUICK_QUESTIONS = [
  "PIPELINES?",
  "TF-IDF?",
  "RANKED SEARCH?",
  "DIVERSIFY?",
  "DUPLICATES?",
  "EVALUATION?",
  "IMPORT?",
  "BATTLE RECORDS?",
];

function readSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeSeen(ids: string[]) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // best-effort
  }
}

interface PetPos {
  right: number;
  bottom: number;
}

/** The pet's on-screen footprint: the draggable box, not the sprite. */
function petBox(size: number): number {
  return size * PET_BOX_RATIO;
}

function readPetPos(size: number): PetPos {
  const box = petBox(size);

  try {
    const raw = window.localStorage.getItem(PET_POS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    if (
      parsed &&
      typeof parsed.right === "number" &&
      typeof parsed.bottom === "number" &&
      Number.isFinite(parsed.right) &&
      Number.isFinite(parsed.bottom)
    ) {
      /* Clamp against the pet's real footprint so a large pet loaded
         from storage cannot start off-screen. */
      return clampPetPos(
        { right: Math.max(0, parsed.right), bottom: Math.max(0, parsed.bottom) },
        box,
      );
    }
  } catch {
    // best-effort
  }

  return {
    right: Math.min(PET_MARGIN, Math.max(0, window.innerWidth - box)),
    bottom: Math.min(PET_MARGIN, Math.max(0, window.innerHeight - box)),
  };
}

function writePetPos(pos: PetPos) {
  try {
    window.localStorage.setItem(PET_POS_KEY, JSON.stringify(pos));
  } catch {
    // best-effort
  }
}

function readPetSize(): number {
  try {
    const raw = window.localStorage.getItem(PET_SIZE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(MIN_PET_SIZE, Math.min(MAX_PET_SIZE, parsed));
    }
  } catch {
    // best-effort
  }
  return DEFAULT_PET_SIZE;
}

function writePetSize(size: number) {
  try {
    window.localStorage.setItem(PET_SIZE_KEY, String(size));
  } catch {
    // best-effort
  }
}

/** Keep the pet fully inside the viewport (right/bottom offsets).
 *  `box` is the pet's on-screen footprint (petBox), not the sprite size. */
function clampPetPos(pos: PetPos, box: number): PetPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  return {
    right: Math.max(0, Math.min(pos.right, Math.max(0, vw - box))),
    bottom: Math.max(0, Math.min(pos.bottom, Math.max(0, vh - box))),
  };
}

/* Daisy particle for the "daisies" Tree of Knowledge cheat. */
function DaisyGlyph() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
      {[0, 72, 144, 216, 288].map((angle) => (
        <circle
          key={angle}
          cx="6"
          cy="2.6"
          r="1.7"
          fill="#ffffff"
          stroke="#adb5bd"
          strokeWidth="0.4"
          transform={`rotate(${angle} 6 6)`}
        />
      ))}
      <circle cx="6" cy="6" r="1.8" fill="#f5b301" stroke="#8a5a2b" strokeWidth="0.4" />
    </svg>
  );
}

export default function PixelPet() {
  // Settings toggle: paperrec_pet_visible must not be "0".
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem("paperrec_pet_visible") === "0";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    function refresh() {
      let next = false;
      try {
        next = window.localStorage.getItem("paperrec_pet_visible") === "0";
      } catch {
        next = false;
      }
      setHidden(next);
    }

    window.addEventListener("paperrec-settings-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("paperrec-settings-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const [open, setOpen] = useState(false);
  const [currentTip, setCurrentTip] = useState<Tip | null>(null);

  const { form, setFormId, chatUnlocked, setChatUnlocked } = usePetForm();

  function toggleChatUnlocked() {
    setChatUnlocked(!chatUnlocked);
  }

  const [seen, setSeen] = useState<string[]>(readSeen);

  /* Mirror of `seen` for stable callbacks (avoids re-creating
     reveal on every render, which would restart the hover engine). */
  const seenRef = useRef(seen);
  useEffect(() => {
    seenRef.current = seen;
  }, [seen]);

  /* Sun bounties follow real progress: tip milestones pay out
     whenever the discovered-tip set changes. */
  useEffect(() => {
    syncProgress(seen.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen]);

  const [hop, setHop] = useState(false);
  const [hovering, setHovering] = useState(false);

  /* Destruction animation state (eat / zap / crumple / burn) and
     its timers — declared up here so the sprite state can play the
     pet's own "review" row while it eats a paper. */
  const [petAnim, setPetAnim] = useState<SlimeAnimationMode | null>(null);
  const petAnimTimerRef = useRef<number | null>(null);
  const destructionTimerRef = useRef<number | null>(null);
  const [dropFx, setDropFx] = useState<{
    mode: DropMode;
    title: string;
  } | null>(null);
  const [coins, setCoins] = useState<number[]>([]);
  const coinId = useRef(0);

  /* Cheat particles: daisies and candy burst out of a disposed
     paper while the matching Tree of Knowledge cheats are armed. */
  const [bursts, setBursts] = useState<
    { id: number; kind: "daisy" | "candy"; x: number }[]
  >([]);
  const burstId = useRef(0);

  const [query, setQuery] = useState("");

  const { found, count, total, complete, reset } = useHunt();
  const { unlocked, updateProgress, bump, reset: resetAchievements } =
    useAchievements();
  const { trackPet, trackAsk, syncProgress, activeCheats } = useSun();

  /* UNLOCKED = everything maxed out. The pet behaves as if the
     hunt were complete and every tip and achievement were earned;
     the player's real progress underneath is untouched. */
  const effectiveComplete = chatUnlocked || complete;
  const effectiveSeen = chatUnlocked ? CORE_TIP_IDS : seen;
  const effectiveSeenSet = new Set(effectiveSeen);

  /* Pet FORMS unlock on real progress only (every treasure found
     or every tip hovered/revealed), or temporarily while the CHAT
     unlock toggle is on. */
  const formsUnlocked =
    chatUnlocked || complete || seen.length >= TIPS.length;

  /* Locked chat reverts the pet to the default form. */
  const effectiveForm = formsUnlocked
    ? form
    : PET_FORMS[0];

  /* --------------------------------------------------------
     Pet menu state (opens on double-click)
     -------------------------------------------------------- */

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);

  function openMenu(event: React.MouseEvent) {
    event.preventDefault();
    setMenuPos({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 40)),
    });
  }

  function closeMenu() {
    setMenuPos(null);
  }

  /* Keep the menu fully visible and clear of the pet — declared
     further down, after petSize/petPos exist (see below). */

  /* --------------------------------------------------------
     Single click vs double click: a single click pets the pet
     after a short delay; if a second click arrives in time,
     the pending pet is cancelled and the menu opens instead.
     -------------------------------------------------------- */

  const clickTimerRef = useRef<number | null>(null);

  function handleClick() {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return;
    }

    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      handlePet();
    }, 250);
  }

  function dock(corner: "tl" | "tr" | "bl" | "br") {
    const leftSide = corner === "tl" || corner === "bl";
    const topSide = corner === "tl" || corner === "tr";
    /* Use the current footprint, not a fixed size, or a large pet
       would dock with most of itself off-screen. */
    const box = petBox(petSize);
    const pos = clampPetPos(
      {
        right: leftSide
          ? Math.max(0, window.innerWidth - box - PET_MARGIN)
          : PET_MARGIN,
        bottom: topSide
          ? Math.max(0, window.innerHeight - box - PET_MARGIN)
          : PET_MARGIN,
      },
      box,
    );
    setPetPos(pos);
    writePetPos(pos);
    closeMenu();
  }

  /* --------------------------------------------------------
     Drag to move: pointer capture on the pet, offsets from the
     viewport's right/bottom edges, clamped + persisted.
     -------------------------------------------------------- */

  const [petSize, setPetSize] = useState<number>(readPetSize);
  /* The box is derived, so it must exist before the position is read:
     the saved position has to be clamped against the real footprint. */
  const petBoxSize = petBox(petSize);
  const [petPos, setPetPos] = useState<PetPos>(() => readPetPos(petSize));

  /* Keep the menu fully visible: after it renders, measure its real
     (transformed) size and pull it back inside the viewport. Then
     push it clear of the pet itself — the pet grows leftward/upward
     from its right/bottom anchor, so without this the character
     disappears behind its own menu as SIZE increases (it looked
     like the sprite wasn't scaling at all). */
  useEffect(() => {
    if (!menuPos) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();

    let next = {
      x: Math.max(8, Math.min(menuPos.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menuPos.y, window.innerHeight - rect.height - 8)),
    };

    /* Pet footprint in viewport space (right/bottom anchored). */
    const box = petBox(petSize);
    const petLeft = window.innerWidth - petPos.right - box;
    const petTop = window.innerHeight - petPos.bottom - box;
    const petRight = petLeft + box;
    const petBottom = petTop + box;
    const GAP = 8;

    const overlaps =
      rect.left < petRight &&
      rect.right > petLeft &&
      rect.top < petBottom &&
      rect.bottom > petTop;

    if (overlaps) {
      /* Candidate escapes: slide the menu away from the pet along
         whichever single axis needs the least movement and still
         lands inside the viewport. */
      const candidates = [
        { x: next.x - (rect.right + GAP - petLeft), y: next.y },
        { x: next.x + (petRight + GAP - rect.left), y: next.y },
        { x: next.x, y: next.y - (rect.bottom + GAP - petTop) },
        { x: next.x, y: next.y + (petBottom + GAP - rect.top) },
      ].filter(
        (c) =>
          c.x >= 8 &&
          c.x <= window.innerWidth - rect.width - 8 &&
          c.y >= 8 &&
          c.y <= window.innerHeight - rect.height - 8,
      );

      if (candidates.length > 0) {
        candidates.sort(
          (a, b) =>
            Math.abs(a.x - menuPos.x) + Math.abs(a.y - menuPos.y) -
            (Math.abs(b.x - menuPos.x) + Math.abs(b.y - menuPos.y)),
        );
        next = candidates[0];
      } else {
        /* No fully clear spot: take the smallest shift, clamped. */
        const left = { x: Math.max(8, next.x - (rect.right + GAP - petLeft)), y: next.y };
        const up = { x: next.x, y: Math.max(8, next.y - (rect.bottom + GAP - petTop)) };
        next =
          Math.abs(left.x - menuPos.x) <= Math.abs(up.y - menuPos.y) ? left : up;
      }
    }

    if (next.x !== menuPos.x || next.y !== menuPos.y) {
      setMenuPos(next);
    }
  }, [menuPos, petSize, petPos]);

  function handlePetSizeChange(next: number) {
    const clamped = Math.max(MIN_PET_SIZE, Math.min(MAX_PET_SIZE, next));
    setPetSize(clamped);
    writePetSize(clamped);
    /* Re-clamp position so the (possibly larger) pet stays on-screen,
       and persist it — otherwise the corrected position is lost on
       reload and the pet starts off-screen again. */
    setPetPos((current) => {
      const next2 = clampPetPos(current, petBox(clamped));
      writePetPos(next2);
      return next2;
    });
  }
  const petPosRef = useRef(petPos);

  useEffect(() => {
    petPosRef.current = petPos;
  }, [petPos]);

  const petSizeRef = useRef(petSize);

  useEffect(() => {
    petSizeRef.current = petSize;
  }, [petSize]);

  const [dragging, setDragging] = useState(false);
  const [dragDir, setDragDir] = useState<"left" | "right">("right");
  const dragActiveRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
  } | null>(null);
  const lastDragXRef = useRef<number | null>(null);
  const lastDragEndRef = useRef(0);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: petPos.right,
      startBottom: petPos.bottom,
    };
    dragActiveRef.current = true;
    lastDragXRef.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    if (!dragging) setDragging(true);

    /* Face the direction of the pointer so the running sprite
       plays the left or right row of the atlas. */
    const lastX = lastDragXRef.current;
    if (lastX !== null) {
      if (event.clientX > lastX + 2) setDragDir("right");
      else if (event.clientX < lastX - 2) setDragDir("left");
    }
    lastDragXRef.current = event.clientX;

    setPetPos(
      clampPetPos(
        { right: drag.startRight - dx, bottom: drag.startBottom - dy },
        petBoxSize,
      ),
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const moved =
      drag !== null &&
      event.pointerId === drag.pointerId &&
      Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      ) >= DRAG_THRESHOLD;

    dragRef.current = null;
    dragActiveRef.current = false;
    setDragging(false);

    if (moved) {
      // Swallow the click that follows a drag.
      lastDragEndRef.current = performance.now();
      writePetPos(petPosRef.current);
      // While the CHAT unlock is on, progress is ephemeral: the
      // drag counter stays put so locking restores it exactly.
      if (!chatUnlocked) {
        bump("drags");
      }
    }
  }

  function handlePointerCancel() {
    dragRef.current = null;
    dragActiveRef.current = false;
    setDragging(false);
  }

  // Re-clamp after window resizes so the pet never ends up
  // off-screen (e.g. the window shrank below the saved position).
  useEffect(() => {
    function handleResize() {
      setPetPos((current) => {
        const clamped = clampPetPos(current, petBox(petSizeRef.current));
        return clamped.right === current.right &&
          clamped.bottom === current.bottom
          ? current
          : clamped;
      });
      /* Re-pull the open menu back into the viewport. */
      setMenuPos((current) => {
        if (!current) return current;
        const menu = menuRef.current;
        if (!menu) return current;
        const rect = menu.getBoundingClientRect();
        const clamped = {
          x: Math.max(8, Math.min(current.x, window.innerWidth - rect.width - 8)),
          y: Math.max(8, Math.min(current.y, window.innerHeight - rect.height - 8)),
        };
        return clamped.x === current.x && clamped.y === current.y
          ? current
          : clamped;
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /* --------------------------------------------------------
     Hover dwell progress (HOVER_DELAY_MS of dwell reveals)
     -------------------------------------------------------- */

  const [hoverTipId, setHoverTipId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const body = currentTip ? currentTip.body : INTRO.body;
  const typed = useTypewriter(body, TIP_SPEED, open && !prefersReducedMotion);
  const shown = open ? (prefersReducedMotion ? body : typed) : "";
  const done = shown.length >= body.length;

  /* --------------------------------------------------------
     Rewards: hop + "+1" coin
     -------------------------------------------------------- */

  const celebrate = useCallback(() => {
    setHop(true);
    window.setTimeout(() => setHop(false), 600);

    const id = coinId.current++;
    setCoins((current) => [...current, id]);
    window.setTimeout(
      () => setCoins((current) => current.filter((c) => c !== id)),
      1000,
    );
  }, []);

  /* Spawn cheat particles (armed via the Sun Shop's cheat words). */
  const spawnBurst = useCallback((kind: "daisy" | "candy", count: number) => {
    const items = Array.from({ length: count }, () => ({
      id: burstId.current++,
      kind,
      x: Math.round(Math.random() * 44 - 22),
    }));

    setBursts((current) => [...current, ...items]);

    const ids = new Set(items.map((item) => item.id));
    window.setTimeout(
      () => setBursts((current) => current.filter((item) => !ids.has(item.id))),
      1400,
    );
  }, []);

  /* "dance" — the pet hops on the spot while the cheat is armed. */
  useEffect(() => {
    if (!activeCheats.includes("dance")) return;

    const id = window.setInterval(() => {
      setHop(true);
      window.setTimeout(() => setHop(false), 600);
    }, 2400);

    return () => window.clearInterval(id);
  }, [activeCheats]);

  /* While dragging, the pet plays the Petdex running animation
     (handled via the sprite `state` prop). While eating a paper it
     plays its own atlas "review" row — the real inspecting frames
     from its sheet — instead of shuffling through other forms. */
  const animState: PetAnimState =
    petAnim === "eat"
      ? "review"
      : hop
        ? "jump"
        : dragging
          ? dragDir === "left"
            ? "run-left"
            : "run-right"
          : hovering
            ? "wave"
            : "idle";

  /* --------------------------------------------------------
     Reveal a tip (from the hover engine)
     -------------------------------------------------------- */

  const reveal = useCallback(
    (id: string) => {
      const tip = TIP_BY_ID[id];
      if (!tip) return;

      // While the CHAT unlock is on every tip is already shown, so
      // hovering must not write real progress — locking would
      // otherwise leave the tips permanently discovered.
      if (chatUnlocked) return;

      setCurrentTip(tip);
      setOpen(true);

      if (!seenRef.current.includes(id)) {
        updateProgress({ seen: seenRef.current.length + 1 });
      }

      setSeen((previous) => {
        if (previous.includes(id)) return previous;
        const next = [...previous, id];
        writeSeen(next);
        return next;
      });

      celebrate();
    },
    [celebrate, chatUnlocked, updateProgress],
  );

  /* --------------------------------------------------------
     Hover engine: dwell on [data-tips] elements
     -------------------------------------------------------- */

  const lastRevealAtRef = useRef(0);

  useEffect(() => {
    let target: Element | null = null;
    let ticker: number | null = null;
    let startedAt = 0;
    let lastLeftAt = 0;

    function stop() {
      if (ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
      target = null;
      lastLeftAt = 0;
      setProgress(0);
      setHoverTipId(null);
    }

    function start(element: Element, resume: boolean) {
      const id = element.getAttribute("data-tips");
      if (!id || !TIP_BY_ID[id]) return;

      // Already-recorded tips need no dwell: they appear instantly.
      // The chat unlock already shows every tip, so it stays as is.
      if (seenRef.current.includes(id) && !chatUnlocked) {
        stop();
        reveal(id);
        return;
      }

      // Post-reveal cooldown: the dwell clock starts when the
      // cooldown ends, so hovering during it simply waits — the
      // pointer does not need to leave and re-enter.
      const cooldownEnd = lastRevealAtRef.current + HOVER_COOLDOWN_MS;

      if (!resume) {
        startedAt = Math.max(Date.now(), cooldownEnd);
        setProgress(0);
      }

      target = element;
      setHoverTipId(id);

      if (ticker === null) {
        ticker = window.setInterval(() => {
          const ratio = Math.max(
            0,
            Math.min(1, (Date.now() - startedAt) / HOVER_DELAY_MS),
          );
          setProgress(ratio);

          if (ratio >= 1) {
            if (ticker !== null) {
              window.clearInterval(ticker);
              ticker = null;
            }
            const revealedId = target?.getAttribute("data-tips") ?? null;
            target = null;
            lastLeftAt = 0;
            lastRevealAtRef.current = Date.now();
            setHoverTipId(null);
            setProgress(0);
            if (revealedId) reveal(revealedId);
          }
        }, TICK_MS);
      }
    }

    function handleOver(event: PointerEvent) {
      if (dragActiveRef.current) return;

      const element = (event.target as Element | null)?.closest?.(
        "[data-tips]",
      );
      if (!element) return;

      const id = element.getAttribute("data-tips");
      if (!id || !TIP_BY_ID[id]) return;

      // Pointer came back to the same element inside the grace
      // window: resume the paused dwell instead of restarting it.
      if (element === target) {
        if (ticker === null && Date.now() - lastLeftAt < HOVER_GRACE_MS) {
          start(element, true);
        }
        return;
      }

      // Moved to a different tip element shortly after leaving the
      // previous one: keep the same dwell clock.
      if (target !== null && Date.now() - lastLeftAt < HOVER_GRACE_MS) {
        start(element, true);
        return;
      }

      stop();
      start(element, false);
    }

    function handleOut(event: PointerEvent) {
      if (!target) return;

      const related = event.relatedTarget as Node | null;

      // Still inside the target (moved between its children).
      if (related && target.contains(related)) return;

      // Pause the dwell; a return within the grace window resumes it.
      lastLeftAt = Date.now();
      if (ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
    }

    window.addEventListener("pointerover", handleOver);
    window.addEventListener("pointerout", handleOut);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);

    return () => {
      stop();
      window.removeEventListener("pointerover", handleOver);
      window.removeEventListener("pointerout", handleOut);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [reveal]);

  /* --------------------------------------------------------
     Escape closes the tip box
     -------------------------------------------------------- */

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        closeMenu();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /* --------------------------------------------------------
     Unlock every core tip (called when the hunt completes)
     -------------------------------------------------------- */

  const unlockAllTips = useCallback(() => {
    const missing = CORE_TIP_IDS.filter(
      (id) => !seenRef.current.includes(id),
    );
    if (missing.length === 0) return;

    const merged = [...seenRef.current, ...missing];
    writeSeen(merged);
    setSeen(merged);
    updateProgress({ seen: merged.length });
  }, [updateProgress]);

  /* --------------------------------------------------------
     Treasure found: celebrate + announce
     -------------------------------------------------------- */

  useEffect(() => {
    function handleFound(event: Event) {
      const id = (event as CustomEvent).detail?.id;
      const item = HUNT_ITEMS.find((candidate) => candidate.id === id);

      // While the CHAT unlock is on the hunt is already complete
      // and every treasure effectively found — collecting during a
      // free-access session must not write real progress.
      if (chatUnlocked) {
        celebrate();
        return;
      }

      celebrate();

      if (!complete) {
        setCurrentTip({
          id: `found-${id ?? "unknown"}`,
          title: item ? item.name : "TREASURE FOUND",
          body:
            `Treasure collected: ${item?.name ?? "?"}! ` +
            `${Math.min(count + 1, total)}/${total}. ` +
            (count + 1 >= total
              ? "that was the last one. The help library is mine to give…"
              : "keep hunting. Click me for a hint."),
        });
      }

      // Last treasure: the pet unlocks its full capabilities —
      // every tip becomes discovered.
      if (count + 1 >= total) {
        unlockAllTips();
      }

      setOpen(true);
      updateProgress({
        treasures: Math.min(count + 1, total),
        treasureTotal: total,
        huntComplete: count + 1 >= total,
      });
    }

    window.addEventListener(HUNT_FOUND_EVENT, handleFound);
    return () => window.removeEventListener(HUNT_FOUND_EVENT, handleFound);
  }, [celebrate, chatUnlocked, count, total, complete, updateProgress, unlockAllTips]);

  /* --------------------------------------------------------
     Achievement unlocked: celebrate + announce
     -------------------------------------------------------- */

  useEffect(() => {
    function handleUnlock(event: Event) {
      const ids = (event as CustomEvent).detail?.ids as string[] | undefined;
      const first = Array.isArray(ids) ? ids[0] : undefined;
      const achievement = ACHIEVEMENTS.find(
        (candidate) => candidate.id === first,
      );

      celebrate();

      if (achievement) {
        setCurrentTip({
          id: `achievement-${achievement.id}`,
          title: "ACHIEVEMENT UNLOCKED",
          body: `"${achievement.name}": ${achievement.description}`,
        });
      }

      setOpen(true);
    }

    window.addEventListener(ACHIEVEMENT_UNLOCKED_EVENT, handleUnlock);
    return () =>
      window.removeEventListener(ACHIEVEMENT_UNLOCKED_EVENT, handleUnlock);
  }, [celebrate]);

  /* --------------------------------------------------------
     Pet menu: close on outside click / right-click
     -------------------------------------------------------- */

  useEffect(() => {
    if (!menuPos) return;

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    }

    function handleContextMenu(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [menuPos]);

  /* --------------------------------------------------------
     Click: open, then cycle through what's available
     -------------------------------------------------------- */

  function nextTreasureHint(): Tip | null {
    const missing = HUNT_ITEMS.find((item) => !found.includes(item.id));
    if (!missing) return null;

    return {
      id: `hint-${missing.id}`,
      title: "TREASURE HINT",
      body: `"${missing.name}" is hiding on the ${missing.page} page — ${missing.hint}.`,
    };
  }

  function nextDiscoveredTip(): Tip {
    const discovered = TIPS.filter((tip) => effectiveSeenSet.has(tip.id));
    const hint = effectiveComplete ? null : nextTreasureHint();

    const pool: Tip[] = [
      ...discovered,
      ...(complete ? EXTRA_TIPS : []),
      ...(hint ? [hint] : []),
    ];

    if (pool.length === 0) return INTRO;

    const index = currentTip
      ? pool.findIndex((tip) => tip.id === currentTip.id)
      : -1;

    return pool[(index + 1) % pool.length];
  }

  function handlePet() {
    // Swallow the click that immediately follows a drag.
    if (performance.now() - lastDragEndRef.current < 300) {
      lastDragEndRef.current = 0;
      return;
    }

    celebrate();
    // Sun is earned from real interactions regardless of the
    // unlocked preview state; the daily caps keep it fair.
    trackPet();
    // Ephemeral while unlocked: clicking during a free-access
    // session must not advance the real click counter.
    if (!chatUnlocked) {
      bump("clicks");
    }

    if (!open) {
      setCurrentTip(currentTip ?? nextDiscoveredTip());
      setOpen(true);
      return;
    }

    if (done) {
      setCurrentTip(nextDiscoveredTip());
    } else {
      // Clicking while the panel is still typing: close it instead
      // of doing nothing, so the click never feels blocked.
      setOpen(false);
    }
  }

  function handleClose() {
    setOpen(false);
  }

  /* --------------------------------------------------------
     Chat: answer a question from the help library
     -------------------------------------------------------- */

  function ask(raw: string) {
    const question = raw.trim();
    if (!question) return;

    const answer = answerQuestion(question);
    const title = answer.title;
    const body = answer.body;

    setCurrentTip({
      id: `ask-${question.slice(0, 40)}`,
      title,
      body,
    });
    setOpen(true);
    setQuery("");
    // Every question earns sun (daily cap), even in the unlocked
    // preview; the achievement counter below stays real-only.
    trackAsk();
    // Ephemeral while unlocked: asks during a free-access session
    // do not advance the real ask counter.
    if (!chatUnlocked) {
      bump("asks");
    }
  }

  function handleReset() {
    reset();
    resetAchievements();
    setSeen([]);
    writeSeen([]);
    setCurrentTip(null);
    setOpen(false);
    /* Zero every cheat and the pet's lifetime progress: the cheat
       ladder (unlocked, armed, and announced words), the petting
       counter, and the chat unlock, all back to the start. */
    try {
      const KEY = "paperrec_sun";
      const state = JSON.parse(
        window.localStorage.getItem(KEY) ?? "{}",
      );
      state.cheats = [];
      state.activeCheats = [];
      state.announcedCheats = [];
      state.pets = 0;
      window.localStorage.setItem(KEY, JSON.stringify(state));
      window.dispatchEvent(new Event("storage"));
    } catch {
      // best-effort
    }
    try {
      window.localStorage.setItem("paperrec_pet_chat_unlocked", "0");
    } catch {
      // best-effort
    }
  }

  const charging = hoverTipId !== null && progress > 0;

  /* --------------------------------------------------------
     Pet speech: short conversational lines float above the pet
     (replacing the plain treasure counter). The pet sometimes
     speaks Japanese characters and translates the line.
     -------------------------------------------------------- */

  const [speechIndex, setSpeechIndex] = useState(0);

  /* Chat-driven lines: while you talk to the research chat it tells
     us what just happened (thinking / answered / fallback / error)
     and the conversation's topic. The line is composed from a Markov
     chain trained on THIS form's own lines, so it stays in character,
     and it shows for a few seconds ahead of the idle chatter. */
  const chatChain = useMemo(
    () => buildChain(getPetCorpus(effectiveForm.variant)),
    [effectiveForm.variant],
  );
  const chatChainRef = useRef(chatChain);
  chatChainRef.current = chatChain;

  const [chatLine, setChatLine] = useState<{
    text: string;
    key: number;
  } | null>(null);

  useEffect(() => {
    function handleChat(event: Event) {
      const context = (event as CustomEvent).detail as
        | PetChatContext
        | undefined;

      if (!context?.kind) return;

      setChatLine({
        text: composeChatLine(chatChainRef.current, context, Math.random),
        key: Date.now(),
      });
    }

    window.addEventListener(PET_CHAT_EVENT, handleChat);
    return () => window.removeEventListener(PET_CHAT_EVENT, handleChat);
  }, []);

  useEffect(() => {
    if (!chatLine) return;

    const id = window.setTimeout(() => setChatLine(null), 7_000);
    return () => window.clearTimeout(id);
  }, [chatLine]);


  /* --------------------------------------------------------
     Paper drops: a library paper dragged onto the pet gets
     destroyed with the current form's signature power — the
     slime forms eat it, the others zap / crumple / burn it —
     and is deleted from the library. Pure visual flair.
     -------------------------------------------------------- */

  const [petHungry, setPetHungry] = useState(false);
  /* The bubble rests after speaking, like the tree: every spoken
     line auto-closes on a random cooldown between 4 and 7 s, then
     the next line rings it back. */
  const [speechMuted, setSpeechMuted] = useState(false);
  const speechKey =
    dropFx?.mode ??
    petAnim ??
    (petHungry
      ? "hungry"
      : chatLine
        ? `chat-${chatLine.key}`
        : speechIndex);

  const speechLines = getPetLines(count, total, effectiveComplete, form.variant);
  const speechLine = speechLines[speechIndex % speechLines.length];

  /* The bubble speaks the hungry line while a paper hovers over
     the pet, the destruction line while one is being disposed
     of or the pet reacts to an action, and the cycling line
     otherwise. All three speak as the CURRENT form. */
  const activeSpeech = petHungry
    ? getHungryLine(effectiveForm.variant)
    : dropFx
      ? getDestructionLine(dropFx.mode, effectiveForm.variant)
      : petAnim
        ? getDestructionLine(petAnim, effectiveForm.variant)
        : chatLine
          ? { en: chatLine.text }
          : speechLine;

  useEffect(() => {
    // No idle talk while the user is interacting with the pet:
    // hovering or dragging it, opening its menu, or dwelling on
    // a tips target.
    if (
      open ||
      charging ||
      dropFx ||
      hovering ||
      dragging ||
      menuPos !== null ||
      hoverTipId !== null
    ) {
      return;
    }

    const id = window.setInterval(() => {
      setSpeechIndex((index) => index + 1);
    }, 6_000);

    return () => window.clearInterval(id);
  }, [
    open,
    charging,
    dropFx,
    hovering,
    dragging,
    menuPos,
    hoverTipId,
    speechLines.length,
  ]);

  /* The same cooldown as the Tree of Knowledge: a line is spoken,
     then the bubble rests for a random 4-7 s before the next one. */
  useEffect(() => {
    setSpeechMuted(false);
    if (open || charging) return;
    const delay = 4000 + Math.floor(Math.random() * 3000);
    const id = window.setTimeout(() => setSpeechMuted(true), delay);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechKey, open, charging, dropFx, petAnim, petHungry]);

  function handleDragOver(event: React.DragEvent) {
    if (!event.dataTransfer.types.includes(PAPER_DROP_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setPetHungry(true);
  }

  function handleDragLeave() {
    setPetHungry(false);
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setPetHungry(false);

    const raw = event.dataTransfer.getData(PAPER_DROP_MIME);
    if (!raw) return;

    let paper: { id: number; title?: string } | null = null;
    try {
      paper = JSON.parse(raw);
    } catch {
      return;
    }
    if (!paper || typeof paper.id !== "number") return;

    /* The current form picks how to dispose of the paper: only
       the slime forms eat it; every other character answers
       with its signature power (Gojo zaps, Glaucira burns…). */
    const mode = getDropMode(effectiveForm.variant);

    setDropFx({ mode, title: paper.title ?? `Paper #${paper.id}` });
    celebrate();

    if (activeCheats.includes("daisies")) spawnBurst("daisy", 3);
    if (activeCheats.includes("pinata")) spawnBurst("candy", 5);

    /* The body plays the power too, so the character visibly
       casts rather than only the paper chip reacting. */
    if (petAnimTimerRef.current !== null) {
      window.clearTimeout(petAnimTimerRef.current);
    }
    setPetAnim(mode);
    petAnimTimerRef.current = window.setTimeout(() => {
      setPetAnim(null);
    }, 1_000);

    if (destructionTimerRef.current !== null) {
      window.clearTimeout(destructionTimerRef.current);
    }
    destructionTimerRef.current = window.setTimeout(() => {
      setDropFx(null);
    }, DESTRUCTION_MS);

    try {
      await removeFromLibrary(paper.id);
    } catch {
      // The show must go on even if the deletion fails — the
      // library row will simply reappear on the next load.
    }
  }

  useEffect(() => {
    return () => {
      if (destructionTimerRef.current !== null) {
        window.clearTimeout(destructionTimerRef.current);
      }
    };
  }, []);

  /* --------------------------------------------------------
     Event-driven reactions: any action (search, upload, delete,
     battle) can dispatch SLIME_ANIMATION_EVENT and the pet plays
     the mode on itself with its speech line.
     -------------------------------------------------------- */

  useEffect(() => {
    function handleSlimeAnimation(event: Event) {
      const mode = (event as CustomEvent).detail?.mode as
        | SlimeAnimationMode
        | undefined;

      if (!mode) return;

      if (petAnimTimerRef.current !== null) {
        window.clearTimeout(petAnimTimerRef.current);
      }

      setPetAnim(mode);
      celebrate();

      petAnimTimerRef.current = window.setTimeout(() => {
        setPetAnim(null);
      }, 1_000);
    }

    window.addEventListener(SLIME_ANIMATION_EVENT, handleSlimeAnimation);
    return () => {
      window.removeEventListener(SLIME_ANIMATION_EVENT, handleSlimeAnimation);
      if (petAnimTimerRef.current !== null) {
        window.clearTimeout(petAnimTimerRef.current);
      }
    };
  }, [celebrate]);

  /* --------------------------------------------------------
     Tooltip flips to stay on screen next to a dragged pet:
     - flipX: not enough room to the left -> tooltip aligns
       to the pet's left edge instead of its right edge.
     - flipY: not enough room above -> tooltip drops below
       the pet (tail flips to point up).
     -------------------------------------------------------- */

  /* Both bubbles measure against the pet's real footprint, so a 208px
     pet flips them the same way a 48px pet does. */
  const flipX = open && petPos.right > window.innerWidth - TOOLTIP_W;
  const flipY =
    open &&
    petPos.bottom >
      window.innerHeight - petBoxSize - TOOLTIP_GAP - TOOLTIP_H;

  /* Speech bubble flips the same way, against its own size:
     - speechFlipX: not enough room to the left of the pet ->
       the bubble aligns to the pet's left edge and grows right.
     - speechFlipY: not enough room above -> the bubble drops
       below the pet and its tail flips to point up. */
  const speechFlipX = petPos.right > window.innerWidth - BUBBLE_W;
  const speechFlipY =
    petPos.bottom >
    window.innerHeight - petBoxSize - BUBBLE_GAP - BUBBLE_H;

  /* ============================================================
     RENDER
     ============================================================ */

  if (hidden) {
    return null;
  }

  return (
    <div
      className="fixed z-[9980]"
      style={{ right: petPos.right, bottom: petPos.bottom }}
      data-drop-zone="pet"
      data-drop-label="Remove from library"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Anchor box tracks the pet's real footprint, so the tooltip,
          speech bubble and FX stay pinned to the pet at any size. */}
      <div
        className="relative"
        style={{ width: petBoxSize, height: petBoxSize }}
      >
        {/* ----------------------------------------------------
            RPG-style tooltip box
            ---------------------------------------------------- */}

        {open && (
          <div
            className={`animate-step-in absolute z-30 max-h-80 w-72 max-w-[80vw] overflow-y-auto rounded border-[3px] border-gray-900 bg-gray-900 p-4 text-onInk ${
              flipY ? "top-full mt-3" : "bottom-full mb-3"
            } ${flipX ? "left-0" : "right-0"}`}
          >
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-xs font-bold tracking-[0.2em] text-accent">
              {(currentTip ? currentTip.title : INTRO.title)
                .toUpperCase()
                .slice(0, 26)}
            </p>

            <button
              type="button"
              onClick={handleClose}
              aria-label="Close tip"
              className="rounded border-2 border-gray-700 px-1.5 py-0.5 font-mono text-xs font-bold text-onInk transition-colors pixel-ease hover:border-white hover:bg-white hover:text-gray-900"
            >
              <CloseX className="h-3 w-3" />
            </button>
          </div>

          <p className="min-h-16 font-mono text-xs leading-5 text-onInk">
            {shown}
            <BlockCursor className="animate-blink ml-0.5 inline-block h-[0.9em] w-[0.55em] text-accent" />
          </p>

          {done && (
            <p className="mt-2 flex items-center justify-between gap-2 text-right font-mono text-xs font-bold tracking-[0.2em] text-accent">
              <span>
                {effectiveComplete
                  ? "HELP LIBRARY"
                  : `FOUND ${effectiveSeen.length}/${TIPS.length}`}
              </span>
              <span className="animate-blink flex items-center gap-1.5">
                <ArrowDown className="h-2.5 w-2.5" />
                CLICK PET TO CONTINUE
              </span>
            </p>
          )}

          {/* Chat input — normally after the hunt is complete; the
              menu's CHAT toggle (paperrec_pet_chat_unlocked)
              opens it right away */}
          {(effectiveComplete) && (
            <div className="mt-2 border-t-2 border-gray-700 pt-2">
              <div className="mb-1.5 flex flex-wrap gap-1">
                {QUICK_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => ask(question)}
                    className="rounded border-2 border-gray-700 px-1.5 py-0.5 font-mono text-xs font-bold text-onInk transition-colors pixel-ease hover:border-accent hover:text-accent"
                  >
                    {question}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  ask(query);
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="ASK THE PET…"
                  aria-label="Ask the pet"
                  className="min-w-0 flex-1 rounded border-2 border-gray-700 bg-black/40 px-2 py-1 font-mono text-xs text-onInk placeholder:text-gray-500 focus:border-accent focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!query.trim()}
                  className="rounded border-2 border-gray-700 px-2 py-1 font-mono text-xs font-bold text-onInk transition-colors pixel-ease hover:border-accent hover:bg-accent hover:text-gray-900 disabled:opacity-40"
                >
                  ASK
                </button>
              </form>

              <button
                type="button"
                onClick={handleReset}
                className="mt-1.5 font-mono text-xs font-bold tracking-[0.2em] text-gray-500 transition-colors pixel-ease hover:text-accent"
              >
                RESET PROGRESS
              </button>
            </div>
          )}

          {/* speech tail pointing at the pet */}
          <div
            className={`absolute h-4 w-4 rotate-45 border-gray-900 bg-gray-900 ${
              flipY
                ? "-top-[11px] border-t-[3px] border-l-[3px]"
                : "-bottom-[11px] border-b-[3px] border-r-[3px]"
            } ${flipX ? "left-9" : "right-9"}`}
            aria-hidden="true"
          />
        </div>
      )}

      {/* ----------------------------------------------------
          The pet itself (+ dwell charge + hunt progress)
          ---------------------------------------------------- */}

      {/* ----------------------------------------------------
          Pet speech bubble (short conversational line;
          pauses while a tip box or dwell ring is up)
          ---------------------------------------------------- */}

      {!open && !charging && !speechMuted && (
          <div
            key={
              dropFx
                ? dropFx.mode
                : petAnim ?? (chatLine ? `chat-${chatLine.key}` : speechIndex)
            }
            className={`animate-pop-in absolute z-20 max-w-[min(220px,calc(100vw-40px))] rounded border-[3px] border-gray-900 bg-white px-2 py-1 font-mono text-xs leading-4 text-ink ${
              speechFlipY ? "top-full mt-2" : "bottom-full mb-2"
            } ${speechFlipX ? "left-0" : "right-0"}`}
          >
            {activeSpeech.jp && (
              <>
                <span className="font-bold text-accent">{activeSpeech.jp}</span>{" "}
              </>
            )}
            <span>{activeSpeech.en}</span>
            <span
              aria-hidden="true"
              className={`absolute h-3 w-3 rotate-45 border-gray-900 bg-white ${
                speechFlipY
                  ? "-top-[7px] border-t-[3px] border-l-[3px]"
                  : "-bottom-[7px] border-b-[3px] border-r-[3px]"
              } ${speechFlipX ? "left-5" : "right-5"}`}
            />
          </div>
        )}

        {/* ----------------------------------------------------
            Paper destruction FX — the dropped library paper as
            a chip that gets zapped / eaten / crumpled / burned.
            ---------------------------------------------------- */}

        {dropFx && (
          <div className="pointer-events-none absolute -top-10 left-1/2 z-30 -translate-x-1/2">
            {dropFx.mode === "crumple" ? (
              <CrumpledPaper className="drop-fx-chip drop-fx-crumple block" />
            ) : (
              <span
                className={`drop-fx-chip drop-fx-${dropFx.mode} block max-w-[200px] truncate rounded border-[3px] border-gray-900 bg-white px-2 py-1 font-mono text-xs font-bold text-ink`}
              >
                {dropFx.title}
              </span>
            )}
          </div>
        )}

        {charging && (
          <>
            <span className="absolute -top-7 right-0 z-20 whitespace-nowrap rounded border-[3px] border-gray-900 bg-white px-2 py-0.5 font-mono text-xs font-bold tracking-[0.15em] text-ink">
              TIP {Math.round(progress * 100)}%
            </span>

            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              /* Scales with the pet so the charge ring always
                 circumscribes it. */
              style={{ width: petBoxSize * 1.1, height: petBoxSize * 1.1 }}
              className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 -rotate-90"
            >
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                className="fill-none stroke-gray-200"
                strokeWidth="5"
              />
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                className="fill-none stroke-accent"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={
                  RING_CIRCUMFERENCE * (1 - Math.max(progress, 0.001))
                }
              />
            </svg>
          </>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-label="Click the Re:Search pet for a tip (drag to move, double-click for menu)"
          onClick={handleClick}
          onDoubleClick={openMenu}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handlePet();
            }
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          className={`group relative flex touch-none select-none items-end justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gray-900 ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
          style={{ width: petBoxSize, height: petBoxSize }}
        >
          {/* coins popped on petting / discovery */}
          {coins.map((id) => (
            <span
              key={id}
              aria-hidden="true"
              className="animate-coin-pop pointer-events-none absolute -top-1 right-1 z-30 font-mono text-xs font-bold text-accent"
            >
              +1
            </span>
          ))}

          {/* cheat particles: daisies / candy from eaten papers */}
          {bursts.map((burst) => (
            <span
              key={burst.id}
              aria-hidden="true"
              className="animate-coin-pop pointer-events-none absolute -top-2 z-30"
              style={{ left: `calc(50% + ${burst.x}px)` }}
            >
              {burst.kind === "candy" ? (
                <span className="block h-2.5 w-2.5 rotate-45 border border-gray-900 bg-[#f06595]" />
              ) : (
                <DaisyGlyph />
              )}
            </span>
          ))}

          {/* shadow — scales with the pet */}
          <span
            aria-hidden="true"
            className="pet-shadow absolute bottom-1 rounded-full bg-gray-900/25"
            style={{
              height: Math.max(6, petSize * 0.0625),
              width: Math.max(20, petSize * 0.83),
            }}
          />

          {/* body — hungry (paper dragged over) opens wide; the
              power animations (zap/eat/crumple/burn) play on the
              body for thrown papers and app events alike */}
          <div
            className={`pet-bob relative z-10 ${hop ? "pet-hop" : ""}`}
          >
            <div className={petAnim ? `pet-anim-${petAnim}` : "pet-bounce"}>
{/* Sized to the sprite's own 192×208 ratio so the hungry ring
                hugs the pet at every size. */}
              <div
                className={`flex items-center justify-center transition-transform duration-100 pixel-ease ${
                  petHungry
                    ? "scale-110"
                    : dragging
                      ? ""
                      : "group-hover:scale-110 group-focus-visible:scale-110"
                }`}
                style={{
                  width: petSize * (192 / 208),
                  height: petSize,
                }}
              >
                {/* Drag-delete boundary: translucent dashed ring
                    marching around the pet while a paper hovers
                    over it */}
                {petHungry && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 100 100"
                    className="pet-hungry-ring pointer-events-none absolute -inset-1.5 h-auto w-auto"
                  >
                    <circle
                      cx="50"
                      cy="50"
                      r="47"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeDasharray="12 9"
                      strokeLinecap="round"
                    />
                  </svg>
                )}

                <PetBlob
                  variant={effectiveForm.variant}
                  size={petSize}
                  hungry={petHungry}
                  state={animState}
                  className="drop-shadow-[1px_2px_0_rgba(0,0,0,0.15)]"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------
          Right-click menu: quick actions + achievements
          ---------------------------------------------------- */}

      {menuPos && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-80 select-none rounded border-[3px] border-gray-900 bg-white p-2 font-mono text-sm text-ink"
          style={{ left: menuPos.x, top: menuPos.y, transform: "scale(0.75)", transformOrigin: "top left" }}
        >
          <p className="px-2 pb-1.5 font-bold tracking-[0.25em] text-accent">
            PET MENU
          </p>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              handlePet();
              closeMenu();
            }}
            className="block w-full rounded border-2 border-gray-900 bg-surface px-2 py-1.5 text-left font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
          >
            NEXT TIP
          </button>

          <div className="mt-2 border-t-2 border-gray-200 px-2 pt-1.5">
            <p className="flex items-center justify-between font-bold tracking-[0.15em] text-muted">
              <span>ACHIEVEMENTS</span>
              <span className="text-accent">
                {chatUnlocked
                  ? ACHIEVEMENTS.length
                  : unlocked.length}
                /{ACHIEVEMENTS.length}
              </span>
            </p>
          </div>

          <div className="max-h-[45vh] overflow-y-auto py-1">
            {ACHIEVEMENTS.map((achievement) => {
              const got =
                chatUnlocked || unlocked.includes(achievement.id);

              return (
                <div
                  key={achievement.id}
                  className={`flex items-start gap-2 px-2 py-1.5 ${
                    got ? "" : "opacity-45"
                  }`}
                >
                  {got ? (
                    <Star className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  ) : (
                    <Diamond className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  )}
                  <div className="min-w-0">
                    <p
                      className={`font-bold leading-4 ${
                        got ? "text-ink" : "text-muted"
                      }`}
                    >
                      {achievement.name}
                    </p>
                    <p className="mt-0.5 text-sm leading-4 text-muted">
                      {achievement.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-1 border-t-2 border-gray-200 px-2 pt-1.5">
            <p className="mb-1 font-bold tracking-[0.15em] text-muted">
              CHAT
            </p>
            <button
              type="button"
              role="menuitem"
              aria-pressed={chatUnlocked}
              onClick={toggleChatUnlocked}
              title={
                chatUnlocked
                  ? "Help library opens without the hunt."
                  : "Help library stays locked until all treasures are found."
              }
              className={`flex w-full items-center justify-between rounded border-2 border-gray-900 px-2 py-1.5 transition-colors pixel-ease ${
                chatUnlocked
                  ? "bg-accent text-onAccent"
                  : "bg-surface text-ink hover:bg-accentSoft"
              }`}
            >
              <span className="text-sm font-bold">
                {chatUnlocked ? "UNLOCKED" : "LOCKED"}
              </span>
              <span className="font-mono text-xs tracking-[0.15em]">
                {chatUnlocked ? "FREE ACCESS" : "HUNT ONLY"}
              </span>
            </button>
          </div>

          <div className="mt-1 border-t-2 border-gray-200 px-2 pt-1.5">
            <p className="mb-1 font-bold tracking-[0.15em] text-muted">
              DOCK
            </p>
            <div className="grid grid-cols-4 gap-1">
              {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  role="menuitem"
                  onClick={() => dock(corner)}
                  className="rounded border-2 border-gray-900 bg-surface px-1 py-1 text-center font-mono text-sm font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
                >
                  {corner.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

<div className="mt-1 border-t-2 border-gray-200 px-2 pt-1.5">
            <p className="mb-1 flex items-center justify-between font-bold tracking-[0.15em] text-muted">
              <span>SIZE</span>
              <span className="text-accent">{petSize}px</span>
            </p>
            <input
              type="range"
              min={MIN_PET_SIZE}
              max={MAX_PET_SIZE}
              step={4}
              value={petSize}
              onChange={(event) =>
                handlePetSizeChange(Number.parseInt(event.target.value, 10))
              }
              aria-label="Pet size"
              className="w-full accent-gray-900"
            />
            <p className="mt-0.5 text-center font-mono text-xs text-muted">
              {petSize === MAX_PET_SIZE
                ? "NATIVE 192×208"
                : petSize >= DEFAULT_PET_SIZE
                  ? `${Math.round(petSize * (192 / 208))}×${petSize}`
                  : "UP TO ORIGINAL DIMENSIONS"}
            </p>
          </div>

          <div className="mt-1 border-t-2 border-gray-200 px-2 pt-1.5">
            <p className="mb-1 flex items-center justify-between font-bold tracking-[0.15em] text-muted">
              <span>FORM</span>
              {formsUnlocked ? (
                <span className="text-accent">{effectiveForm.name}</span>
              ) : (
                <span className="text-muted">LOCKED</span>
              )}
            </p>

            {formsUnlocked ? (
              <div className="grid grid-cols-5 gap-1">
                {PET_FORMS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="menuitem"
                    title={candidate.blurb}
                    aria-pressed={form.id === candidate.id}
                    onClick={() => setFormId(candidate.id)}
                    className={`flex h-10 items-center justify-center rounded border-2 border-gray-900 transition-colors pixel-ease ${
                      form.id === candidate.id
                        ? "bg-accentSoft"
                        : "bg-surface hover:bg-accentSoft"
                    }`}
                  >
                    <PetBlob variant={candidate.variant} size={30} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded border-2 border-gray-900 bg-canvas px-2 py-2 text-center">
                <p className="font-mono text-xs font-bold tracking-[0.15em] text-muted">
                  FIND ALL 6 TREASURES OR HOVER EVERY TIP
                </p>
                <p className="mt-1 font-mono text-sm text-muted">
                  Tips hovered: {seen.length}/{TIPS.length}
                </p>
              </div>
            )}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              handleReset();
              closeMenu();
            }}
            className="mt-2 block w-full rounded border-2 border-gray-900 bg-surface px-2 py-1.5 text-left font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
          >
            RESET PROGRESS
          </button>
        </div>
      )}
    </div>
  );
}
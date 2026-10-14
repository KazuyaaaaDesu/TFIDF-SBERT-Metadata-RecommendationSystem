/* ============================================================
   SUN — the Tree of Knowledge's shop economy and wisdom.

   Sun tokens are earned by playing (no purchases, no backend):
   a daily visit bonus, petting the companion, asking the help
   library, and one-time bounties for treasures, achievements,
   and tip milestones. Daily pet/question earnings are capped so
   the currency always comes from play, never from grinding.

   Fertilizer bought in the Sun Shop goes into a hold and is applied
   to the planted tree's own bed. Each packet adds 2 growth points;
   the height in feet follows the species' stage table (see
   treeHeightByFertilizer), not a flat amount per packet. At 250,
   450, 650, 850 and 1000 feet the tree unlocks a charm word; any
   other feeding speaks a stage line or a progress line.

   What the tree says on a feeding is deterministic: every sentence
   is stored and rotated, so nothing is invented.
   ============================================================ */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useHunt } from "./hunt";
import { useAchievements } from "./achievements";

const SPECIES_KEY_CHEAT = "paperrec_knowledge_species";

/** Each tree offers its own three cheat words. */
function currentCheatSet(): { word: string; effect: string }[] {
  try {
    const id = window.localStorage.getItem(SPECIES_KEY_CHEAT);
    if (id && CHEAT_SETS[id as TreeSpeciesId]) {
      return CHEAT_SETS[id as TreeSpeciesId];
    }
  } catch {
    // best-effort
  }
  return CHEAT_SETS.oak;
}

const STORAGE_KEY = "paperrec_sun";
const SEEN_TIPS_KEY = "paperrec_tips_seen";

/** TEMPORARY dev override: unlock My Library PRO without growing a
 *  tree. Remove when the PRO feature's real unlock is final. */
export const PRO_OVERRIDE_KEY = "paperrec_pro_override_temp";

function readProOverride(): boolean {
  try {
    return window.localStorage.getItem(PRO_OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

import { cheatsCrossed } from "../utils/gardenMilestones";
import { isPresentationStored } from "../utils/presentation";
import { applyProPack } from "../utils/proPack";
import { addOwnedSkin, readOwnedSkins } from "./skins";
import {
  CHEAT_HEIGHTS,
  CHEAT_SETS,
  DEFAULT_SPECIES,
  PROGRESS_LINES,
  SPECIES_STAGE_FERT,
  SPECIES_STAGE_LINES,
  TREE_SPECIES,
  treeHeightByFertilizer,
  treeStageIndex,
  type TreeSpeciesId,
} from "../data/knowledge";

export const DAILY_BONUS = 10;
export const PETS_PER_SUN = 10;
export const PET_SUN_CAP = 5;
export const ASK_SUN_CAP = 5;
export const TREASURE_BOUNTY = 5;
export const ACHIEVEMENT_BOUNTY = 5;
export const TIPS_PER_BOUNTY = 5;
export const TIP_BOUNTY = 2;
export const GROWTH_PER_FERTILIZER = 2;

export interface FertilizerScale {
  count: number;
  currency: "sun" | "tokens";
  price: number;
}

/* Sun is the expensive currency; tree tokens are cheaper. Purchases
   credit the fertilizer HOLD — nothing fertilizes the tree until it
   is applied (the drag). */
export const SUN_PRICE_PER_FERTILIZER = 20;
export const TREE_TOKEN_PRICE_PER_FERTILIZER = 5;

export const FERTILIZER_SCALES: FertilizerScale[] = [
  { count: 10, currency: "sun" },
  { count: 20, currency: "tokens" },
  { count: 100, currency: "sun" },
  { count: 1000, currency: "tokens" },
  { count: 10000, currency: "sun" },
].map((scale) => ({
  ...scale,
  price:
    scale.count *
    (scale.currency === "sun"
      ? SUN_PRICE_PER_FERTILIZER
      : TREE_TOKEN_PRICE_PER_FERTILIZER),
})) as FertilizerScale[];

export interface CheatMilestone {
  height: number;
  word: string;
  effect: string;
}

interface SunState {
  balance: number;
  /** Total sun spent on fertilizer (drives tree growth). */
  spent: number;
  /** The planted species; each tree grows its own garden bed. */
  species: TreeSpeciesId;
  /** Growth per species — every tree levels up separately. */
  gardenProgress: Record<TreeSpeciesId, number>;
  /** The active tree's fertilizer count (mirrored from the bed). */
  fertilizer: number;
  /** Growth tokens: the Skin Shop currency. */
  tokens: number;
  /** Purchased-but-unapplied fertilizer, ready to drag onto the tree. */
  fertilizerHold: number;
  /** Grant registry keys: "once:<key>" or "daily:<day>:<key>". */
  tokenGrants: string[];
  /** Calendar day (UTC) the daily counters belong to. */
  day: string;
  /** Pets accumulated toward the next +1 sun. */
  pets: number;
  petsPaidToday: number;
  asksPaidToday: number;
  claimedTreasures: string[];
  claimedAchievements: string[];
  /** Sun already paid for tip milestones. */
  tipBounties: number;
  /** Tips discovered (mirrored here so height can include them). */
  tipsSeen: number;
  /** How many garden tips have been dispensed. */
  gardenTips: number;
  /** Cheat words unlocked by height. */
  cheats: string[];
  /** Cheat words armed by the user. */
  activeCheats: string[];
  /** Cheat words whose "bloomed" notice already fired — a cheat
      is announced once, ever, no matter how many times the tree
      re-crosses the milestone. */
  announcedCheats: string[];
  /** The simulated Pro Pack was "bought" (granted once, ever). */
  proPurchased: boolean;
}

/** Every species starts with an empty bed. */
function emptyProgress(): Record<TreeSpeciesId, number> {
  return Object.fromEntries(
    TREE_SPECIES.map((entry) => [entry.id, 0]),
  ) as Record<TreeSpeciesId, number>;
}

const EMPTY_STATE: SunState = {
  balance: 0,
  spent: 0,
  species: DEFAULT_SPECIES,
  gardenProgress: emptyProgress(),
  fertilizer: 0,
  tokens: 0,
  fertilizerHold: 0,
  tokenGrants: [],
  day: "",
  pets: 0,
  petsPaidToday: 0,
  asksPaidToday: 0,
  claimedTreasures: [],
  claimedAchievements: [],
  tipBounties: 0,
  tipsSeen: 0,
  gardenTips: 0,
  cheats: [],
  activeCheats: [],
  announcedCheats: [],
  proPurchased: false,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readState(): SunState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;

    const parsed = JSON.parse(raw) as Partial<SunState>;
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];

    const species = (
      parsed.species &&
      TREE_SPECIES.some((entry) => entry.id === parsed.species)
    )
      ? (parsed.species as TreeSpeciesId)
      : DEFAULT_SPECIES;

    const fertilizer = Number(parsed.fertilizer) || 0;
    const savedBeds = (parsed as { gardenProgress?: Record<string, unknown> }).gardenProgress;
    const gardenProgress = Object.fromEntries(
      TREE_SPECIES.map((entry) => [entry.id, Number(savedBeds?.[entry.id]) || 0]),
    ) as Record<TreeSpeciesId, number>;

    /* Legacy saves: lift the old single count into the planted tree. */
    if (
      gardenProgress[species] === 0 &&
      Object.values(gardenProgress).every((v) => v === 0) &&
      fertilizer > 0
    ) {
      gardenProgress[species] = fertilizer;
    }

    return {
      balance: Number(parsed.balance) || 0,
      spent: Number(parsed.spent) || 0,
      species,
      gardenProgress,
      fertilizer: gardenProgress[species],
      tokens: Number(parsed.tokens) || 0,
      fertilizerHold: Number(parsed.fertilizerHold) || 0,
      tokenGrants: strings(parsed.tokenGrants),
      day: typeof parsed.day === "string" ? parsed.day : "",
      pets: Number(parsed.pets) || 0,
      petsPaidToday: Number(parsed.petsPaidToday) || 0,
      asksPaidToday: Number(parsed.asksPaidToday) || 0,
      claimedTreasures: strings(parsed.claimedTreasures),
      claimedAchievements: strings(parsed.claimedAchievements),
      tipBounties: Number(parsed.tipBounties) || 0,
      tipsSeen: Number(parsed.tipsSeen) || 0,
      gardenTips: Number(parsed.gardenTips) || 0,
      cheats: strings(parsed.cheats),
      activeCheats: strings(parsed.activeCheats),
      announcedCheats: strings(parsed.announcedCheats),
      proPurchased: parsed.proPurchased === true,
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(state: SunState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

export function readSeenTipCount(): number {
  try {
    const raw = window.localStorage.getItem(SEEN_TIPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Roll the daily counters and pay the visit bonus once per day. */
function rollDay(state: SunState): SunState {
  const day = today();
  if (state.day === day) return state;

  return {
    ...state,
    day,
    balance: state.balance + DAILY_BONUS,
    /* A fresh day pays +2 growth tokens (the skin currency). */
    tokens: state.tokens + 2,
    petsPaidToday: 0,
    asksPaidToday: 0,
  };
}

/** One-time bounties for treasures and achievements. */
function claimMilestones(
  state: SunState,
  treasures: readonly string[],
  achievements: readonly string[],
): SunState {
  const claimedTreasures = new Set(state.claimedTreasures);
  const claimedAchievements = new Set(state.claimedAchievements);
  let balance = state.balance;

  for (const id of treasures) {
    if (claimedTreasures.has(id)) continue;
    claimedTreasures.add(id);
    balance += TREASURE_BOUNTY;
  }

  for (const id of achievements) {
    if (claimedAchievements.has(id)) continue;
    claimedAchievements.add(id);
    balance += ACHIEVEMENT_BOUNTY;
  }

  if (
    claimedTreasures.size === state.claimedTreasures.length &&
    claimedAchievements.size === state.claimedAchievements.length &&
    balance === state.balance
  ) {
    return state;
  }

  return {
    ...state,
    balance,
    claimedTreasures: [...claimedTreasures],
    claimedAchievements: [...claimedAchievements],
  };
}

/** Tree height in feet — relative to the tree's stage: it climbs
 *  the stage ladder (Seed 0 ft … Ancient maple 1000 ft) as
 *  fertilizer marks progress, instead of a flat 30 ft per packet. */
function treeHeight(
  state: Pick<SunState, "fertilizer" | "species">,
): number {
  return treeHeightByFertilizer(state.fertilizer, state.species);
}

/** Unlock every cheat whose milestone the tree has reached. */
function unlockCheats(state: SunState): SunState {
  const height = treeHeight(state);
  const set = currentCheatSet();
  const reached = set
    .filter((_, index) => height >= CHEAT_HEIGHTS[index])
    .map((milestone) => milestone.word);

  const cheats = new Set(state.cheats);
  const before = cheats.size;

  for (const word of reached) cheats.add(word);

  if (cheats.size === before) return state;

  return { ...state, cheats: [...cheats] };
}

function reconcile(
  state: SunState,
  treasures: readonly string[],
  achievements: readonly string[],
): SunState {
  const base = unlockCheats(
    claimMilestones(rollDay(state), treasures, achievements),
  );

  /* One-time growth tokens for newly found treasures and
     achievements: claim whatever the grants registry lacks. */
  const newTreasures = treasures.filter(
    (entry) => !base.tokenGrants.includes(`once:treasure:${entry}`),
  );
  const newAchievements = achievements.filter(
    (entry) => !base.tokenGrants.includes(`once:achievement:${entry}`),
  );

  if (newTreasures.length + newAchievements.length === 0) {
    return base;
  }

  return {
    ...base,
    tokens: base.tokens + newTreasures.length + newAchievements.length,
    tokenGrants: [
      ...base.tokenGrants,
      ...newTreasures.map((entry) => `once:treasure:${entry}`),
      ...newAchievements.map((entry) => `once:achievement:${entry}`),
    ],
  };
}


interface BuyResult {
  ok: boolean;
  text: string;
  /** Cheat words unlocked by this purchase, if any. */
  unlocked: string[];
}

interface SunContextValue {
  balance: number;
  /** Total sun spent on fertilizer (tree growth driver). */
  spent: number;
  /** Growth tokens: the Skin Shop currency. */
  tokens: number;
  /** Purchased-but-unapplied fertilizer (the badge counter). */
  fertilizerHold: number;
  fertilizer: number;
  /** Growth the tree gains from bought fertilizer. */
  bonusGrowth: number;
  /** Tree height in feet. */
  height: number;
  /** True once ANY planted tree reaches the Young stage (index 3):
      unlocks My Library PRO mode. */
  proUnlocked: boolean;
  /** TEMPORARY dev override that forces proUnlocked on. */
  proOverride: boolean;
  setProOverride: (value: boolean) => void;
  /** The simulated Pro Pack was bought (no real payment exists). */
  proPurchased: boolean;
  /** Grant the Pro Pack bundle once. Idempotent: a second call
   *  grants nothing. The secret quests are untouched. */
  purchasePro: () => {
    granted: boolean;
    seedSpecies: TreeSpeciesId | null;
  };
  /** Next height milestone, or undefined when everything blooms. */
  nextMilestone: CheatMilestone | undefined;
  cheats: string[];
  activeCheats: string[];
  /** Buy fertilizer for the HOLD (badge) — it does not fertilize
   *  the tree until applied. */
  purchaseFertilizer: (
    count: number,
    currency: "sun" | "tokens",
  ) => BuyResult;
  /** Apply held fertilizer to the tree (the drag interaction). */
  applyFertilizer: (count: number) => BuyResult;
  redeemCheat: (word: string) => { ok: boolean; text: string };
  trackPet: () => void;
  trackAsk: () => void;
  /** Pay tip-milestone bounties for `tips` discovered tips. */
  syncProgress: (tips: number) => void;
  /** Grant growth tokens (one-time by key and/or capped per day). */
  grantTokens: (
    amount: number,
    onceKey?: string,
    dailyKey?: string,
  ) => number;
  /** Spend growth tokens; returns true when the wallet covered it. */
  spendTokens: (amount: number) => boolean;
  /** Reset the tree's growth progress (fertilizer + spent sun). */
  resetTree: () => void;
  /** Plant a species; each tree keeps its own growth. */
  plantSpecies: (id: TreeSpeciesId) => void;
  /** The planted tree's own cheat words. */
  cheatSet: { word: string; effect: string }[];
  /** TEMPORARY: dev top-up for shop/tree testing. */
  testTopUp: (sunAmount: number, tokenAmount: number) => void;
  /** DEV: set the planted tree's fertilizer count (its growth) directly. */
  testSetFertilizer: (count: number) => void;
  /** DEV: set sun and growth tokens back to zero (balances only). */
  testZeroWallet: () => void;
  /** DEV: arm every unlocked charm of the planted tree, or none. */
  testArmCharms: (all: boolean) => void;
  /** The planted species. */
  species: TreeSpeciesId;
}

const SunContext = createContext<SunContextValue | null>(null);

export function SunProvider({ children }: { children: ReactNode }) {
  const { found } = useHunt();
  const { unlocked } = useAchievements();
  const [state, setState] = useState<SunState>(readState);
  const [proOverride, setProOverride] = useState<boolean>(readProOverride);

  useEffect(() => {
    writeState(state);
  }, [state]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PRO_OVERRIDE_KEY,
        proOverride ? "1" : "0"
      );
    } catch {
      // best-effort
    }
  }, [proOverride]);

  /* Daily bonus, bounties, and cheat unlocks whenever progress
     changes. */
  useEffect(() => {
    setState((current) => reconcile(current, found, unlocked));
  }, [found, unlocked]);

  const height = treeHeight(state);
  const set = currentCheatSet();

  /* PRO unlock: any species' bed past its Young stage threshold —
     the temporary dev override forces it on for this run. */
  const proUnlocked =
    state.proPurchased ||
    (!isPresentationStored() &&
      (proOverride ||
        Object.entries(state.gardenProgress).some(
          ([species, fert]) =>
            treeStageIndex(fert, species as TreeSpeciesId) >= 3,
        )));

  const nextMilestone = CHEAT_HEIGHTS.map((heightFt, index) => ({
    height: heightFt,
    word: set[index]?.word ?? "",
    effect: set[index]?.effect ?? "",
  })).find((milestone) => height < milestone.height);

  /* SIMULATED purchase: the bundle (fertilizer hold, tree tokens, one
     seed pack = a new tree skin) is credited exactly once. The ref
     closes the window before React re-renders. */
  const proBuying = useRef(false);

  function purchasePro(): {
    granted: boolean;
    seedSpecies: TreeSpeciesId | null;
  } {
    if (state.proPurchased || proBuying.current) {
      return { granted: false, seedSpecies: null };
    }
    proBuying.current = true;

    const grant = applyProPack(
      {
        tokens: state.tokens,
        fertilizerHold: state.fertilizerHold,
        proPurchased: false,
      },
      readOwnedSkins(),
      TREE_SPECIES.map((entry) => entry.id),
    );
    const seedSpecies = grant.seedSpecies as TreeSpeciesId | null;

    if (seedSpecies) addOwnedSkin(seedSpecies);

    setState((current) => {
      if (current.proPurchased) return current;
      const rolled = rollDay(current);
      const next = applyProPack(
        {
          tokens: rolled.tokens,
          fertilizerHold: rolled.fertilizerHold,
          proPurchased: false,
        },
        [],
        [],
      ).wallet;
      return { ...rolled, ...next };
    });

    return { granted: true, seedSpecies };
  }

  function grantTokens(
    amount: number,
    onceKey?: string,
    dailyKey?: string,
  ): number {
    let granted = 0;

    setState((current) => {
      const rolled = rollDay(current);

      if (onceKey && rolled.tokenGrants.includes(`once:${onceKey}`)) {
        return rolled;
      }

      if (
        dailyKey &&
        rolled.tokenGrants.includes(`daily:${today()}:${dailyKey}`)
      ) {
        return rolled;
      }

      granted = amount;

      return {
        ...rolled,
        tokens: rolled.tokens + amount,
        tokenGrants: [
          ...rolled.tokenGrants,
          onceKey
            ? `once:${onceKey}`
            : `daily:${today()}:${dailyKey ?? "misc"}`,
        ],
      };
    });

    return granted;
  }

  /* TEMPORARY test wallet: keystroke-free top-ups for shop and
     tree testing. Remove with the Test wallet strip in the Sun Shop. */
  function testTopUp(sunAmount: number, tokenAmount: number) {
    setState((current) => {
      const rolled = rollDay(current);
      return {
        ...rolled,
        balance: rolled.balance + sunAmount,
        tokens: rolled.tokens + tokenAmount,
      };
    });
  }

  /* TEMPORARY: empty the wallet (sun and growth tokens) so the
     earn-and-spend loop can be tried from a clean balance. The trees,
     the fertilizer hold and the grants already paid out all stay —
     this is the balance only, not the progress. */
  function testZeroWallet() {
    setState((current) => ({ ...rollDay(current), balance: 0, tokens: 0 }));
  }

  /* DEV: put the planted tree at a chosen growth, for testing. The
     cheats that growth reaches unlock as they would by feeding. */
  function testSetFertilizer(count: number) {
    const n = Math.max(0, Math.min(3000, Math.round(count)));

    setState((current) =>
      unlockCheats({
        ...current,
        fertilizer: n,
        gardenProgress: { ...current.gardenProgress, [current.species]: n },
      }),
    );
  }

  function testArmCharms(all: boolean) {
    setState((current) => {
      const words = currentCheatSet().map((entry) => entry.word);

      return {
        ...current,
        activeCheats: all
          ? [...new Set([...current.activeCheats, ...words.filter((w) => current.cheats.includes(w))])]
          : current.activeCheats.filter((w) => !words.includes(w)),
      };
    });
  }

  /* Wipe every tree's progress: fertilizer and growth spent —
     the wallet, skins, and achievements stay. */
  function resetTree() {
    setState((current) => ({
      ...current,
      fertilizer: 0,
      spent: 0,
      gardenProgress: emptyProgress(),
    }));
  }

  /* Plant another species: the garden remembers each tree's own
     growth, so one tree can be a sapling while others are giants. */
  function plantSpecies(id: TreeSpeciesId) {
    setState((current) => ({
      ...current,
      species: id,
      fertilizer: current.gardenProgress[id] ?? 0,
    }));
  }

  function spendTokens(amount: number): boolean {
    let ok = false;

    setState((current) => {
      const rolled = rollDay(current);
      if (rolled.tokens < amount) {
        ok = false;
        return rolled;
      }
      ok = true;
      return { ...rolled, tokens: rolled.tokens - amount };
    });

    return ok;
  }

  function purchaseFertilizer(
    count: number,
    currency: "sun" | "tokens",
  ): BuyResult {
    if (count <= 0) {
      return { ok: false, text: "Invalid fertilizer amount.", unlocked: [] };
    }

    const price =
      count *
      (currency === "sun"
        ? SUN_PRICE_PER_FERTILIZER
        : TREE_TOKEN_PRICE_PER_FERTILIZER);

    if (currency === "sun" && state.balance < price) {
      return {
        ok: false,
        text: `Not enough sun — ${price - state.balance} more needed.`,
        unlocked: [],
      };
    }

    if (currency === "tokens" && state.tokens < price) {
      return {
        ok: false,
        text: `Not enough tree tokens — ${price - state.tokens} more needed.`,
        unlocked: [],
      };
    }

    setState((current) => {
      const rolled = rollDay(current);

      return reconcile(
        {
          ...rolled,
          balance:
            currency === "sun"
              ? rolled.balance - price
              : rolled.balance,
          tokens:
            currency === "tokens"
              ? rolled.tokens - price
              : rolled.tokens,
          spent:
            currency === "sun"
              ? rolled.spent + price
              : rolled.spent,
          fertilizerHold: rolled.fertilizerHold + count,
        },
        found,
        unlocked,
      );
    });

    return {
      ok: true,
      text: `Added ${count} fertilizer to your hold — drag it onto the tree to fertilize.`,
      unlocked: [],
    };
  }

  function applyFertilizer(count: number): BuyResult {
    if (count <= 0) {
      return {
        ok: false,
        text: "Drag further to fertilize.",
        unlocked: [],
      };
    }

    if (state.fertilizerHold < count) {
      return {
        ok: false,
        text: `Only ${state.fertilizerHold} fertilizer in your hold — buy more in the Sun shop first.`,
        unlocked: [],
      };
    }

    const before = height;
    const after = treeHeightByFertilizer(
      state.fertilizer + count,
      state.species,
    );
    const set = currentCheatSet();
    const crossed = cheatsCrossed(before, after, CHEAT_HEIGHTS, set);

    /* A cheat is announced the first time its milestone is really
       achieved — never on re-crossings, never twice. */
    const already = new Set(state.announcedCheats);
    const fresh = crossed.filter(
      (milestone) =>
        milestone.word !== "" && !already.has(milestone.word),
    );

    let wisdom: string;

    if (fresh.length > 0) {
      wisdom = fresh
        .map(
          (milestone) =>
            `Charm unlocked: type "${milestone.word}" — ${milestone.effect}`,
        )
        .join(" ");
    } else {
      /* A stage cleared speaks its own line... */
      const ferts = SPECIES_STAGE_FERT[state.species];
      const stageNow = ferts.filter((f) => f <= state.fertilizer).length - 1;
      const stageAfter = ferts.filter((f) => f <= state.fertilizer + count).length - 1;
      if (stageAfter > stageNow) {
        wisdom = SPECIES_STAGE_LINES[state.species][
          Math.min(stageAfter, SPECIES_STAGE_LINES[state.species].length - 1)
        ];
      } else {
        /* ...between stages, honest progress to the next one. */
        const nextFert = ferts.find((f) => f > state.fertilizer + count);
        if (nextFert !== undefined) {
          const gap = treeHeightByFertilizer(nextFert, state.species) - after;
          const line = PROGRESS_LINES[state.gardenTips % PROGRESS_LINES.length];
          /* Late stages can share a painted height; say so rather than
             promising "0 ft" to the next stage. */
          wisdom =
            gap > 0
              ? `${line} ${gap} ft to the next stage.`
              : `${line} Same height as the next stage, only fuller.`;
        } else {
          wisdom = PROGRESS_LINES[state.gardenTips % PROGRESS_LINES.length];
        }
      }
    }

    setState((current) => {
      const bed: Record<TreeSpeciesId, number> = {
        ...current.gardenProgress,
        [current.species]:
          (current.gardenProgress[current.species] ?? 0) + count,
      };
      const planted: SunState = {
        ...rollDay(current),
        gardenProgress: bed,
        fertilizer: bed[current.species],
        fertilizerHold: current.fertilizerHold - count,
        gardenTips: fresh.length > 0 ? current.gardenTips : current.gardenTips + 1,
        announcedCheats: fresh.length > 0
          ? [
              ...current.announcedCheats,
              ...fresh.map((milestone) => milestone.word),
            ]
          : current.announcedCheats,
      };

      return reconcile(planted, found, unlocked);
    });

    return {
      ok: true,
      text:
        `Fertilized with ${count} from your hold — ` +
        `+${count * GROWTH_PER_FERTILIZER} growth — ` +
        `${after} ft. ${wisdom}`,
      unlocked: fresh.map((milestone) => milestone.word),
    };
  }


  function redeemCheat(word: string) {
    const normalized = word.trim().toLowerCase();
    if (!normalized) return { ok: false, text: "Type a cheat word." };

    if (!state.cheats.includes(normalized)) {
      return {
        ok: false,
        text: `The tree has not grown wise enough for "${normalized}" yet.`,
      };
    }

    const armed = state.activeCheats.includes(normalized);

    setState((current) => ({
      ...current,
      activeCheats: armed
        ? current.activeCheats.filter((entry) => entry !== normalized)
        : [...current.activeCheats, normalized],
    }));

    return {
      ok: true,
      text: armed
        ? `Cheat "${normalized}" disabled.`
        : `Cheat "${normalized}" armed!`,
    };
  }

  function trackPet() {
    setState((current) => {
      const rolled = rollDay(current);
      const pets = rolled.pets + 1;

      if (rolled.petsPaidToday >= PET_SUN_CAP || pets < PETS_PER_SUN) {
        return { ...rolled, pets };
      }

      return {
        ...rolled,
        pets: pets - PETS_PER_SUN,
        petsPaidToday: rolled.petsPaidToday + 1,
        balance: rolled.balance + 1,
      };
    });
  }

  function trackAsk() {
    setState((current) => {
      const rolled = rollDay(current);

      if (rolled.asksPaidToday >= ASK_SUN_CAP) return rolled;

      return {
        ...rolled,
        asksPaidToday: rolled.asksPaidToday + 1,
        balance: rolled.balance + 1,
      };
    });
  }

  function syncProgress(tips: number) {
    setState((current) => {
      const rolled = rollDay(current);
      const target =
        Math.floor(Math.max(0, tips) / TIPS_PER_BOUNTY) * TIP_BOUNTY;

      const withTips: SunState = {
        ...rolled,
        tipsSeen: Math.max(0, tips),
        balance:
          rolled.balance + Math.max(0, target - rolled.tipBounties),
        tipBounties: Math.max(rolled.tipBounties, target),
      };

      return reconcile(withTips, found, unlocked);
    });
  }

  return (
    <SunContext.Provider
      value={{
        balance: state.balance,
        spent: state.spent,
        tokens: state.tokens,
        fertilizerHold: state.fertilizerHold,
        fertilizer: state.fertilizer,
        bonusGrowth: state.fertilizer * GROWTH_PER_FERTILIZER,
        height,
        proUnlocked,
        proOverride,
        setProOverride,
        proPurchased: state.proPurchased,
        purchasePro,
        nextMilestone,
        cheatSet: currentCheatSet(),
        cheats: state.cheats,
        activeCheats: state.activeCheats,
        purchaseFertilizer,
        applyFertilizer,
        redeemCheat,
        trackPet,
        trackAsk,
        syncProgress,
        grantTokens,
        spendTokens,
        testTopUp,
        testSetFertilizer,
        testZeroWallet,
        testArmCharms,
        species: state.species,
        resetTree,
        plantSpecies,
      }}
    >
      {children}
    </SunContext.Provider>
  );
}

export function useSun(): SunContextValue {
  const value = useContext(SunContext);

  if (value === null) {
    throw new Error("useSun must be used inside SunProvider.");
  }

  return value;
}

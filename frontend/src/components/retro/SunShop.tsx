/* ============================================================
   SUN SHOP — the Lab's third tab.

   A Plants-vs-Zombies-style storefront: sun tokens on the left
   (your tree's current stage and growth breakdown) and the
   fertilizer item on the right, sold at scales of 10 to 10,000,
   alternating sun and tree tokens; purchases credit the HOLD (badge)
   with bulk discounts. Every packet adds growth points to the
   Tree of Knowledge, so the earnings loop feeds the tree.

   Earning runs through state/sun.tsx: the daily visit bonus,
   petting the companion, asking the help library, and one-time
   bounties for treasures, achievements, and tip milestones.
   ============================================================ */

import { useRef, useState } from "react";

import {
  KNOWLEDGE_STAGES,
  SPECIES_INFO,
  knowledgePoints,
  knowledgeStageFromHeight,
  nextKnowledgeHeight,
  TREE_SKIN_PRICES,
  treeSpecies,
  type TreeSpeciesId,
} from "../../data/knowledge";
import {
  ACHIEVEMENT_BOUNTY,
  ASK_SUN_CAP,
  DAILY_BONUS,
  FERTILIZER_SCALES,
  GROWTH_PER_FERTILIZER,
  PETS_PER_SUN,
  PET_SUN_CAP,
  readSeenTipCount,
  SUN_PRICE_PER_FERTILIZER,
  TIP_BOUNTY,
  TIPS_PER_BOUNTY,
  TREASURE_BOUNTY,
  useSun,
} from "../../state/sun";
import { Palette, Sparkles, Sprout } from "lucide-react";
import { useHunt } from "../../state/hunt";
import { useAchievements } from "../../state/achievements";
import { addOwnedSkin, useOwnedSkins } from "../../state/skins";
import DevPanel from "../DevPanel";
import { useSiteMode } from "../../state/siteMode";
import KnowledgeTree from "./KnowledgeTree";
import { CardBadge, CardButton, CardTag, ShopCard } from "./ShopCard";
import SpeciesPreview from "./SpeciesPreview";
import SparkleGlyph from "./SparkleGlyph";
import SunGlyph from "./SunGlyph";
import TokenGlyph from "./TokenGlyph";
import RetroDialog from "./RetroDialog";
import ThemeShop from "./ThemeShop";
import ProPackButton from "../ProPack";
import { PRO_PACK_PRICE_LABEL, PRO_PACK_QUEST_NOTE } from "../../utils/proPack";
import { DEFAULT_BACKDROP_THEME, type BackdropThemeId } from "../../data/backdrops";

export type ShopTabId = "shop" | "skins" | "themes" | "earn" | "wallet";

const ALL_RAIL_TABS: {
  id: ShopTabId;
  label: string;
  glyph: JSX.Element;
}[] = [
  { id: "shop", label: "Sun shop", glyph: <SunGlyph className="h-3 w-3" /> },
  { id: "skins", label: "Tree skins", glyph: <TokenGlyph className="h-3 w-3" /> },
  { id: "themes", label: "Theme shop", glyph: <Palette className="h-3 w-3" /> },
  { id: "earn", label: "Earn sun", glyph: <Sparkles className="h-3 w-3" /> },
  { id: "wallet", label: "Developer", glyph: <TokenGlyph className="h-3 w-3" /> },
];

const TREE_SPECIES_CARDS: {
  id: TreeSpeciesId;
  label: string;
}[] = [
  { id: "crimson", label: "Crimson maple" },
  { id: "oak", label: "Oak" },
  { id: "birch", label: "Birch" },
  { id: "elm", label: "Elm" },
  { id: "redwood", label: "Redwood" },
  { id: "beanstalk", label: "Beanstalk" },
  { id: "rosevine", label: "Rose supervine" },
];

const SPECIES_KEY = "paperrec_knowledge_species";

function readSpecies(): TreeSpeciesId {
  try {
    const raw = window.localStorage.getItem(SPECIES_KEY);
    if (raw && TREE_SPECIES_CARDS.some((entry) => entry.id === raw)) {
      return raw as TreeSpeciesId;
    }
  } catch {
    // best-effort
  }
  return "oak";
}



function FertilizerIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-12 w-12 shrink-0" aria-hidden="true">
      <rect
        x="7"
        y="10"
        width="18"
        height="18"
        rx="2"
        fill="#a9762f"
        stroke="#5a3a14"
        strokeWidth="2"
      />
      <rect
        x="10"
        y="4"
        width="12"
        height="8"
        rx="2"
        fill="#8a5a2b"
        stroke="#5a3a14"
        strokeWidth="2"
      />
      <path
        d="M16 14 l4 5 h-3 v5 h-2 v-5 h-3 z"
        fill="#7ec850"
        stroke="#3b6d11"
        strokeWidth="1"
      />
    </svg>
  );
}

/* A fertilizer pack's preview: the bag with its multiplier, framed like
   the Theme shop's scene stills. */
function PackIcon({ count }: { count: number }) {
  return (
    <div
      aria-hidden="true"
      className="relative grid h-16 w-16 place-items-center rounded border-[2px] border-gray-900 bg-accentSoft"
    >
      <svg viewBox="0 0 32 32" className="h-11 w-11" aria-hidden="true">
        <rect x="7" y="10" width="18" height="18" rx="2" fill="#a9762f" stroke="#5a3a14" strokeWidth="2" />
        <rect x="10" y="4" width="12" height="8" rx="2" fill="#8a5a2b" stroke="#5a3a14" strokeWidth="2" />
        <path d="M16 14 l4 5 h-3 v5 h-2 v-5 h-3 z" fill="#7ec850" stroke="#3b6d11" strokeWidth="1" />
      </svg>
      <span className="absolute bottom-0 right-0 rounded-tl border-l-[2px] border-t-[2px] border-gray-900 bg-accent px-1 font-mono text-[9px] font-bold text-onAccent">
        {count}&times;
      </span>
    </div>
  );
}

export default function SunShop({
  hidePreview = false,
  embedded = false,
  tab,
  onSelect,
  hidePicker = false,
  onWhisper,
  themes,
  activeTheme,
  onThemeChanged,
  plantedSpecies,
  onPlantSpecies,
}: {
  /** Hide the "Your tree" preview when the real tree sits beside it. */
  hidePreview?: boolean;
  /** Embedded in the tree card: no frame — the tree's own menu
      chips drive `tab`; picker events flow through `onSelect`. */
  embedded?: boolean;
  tab?: ShopTabId;
  onSelect?: (id: ShopTabId) => void;
  /** The tree's sidebar draws its own picker rail (with the info
      card); pass true to skip this bundled one. */
  hidePicker?: boolean;
  /** Whisper purchases into the tree's speech bubble. */
  onWhisper?: (text: string) => void;
  /** Backdrop themes for the Theme shop pane (meadow default). */
  themes?: BackdropThemeId[];
  activeTheme?: BackdropThemeId;
  onThemeChanged?: (
    owned: BackdropThemeId[],
    active: BackdropThemeId,
  ) => void;
  /** The species growing in the garden now, and how to plant another
   *  one you own: the Tree skins cards then offer "Plant". */
  plantedSpecies?: TreeSpeciesId;
  onPlantSpecies?: (id: TreeSpeciesId) => void;
}) {
  // The Developer tab (test wallet, Pro override, looks) is for Researcher
  // mode only; the shipped tree has the shops and the earn guide.
  const { mode: siteMode } = useSiteMode();
  const RAIL_TABS =
    siteMode === "researcher"
      ? ALL_RAIL_TABS
      : ALL_RAIL_TABS.filter((entry) => entry.id !== "wallet");

  const {
    balance,
    fertilizer,
    fertilizerHold,
    bonusGrowth,
    height,
    nextMilestone,
    purchaseFertilizer,
    tokens,
    spendTokens,
    testTopUp,
    testZeroWallet,
    proOverride,
    setProOverride,
  } = useSun();
  const { count: treasures } = useHunt();
  const { unlocked } = useAchievements();

  const [tips] = useState<number>(readSeenTipCount);
  const [species] = useState<TreeSpeciesId>(readSpecies);
  const ownedSkins = useOwnedSkins();
  /* Themed pop-ups: purchase summary, confirmations, notices. */
  const [purchase, setPurchase] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    onYes: () => void;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Greenhouse panes: one open at a time, inside the rail. */
  const [popupState, setPopup] = useState<
    ShopTabId
  >("shop");
  const popup = embedded && tab ? tab : popupState;
  const railRef = useRef<HTMLDivElement | null>(null);




  /* Sparkle burst on a successful planting. */
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
      x: Math.round(Math.random() * 60 - 30),
      y: Math.round(Math.random() * 26 - 13),
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

  function handleBuy(count: number, currency: "sun" | "tokens") {
    const result = purchaseFertilizer(count, currency);
    if (result.ok && typeof onWhisper === "function") {
      onWhisper(result.text);
    }
    if (result.ok) {
      spawnSparkles(6);
    }
  }

  function buySkin(id: TreeSpeciesId) {
    const price = TREE_SKIN_PRICES[id];
    if (ownedSkins.includes(id)) return;

    setConfirm({
      title: "Buy this skin",
      body: `Adopt the ${treeSpecies(id).label} for ${price} growth tokens? It unlocks in the seed bank and plants right away.`,
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
        spawnSparkles(6);
      },
    });
  }

  const basePoints = knowledgePoints({
    treasures,
    achievements: unlocked.length,
    tips,
  });
  const total = basePoints + bonusGrowth;
  /* Knowledge tiers ride on the tree's height: it only knows as
     deep as it has grown. */
  const stage = knowledgeStageFromHeight(height);
  const nextAt = nextKnowledgeHeight(height);
  const tree = treeSpecies(species);



  return (
    <div className={embedded ? "w-full" : "grid gap-6 lg:grid-cols-2"}>
      <div
        ref={railRef}
        className={`relative flex w-full min-h-0 flex-col overflow-hidden ${
          embedded
            ? ""
            : "rounded border-[3px] border-gray-900 bg-white lg:h-[var(--garden-h,auto)]"
        }`}
      >
      {!hidePreview && (
        <section className="rounded border-[3px] border-gray-900 bg-white p-4">
        <p className="mb-3 font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
          Your tree
        </p>

        <div className="flex items-center gap-4">
          <div className="relative">
            <KnowledgeTree
              stage={stage}
              species={species}
              size={104}
              heightFt={height}
            />

            <span
              aria-hidden="true"
              className="absolute -bottom-1 left-1/2 h-1.5 w-16 -translate-x-1/2 rounded-full bg-black/20"
            />

            {sparkles.map((sparkle) => (
              <span
                key={sparkle.id}
                aria-hidden="true"
                className="sparkle-pop pointer-events-none absolute top-6 z-10"
                style={{
                  left: `calc(50% + ${sparkle.x}px)`,
                  marginTop: sparkle.y,
                }}
              >
                <SparkleGlyph />
              </span>
            ))}
          </div>

          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-ink">
              {tree.label}
              {" · "}
              {KNOWLEDGE_STAGES[stage]}
            </p>

            <p className="mt-1 text-xs leading-5 text-muted">
              Growth {total} = {basePoints} earned + {bonusGrowth}{" "}
              fertilized — the tree's knowledge rides on its height.
            </p>

            <p className="mt-1 text-xs leading-5 text-muted">
              {nextAt === undefined
                ? "Fully grown — the tree knows everything it can hold."
                : `Next knowledge at ${nextAt} ft.`}
            </p>

            <p className="mt-1 text-xs leading-5 text-muted">
              Height {height} ft
              {nextMilestone
                ? ` · next wisdom at ${nextMilestone.height} ft`
                : " · every wisdom has bloomed"}
            </p>

            <p className="mt-1 text-xs leading-5 text-muted">
              {fertilizer} fertilizer
              {fertilizer === 1 ? "" : "s"} planted
            </p>
          </div>
        </div>
      </section>
      )}

      {/* ---------------- picker: character-selector cards ------- */}
      {!hidePicker && (
      <div
        role="group"
        aria-label="Garden shop"
        className={`flex w-full gap-2 overflow-x-auto border-b-[3px] border-gray-900 px-2 py-2 ${
          embedded ? "bg-accentSoft/45 dark:bg-[#2c2413]/70" : "bg-[#8a5a2b]"
        }`}
        onKeyDown={(event) => {
          const index = RAIL_TABS.findIndex((entry) => entry.id === popup);
          const pick = (id: ShopTabId) => {
            if (embedded && onSelect) onSelect(id);
            else setPopup(id);
          };
          if (event.key === "ArrowRight") {
            event.preventDefault();
            pick(RAIL_TABS[(index + 1) % RAIL_TABS.length].id);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            pick(RAIL_TABS[(index - 1 + RAIL_TABS.length) % RAIL_TABS.length].id);
          }
        }}
      >
        {RAIL_TABS.map((entry) => {
          const active = popup === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (embedded && onSelect) onSelect(entry.id);
                else setPopup(entry.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const index = RAIL_TABS.findIndex(
                  (tab) => tab.id === popup,
                );
                const next =
                  event.key === "ArrowRight"
                    ? RAIL_TABS[(index + 1) % RAIL_TABS.length].id
                    : RAIL_TABS[
                        (index - 1 + RAIL_TABS.length) % RAIL_TABS.length
                      ].id;
                if (embedded && onSelect) onSelect(next);
                else setPopup(next);
              }}
              title={`${entry.label} — press \u2190 \u2192 to switch`}
              className={`flex min-w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-lg border-[3px] px-2.5 py-2 transition-all duration-150 pixel-ease ${
                active
                  ? "border-gray-900 bg-white text-gray-900 shadow-[2px_2px_0_rgba(0,0,0,0.25)]"
                  : "border-gray-600 bg-accentSoft/60 text-ink/90 hover:border-gray-900 hover:text-ink"
              }`}
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded border-[3px] transition-colors ${
                  active
                    ? "border-gray-900 bg-accentSoft"
                    : "border-gray-600/60 bg-accentSoft"
                }`}
              >
                {entry.glyph}
              </span>
              <span className="font-mono text-[9px] font-bold uppercase tracking-wide">
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>
      )}

      {/* ---------------- greenhouse panes, inside the card -------- */}
      <div
        data-shop-panel
        className="min-h-0 w-full flex-1 overflow-y-auto"
        style={embedded ? { maxHeight: "min(68vh, 640px)" } : undefined}
        role="group"
          aria-label={
            popup === "shop"
              ? "Sun shop"
              : popup === "skins"
                ? "Tree skins"
                : popup === "themes"
                  ? "Theme shop"
                  : popup === "earn"
                    ? "Earn sun"
                    : "Developer"
          }
        >
          <div className="p-4">
            {popup === "themes" ? (
              onThemeChanged ? (
                <ThemeShop
                  owned={themes ?? []}
                  active={activeTheme ?? DEFAULT_BACKDROP_THEME}
                  onChanged={onThemeChanged}
                />
              ) : (
                <p className="text-xs leading-5 text-muted">
                  Theme collection lives with the tree — open the
                  garden to change your backdrop.
                </p>
              )
            ) : popup === "shop" && (
              <>
<div className="rounded border-[3px] border-gray-900 bg-accentSoft/60 p-3">
          <div className="flex items-start gap-3">
            <FertilizerIcon />

            <div className="min-w-0">
              <p className="font-mono text-sm font-bold text-gray-900">
                Fertilizer
              </p>
              <p className="mt-0.5 text-xs leading-5 text-gray-800">
                Buy fertilizer into your hold — it does not feed the
                tree until you drag it from the garden's fertilizer
                counter (1×, 2×, or 10×). Each packet adds{" "}
                {GROWTH_PER_FERTILIZER} growth points. Height follows
                the tree's stage — from seed at 0 ft to the ancient
                tree at 1000 ft across all 10,000 packets — and
                feeding dispenses wisdom: a new charm at 250, 450, 650, 850
                and 1000 feet, a garden tip otherwise.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accentSoft px-2 py-1 font-mono text-xs font-bold text-ink">
              <SunGlyph className="h-3.5 w-3.5" /> {balance}
            </span>
            <span className="flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accentSoft px-2 py-1 font-mono text-xs font-bold text-ink">
              <TokenGlyph className="h-3.5 w-3.5" /> {tokens}
            </span>
            <span
              className="flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-white px-2 py-1 font-mono text-xs font-bold text-ink"
              title="Purchased fertilizer waiting to be dragged onto the tree"
            >
              <Sprout className="h-3.5 w-3.5 text-[#2b8a3e] [[data-mode=dark]_&]:text-[#7ddf8a]" />×{fertilizerHold}
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {FERTILIZER_SCALES.map((scale) => {
              const affordable =
                scale.currency === "sun"
                  ? balance >= scale.price
                  : tokens >= scale.price;
              const unit = scale.currency === "sun" ? "sun" : "tokens";

              return (
                <ShopCard
                  key={`${scale.count}-${scale.currency}`}
                  layout="side"
                  preview={<PackIcon count={scale.count} />}
                  title={`${scale.count}\u00D7 fertilizer`}
                  blurb={`+${scale.count * GROWTH_PER_FERTILIZER} growth points once fed to the tree. It lands in your hold.`}
                >
                  <CardButton
                    disabled={!affordable}
                    onClick={() => handleBuy(scale.count, scale.currency)}
                    title={
                      affordable
                        ? `Add ${scale.count} fertilizer to your hold for ${scale.price} ${unit}`
                        : `Needs ${scale.price} ${unit}`
                    }
                  >
                    {scale.currency === "sun" ? (
                      <SunGlyph className="h-3 w-3" />
                    ) : (
                      <TokenGlyph className="h-3 w-3" />
                    )}
                    {scale.price} {unit}
                  </CardButton>
                </ShopCard>
              );
            })}
          </div>

          <div className="mt-3">
            <ShopCard
              layout="side"
              preview={<Sparkles className="h-8 w-8" aria-hidden="true" />}
              title={`Pro Pack \u2013 ${PRO_PACK_PRICE_LABEL}`}
              blurb={`Demo checkout, nothing is charged. Unlocks My Library PRO plus 1,000 fertilizer, 1,000 tree tokens and 1 seed pack. ${PRO_PACK_QUEST_NOTE}`}
            >
              <ProPackButton variant="button" />
            </ShopCard>
          </div>

          <p className="mt-2 text-right font-mono text-[9px] font-bold uppercase tracking-wider text-muted">
            purchases land in your hold — drag the garden's fertilizer
            counter onto the tree
          </p>

        </div>

              </>
            )}
            {popup === "skins" && (
              <>
        <p className="mb-1 text-xs leading-5 text-muted">
          Maple is your free starter tree. Every other species is a skin
          you keep for good — buy them here or from the tree panel's
          seed bank.
        </p>
        <p className="mb-3 text-xs leading-5 text-muted">
          Growth tokens pay for skins and come from using the app:{" "}
          <strong className="text-ink">+3</strong> on a new day,{" "}
          <strong className="text-ink">+1</strong> per finished battle
          (3/day), <strong className="text-ink">+1</strong> per 5 tree
          asks (3/day), and <strong className="text-ink">+1</strong>{" "}
          apiece for treasures and achievements. Keep using the app and
          every skin will come home.
        </p>

        <div className="flex flex-col gap-3">
          {TREE_SPECIES_CARDS.map((entry) => {
            const owned = ownedSkins.includes(entry.id);
            const price = TREE_SKIN_PRICES[entry.id];
            const planted = plantedSpecies === entry.id;
            const info = SPECIES_INFO[entry.id];

            return (
              <ShopCard
                key={entry.id}
                layout="side"
                active={planted}
                preview={
                  <SpeciesPreview
                    speciesId={entry.id}
                    theme={activeTheme ?? DEFAULT_BACKDROP_THEME}
                    dim={!owned}
                  />
                }
                title={info.name}
                badge={
                  planted ? (
                    <CardBadge>Planted</CardBadge>
                  ) : owned ? (
                    <CardBadge tone="muted">Owned</CardBadge>
                  ) : undefined
                }
                blurb={info.fact}
              >
                {owned ? (
                  planted ? (
                    <CardTag>Planted</CardTag>
                  ) : onPlantSpecies ? (
                    <CardButton onClick={() => onPlantSpecies(entry.id)}>
                      Plant
                    </CardButton>
                  ) : (
                    <CardTag>Owned</CardTag>
                  )
                ) : (
                  <CardButton
                    onClick={() => buySkin(entry.id)}
                    disabled={tokens < price}
                    title={
                      tokens >= price
                        ? `Buy for ${price} growth tokens`
                        : `Needs ${price - tokens} more growth tokens`
                    }
                  >
                    <TokenGlyph className="h-2.5 w-2.5" />
                    {price}
                  </CardButton>
                )}
              </ShopCard>
            );
          })}
        </div>
              </>
            )}
            {popup === "earn" && (
              <>
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
          How to earn sun
        </p>
        <ul className="mt-1 space-y-0.5 text-xs leading-5 text-muted">
          <li>Daily visit: +{DAILY_BONUS}</li>
          <li>
            Every {PETS_PER_SUN} pets: +1 (max {PET_SUN_CAP}/day)
          </li>
          <li>
            Every help question: +1 (max {ASK_SUN_CAP}/day)
          </li>
          <li>Each treasure: +{TREASURE_BOUNTY}</li>
          <li>Each achievement: +{ACHIEVEMENT_BOUNTY}</li>
          <li>
            Every {TIPS_PER_BOUNTY} tips discovered: +{TIP_BOUNTY}
          </li>
        </ul>

        <p className="mt-3 text-xs leading-5 text-muted">
          The tree's cheat words are now garden charms. Open the Almanac
          (Charms) to see what each one unlocks and to switch them on and
          off.
        </p>
              </>
            )}
            {popup === "wallet" && (
              <>
        <section className="rounded-xl border-[2px] border-dashed border-[#b45309]/70 bg-accentSoft/50 p-3.5">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-[#b45309] [[data-mode=dark]_&]:text-[#f5b861]">
            Developer · test wallet (temporary)
          </p>
          <p className="mt-1 text-xs leading-5 text-ink">
            Dev only: top up instantly to stress the shop and the Tree
            of Knowledge, zero the wallet back to a clean balance, or
            force My Library PRO on without growing a tree. Remove
            before launch.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => testTopUp(1000, 0)}
              className="flex w-full items-center justify-between rounded border-[3px] border-[#b45309] bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              <span>+1,000 sun</span>
            <SunGlyph className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => testTopUp(0, 1000)}
              className="flex w-full items-center justify-between rounded border-[3px] border-[#b45309] bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              <span>+1,000 growth tokens</span>
            <TokenGlyph className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => testTopUp(1000, 1000)}
              className="flex w-full items-center justify-between rounded border-[3px] border-[#b45309] bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              <span>both</span>
            <span className="flex items-center gap-1">
              <SunGlyph className="h-3 w-3" />
              <TokenGlyph className="h-3 w-3" />
            </span>
            </button>
            <button
              type="button"
              onClick={() =>
                setConfirm({
                  title: "Zero the wallet",
                  body:
                    `Set sun and growth tokens back to 0? You now hold ` +
                    `${balance} sun and ${tokens} growth tokens. The trees, ` +
                    `the fertilizer in hand, the skins and the achievements ` +
                    `all stay — only the balances are cleared.`,
                  onYes: testZeroWallet,
                })
              }
              className="flex w-full items-center justify-between rounded border-[3px] border-[#b45309] bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              <span>zero both</span>
              <span className="flex items-center gap-1">
                <SunGlyph className="h-3 w-3" />
                <TokenGlyph className="h-3 w-3" />
              </span>
            </button>
            <button
              type="button"
              aria-pressed={proOverride}
              onClick={() => setProOverride(!proOverride)}
              className={`flex w-full items-center justify-between rounded border-[3px] border-[#b45309] px-3 py-1.5 font-mono text-[11px] font-bold transition-colors pixel-ease hover:bg-accentSoft ${
                proOverride
                  ? "bg-[#8a3d05] text-[#ffffff]"
                  : "bg-accentSoft text-ink"
              }`}
            >
              <span>PRO mode (temporary)</span>
              <span>{proOverride ? "ON" : "OFF"}</span>
            </button>
          </div>
        </section>

        {/* the garden's controls: looks, scenery, charms, the tree's growth */}
        <div className="mt-4">
          <DevPanel garden />
          <p className="mt-3 text-xs leading-5 text-muted">
            The full control panel (all looks, tree colors, backup) is under
            Settings, Developer. Press ` anywhere for the cheat console.
          </p>
        </div>
              </>
            )}
          </div>
        </div>
      </div>

      <RetroDialog
        open={purchase !== null}
        title={purchase?.title ?? ""}
        autoCloseMs={10_000}
        onCancel={() => setPurchase(null)}
        onConfirm={() => setPurchase(null)}
        confirmLabel="Done"
      >
        {purchase?.body}
      </RetroDialog>

      <RetroDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        size="sm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.onYes();
          setConfirm(null);
        }}
      >
        {confirm?.body}
      </RetroDialog>

      <RetroDialog
        open={notice !== null}
        title="Heads up"
        size="sm"
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

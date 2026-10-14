/**
 * The garden almanac: a carved wooden book with two pages.
 *
 *   Charms  the tree's five charms. Each hangs on a tag; once the tree is
 *           tall enough to hold it, it is a switch you can flip on and off.
 *   Scene   the garden's ordinary scenery, always free to switch.
 *
 * Tags are wood, lit amber when on, dark and padlocked when the tree has
 * not grown enough.
 */

import {
  Bird,
  Flower2,
  Gem,
  Leaf,
  Lock,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import {
  CHARM_KINDS,
  SCENE_LAYERS,
  charmsFor,
  type CharmKind,
} from "../../data/charms";
import { treeSpecies, type TreeSpeciesId } from "../../data/knowledge";
import { useSceneLayers } from "../../state/sceneLayers";
import { useSun } from "../../state/sun";

export type AlmanacTab = "charms" | "scene";

const KIND_ICON: Record<CharmKind, LucideIcon> = {
  foliage: Leaf,
  plant: Flower2,
  creature: Bird,
  light: Sun,
  relic: Gem,
};

function Peg({
  on,
  label,
  onClick,
  disabled = false,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="wood-peg shrink-0 cursor-pointer disabled:cursor-not-allowed"
    />
  );
}

export default function GardenAlmanac({
  speciesId,
  height,
  tab: initialTab = "charms",
  onToggled,
}: {
  speciesId: TreeSpeciesId;
  height: number;
  tab?: AlmanacTab;
  /** A charm was switched: the garden shows a pop-up. */
  onToggled?: (word: string, armed: boolean, effect: string) => void;
}) {
  const [tab, setTab] = useState<AlmanacTab>(initialTab);
  const { cheats, activeCheats, redeemCheat } = useSun();
  const { off, isOn, toggle, setAll } = useSceneLayers();
  const [word, setWord] = useState("");
  const [say, setSay] = useState("");
  const charms = charmsFor(speciesId);
  const unlockedCount = charms.filter((c) => cheats.includes(c.word)).length;
  const label = treeSpecies(speciesId).label;

  function flip(wordToFlip: string) {
    const was = activeCheats.includes(wordToFlip);
    const out = redeemCheat(wordToFlip);

    if (out.ok) {
      const charm = charms.find((c) => c.word === wordToFlip);

      onToggled?.(wordToFlip, !was, charm?.effect ?? "");
    }

    return out;
  }

  const groups = SCENE_LAYERS.reduce<Record<string, typeof SCENE_LAYERS>>(
    (acc, layer) => {
      (acc[layer.group] ??= []).push(layer);

      return acc;
    },
    {},
  );

  return (
    <div className="flex flex-col gap-3 text-[color:var(--gm-ink)]">
      <div role="tablist" aria-label="Almanac pages" className="flex gap-1.5">
        {(
          [
            ["charms", "Charms", Sparkles],
            ["scene", "Scene", Sun],
          ] as const
        ).map(([id, text, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded border-[3px] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider transition-colors pixel-ease ${
              tab === id ? "wood-chip-lit" : "wood-chip"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {text}
          </button>
        ))}
        <span className="wood-label ml-auto self-center font-mono text-[10px] font-bold uppercase tracking-wider">
          {label} · {height} ft
        </span>
      </div>

      {tab === "charms" && (
        <div className="wood-page rounded-lg p-3">
          <p className="mb-3 text-xs font-bold leading-5">
            The {label} holds {unlockedCount} of {charms.length} charms. Each
            one is a part of the garden that comes alive when the tree is tall
            enough to hold it. Flip a charm on or off whenever you like.
          </p>

          <ul className="grid grid-cols-1 gap-x-3 gap-y-5 pt-2 sm:grid-cols-2 xl:grid-cols-3">
            {charms.map((charm, index) => {
              const unlocked = cheats.includes(charm.word);
              const on = unlocked && activeCheats.includes(charm.word);
              const Icon = KIND_ICON[charm.kind];
              const kind = CHARM_KINDS[index]?.label ?? charm.kind;
              const previous = index === 0 ? 0 : charms[index - 1].height;
              const progress = Math.min(
                1,
                Math.max(0, (height - previous) / (charm.height - previous)),
              );

              return (
                <li
                  key={charm.word}
                  data-charm={charm.word}
                  data-state={!unlocked ? "locked" : on ? "on" : "off"}
                  className={`wood-tag flex flex-col gap-1.5 px-3 pb-3 pt-3 ${
                    !unlocked ? "wood-tag-locked" : on ? "wood-tag-on" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded border-[2px] ${
                        unlocked
                          ? "border-[color:var(--gm-edge)] bg-[var(--gm-inset)] text-[color:var(--gm-label)]"
                          : "border-[color:var(--gm-edge)] bg-[var(--gm-peg)] text-[color:var(--gm-locked-text)]"
                      }`}
                    >
                      {unlocked ? (
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Lock className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[12px] font-bold uppercase leading-tight tracking-wide">
                        {charm.label}
                      </p>
                      <p className="font-mono text-[9px] font-bold uppercase tracking-[0.15em] opacity-80">
                        {kind}
                      </p>
                    </div>
                    {unlocked && (
                      <Peg
                        on={on}
                        label={`${charm.label}: ${on ? "on" : "off"}`}
                        onClick={() => flip(charm.word)}
                      />
                    )}
                  </div>

                  <p className="text-[11px] leading-[15px]">{charm.effect}</p>

                  {unlocked ? (
                    <p className="font-mono text-[10px] font-bold uppercase tracking-wider opacity-80">
                      cheat word: {charm.word}
                    </p>
                  ) : (
                    <div className="mt-auto">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-wider">
                        Grows at {charm.height} ft
                        <span className="opacity-80">
                          {" "}
                          · {Math.max(0, charm.height - height)} ft to go
                        </span>
                      </p>
                      <div
                        aria-hidden="true"
                        className="mt-1 h-2 overflow-hidden rounded border-[2px] border-[color:var(--gm-edge2)] bg-[var(--gm-inset)]"
                      >
                        <div
                          className="h-full bg-[#e0a03c]"
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <form
            className="mt-4 flex flex-wrap items-center gap-2 border-t-[2px] border-[#4a2c12]/50 pt-3"
            onSubmit={(event) => {
              event.preventDefault();

              const typed = word.trim().toLowerCase();

              if (!typed) {
                setSay("Say a cheat word.");

                return;
              }

              const charm = charms.find((c) => c.word === typed);

              if (!charm) {
                setSay(`The ${label} knows no charm called “${typed}”.`);

                return;
              }
              if (!cheats.includes(typed)) {
                setSay(`Not yet: “${typed}” grows at ${charm.height} ft.`);

                return;
              }

              const out = flip(typed);

              setSay(out.text);
              if (out.ok) setWord("");
            }}
          >
            <label
              htmlFor="almanac-word"
              className="font-mono text-[10px] font-bold uppercase tracking-wider"
            >
              Say the word
            </label>
            <input
              id="almanac-word"
              value={word}
              onChange={(event) => setWord(event.target.value)}
              placeholder="e.g. a cheat word"
              className="min-h-8 min-w-0 flex-1 rounded border-[3px] border-[color:var(--gm-edge)] bg-[var(--gm-inset)] px-2 font-mono text-[12px] text-[color:var(--gm-text)] placeholder:text-[color:var(--gm-text)]/60"
            />
            <button
              type="submit"
              className="wood-chip rounded border-[3px] px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider"
            >
              Cast
            </button>
            {say && (
              <p role="status" className="basis-full text-[11px] font-bold">
                {say}
              </p>
            )}
          </form>
        </div>
      )}

      {tab === "scene" && (
        <div className="wood-page rounded-lg p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="flex-1 text-xs font-bold leading-5">
              The garden's ordinary scenery. These are never locked: switch
              off whatever you would rather not see.
            </p>
            <button
              type="button"
              onClick={() => setAll(true, [])}
              className="wood-chip rounded border-[3px] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider"
            >
              All on
            </button>
            <button
              type="button"
              onClick={() => setAll(false, SCENE_LAYERS.map((layer) => layer.id))}
              className="wood-chip rounded border-[3px] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider"
            >
              All off
            </button>
          </div>

          {Object.entries(groups).map(([group, layers]) => (
            <section key={group} className="mb-3 last:mb-0">
              <h3 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                {group}
              </h3>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {layers.map((layer) => {
                  const on = isOn(layer.id);

                  return (
                    <li
                      key={layer.id}
                      className={`flex items-center justify-between gap-2 rounded border-[3px] px-2.5 py-1.5 ${
                        on ? "wood-chip" : "wood-chip-inset"
                      }`}
                    >
                      <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                        {layer.label}
                      </span>
                      <Peg
                        on={on}
                        label={`${layer.label}: ${on ? "on" : "off"}`}
                        onClick={() => toggle(layer.id)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="mt-2 text-[10px] font-bold opacity-80">
            {off.length === 0
              ? "Everything is on."
              : `${off.length} layer${off.length === 1 ? "" : "s"} switched off.`}
          </p>
        </div>
      )}
    </div>
  );
}

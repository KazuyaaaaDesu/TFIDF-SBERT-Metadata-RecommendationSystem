/**
 * The developer control panel: every customization in one place.
 *
 *   looks          the hidden cheats (skins and effects), found or not
 *   live scenery   the garden's scene behind the app, and how dim
 *   scenery        the garden's scene switches, particles included
 *   charms         the planted tree's charms, plus shortcuts to grow it
 *   tree colors   each tree's painted variant
 *   backup         copy and paste all of it as text
 *
 * It lives in Settings (the Developer tab), and a garden-sized version
 * (`garden`) sits in the shop's Developer tab.
 */

import { useState } from "react";

import "../pages/settings.css";

import { CHARM_KINDS, PARTICLE_LAYERS, SCENE_LAYERS, charmsFor } from "../data/charms";
import { BACKDROP_THEMES } from "../data/backdrops";
import { SPECIES_STAGE_FERT, TREE_SPECIES, treeSpecies } from "../data/knowledge";
import { SECRETS } from "../data/secrets";
import { useSceneLayers } from "../state/sceneLayers";
import { useSun } from "../state/sun";
import { useTreeVariant } from "../state/treeVariant";
import {
  isSecretOn,
  resetLooks,
  setUiCustom,
  toggleSecret,
  useUiCustom,
} from "../state/uiCustom";
import {
  CUSTOM_FONT,
  DEFAULT_TYPE,
  DEFAULT_UI_CUSTOM,
  FONT_CHOICES,
  TYPE_LIMITS,
  UI_CUSTOM_EVENT,
  UI_CUSTOM_KEY,
  type FontSlot,
  type TypeTweaks,
} from "../utils/uiCustom";
import { VARIANT_KEY, variantsFor } from "../utils/treeVariants";

const STAGES = ["Seed", "Seedling", "Sapling", "Young", "Mature", "Giant", "Ancient"];

function Switch({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className="wood-peg shrink-0 cursor-pointer"
    />
  );
}

function Row({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row set-row-nolamp">
      <div className="set-label">
        <p className="set-label-t">{title}</p>
        {note && <p className="set-label-n">{note}</p>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="set-panel" data-set-section={title}>
      <div className="set-panel-head">
        <h2 className="font-pixelify text-lg font-bold text-ink">{title}</h2>
      </div>
      <div className="set-panel-body">{children}</div>
      <div className="set-panel-foot" />
      <div className="set-screws" />
    </section>
  );
}

const btn =
  "rounded border-[3px] border-gray-900 bg-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-ink transition-colors pixel-ease hover:bg-accentSoft";

function FontRow({
  title,
  note,
  slot,
  onChange,
}: {
  title: string;
  note: string;
  slot: FontSlot;
  onChange: (slot: FontSlot) => void;
}) {
  return (
    <Row title={title} note={note}>
      <select
        aria-label={`${title} font`}
        value={slot.id ?? ""}
        onChange={(event) => onChange({ ...slot, id: event.target.value || null })}
        className="rounded border-[3px] border-gray-900 bg-field px-2 py-1 font-mono text-[11px] text-ink"
      >
        <option value="">Site default</option>
        {FONT_CHOICES.map((font) => (
          <option key={font.id} value={font.id}>
            {font.label}
          </option>
        ))}
        <option value={CUSTOM_FONT}>Other (Google Fonts name)…</option>
      </select>
      {slot.id === CUSTOM_FONT && (
        <input
          aria-label={`${title} custom font name`}
          value={slot.custom}
          placeholder="e.g. Karla"
          maxLength={60}
          onChange={(event) => onChange({ ...slot, custom: event.target.value })}
          className="w-32 rounded border-[3px] border-gray-900 bg-field px-2 py-1 font-mono text-[11px] text-ink"
        />
      )}
    </Row>
  );
}

function TypeSlider({
  title,
  note,
  value,
  limits,
  format,
  onChange,
}: {
  title: string;
  note?: string;
  value: number;
  limits: { min: number; max: number; step: number };
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Row title={title} note={note}>
      <input
        type="range"
        aria-label={title}
        {...limits}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-32"
      />
      <span className="w-14 text-right font-mono text-xs text-ink">{format(value)}</span>
    </Row>
  );
}

function VariantRow({ species }: { species: string }) {
  const [id, set] = useTreeVariant(species);

  return (
    <Row title={treeSpecies(species).label}>
      <select
        aria-label={`${treeSpecies(species).label} colors`}
        value={id}
        onChange={(event) => set(event.target.value)}
        className="rounded border-[3px] border-gray-900 bg-field px-2 py-1 font-mono text-[11px] text-ink"
      >
        {variantsFor(species).map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export default function DevPanel({ garden = false }: { garden?: boolean }) {
  const { custom, setLive } = useUiCustom();
  const layers = useSceneLayers();
  const sun = useSun();
  const [backup, setBackup] = useState("");
  const [note, setNote] = useState("");
  const charms = charmsFor(sun.species);
  const ferts = SPECIES_STAGE_FERT[sun.species];

  function setType(patch: Partial<TypeTweaks>) {
    setUiCustom((c) => ({ ...c, type: { ...c.type, ...patch } }));
  }

  function exportAll() {
    const read = (key: string) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    setBackup(
      JSON.stringify(
        {
          ui: read(UI_CUSTOM_KEY),
          layersOff: read("paperrec_scene_layers_off"),
          variants: read(VARIANT_KEY),
        },
        null,
        2,
      ),
    );
    setNote("Copy this text to keep your customizations.");
  }

  function importAll() {
    try {
      const data = JSON.parse(backup) as Record<string, string | null>;
      const put = (key: string, value: string | null | undefined) => {
        if (typeof value === "string") window.localStorage.setItem(key, value);
      };

      put(UI_CUSTOM_KEY, data.ui);
      put("paperrec_scene_layers_off", data.layersOff);
      put(VARIANT_KEY, data.variants);
      window.dispatchEvent(new Event(UI_CUSTOM_EVENT));
      window.dispatchEvent(new Event("paperrec:scene-layers"));
      window.dispatchEvent(new Event("paperrec:tree-variant"));
      setNote("Imported.");
    } catch {
      setNote("That text isn't a saved set of customizations.");
    }
  }

  return (
    <div className="flex flex-col gap-4" data-dev-panel="">
      {!garden && (
        <Section title="Cheat console">
          <Row title="Hotkey" note="Press the backquote key anywhere (not while typing) to open the console.">
            <kbd className="rounded border-[3px] border-gray-900 bg-canvas px-2 py-0.5 font-mono text-sm font-bold text-ink">
              `
            </kbd>
            <button
              type="button"
              className={btn}
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`" }))}
            >
              Open
            </button>
          </Row>
        </Section>
      )}

      <Section title="Looks (hidden cheats)">
        {SECRETS.map((secret) => {
          const found = custom.discovered.includes(secret.id);

          return (
            <Row
              key={secret.id}
              title={secret.label}
              note={`${found ? "Found" : "Not found yet"} · cheat word: ${secret.word}. ${secret.blurb}`}
            >
              <Switch
                on={isSecretOn(custom, secret)}
                label={`${secret.label}: ${isSecretOn(custom, secret) ? "on" : "off"}`}
                onClick={() => toggleSecret(secret)}
              />
            </Row>
          );
        })}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={btn} onClick={resetLooks}>
            All looks off
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setUiCustom((c) => ({ ...c, discovered: [] }))}
          >
            Forget found secrets
          </button>
        </div>
      </Section>

      <Section title="Typography">
        <FontRow
          title="Body font"
          note="Paragraphs, tables and chat text. Loaded from Google Fonts when picked."
          slot={custom.type.body}
          onChange={(body) => setType({ body })}
        />
        <FontRow
          title="Header font"
          note="Page and section headings, field labels, buttons and the retro labels."
          slot={custom.type.heading}
          onChange={(heading) => setType({ heading })}
        />
        <TypeSlider
          title="Text size"
          note="Scales the whole interface."
          value={custom.type.scale}
          limits={TYPE_LIMITS.scale}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(scale) => setType({ scale })}
        />
        <TypeSlider
          title="Letter spacing"
          value={custom.type.tracking}
          limits={TYPE_LIMITS.tracking}
          format={(v) => `${v.toFixed(3)}em`}
          onChange={(tracking) => setType({ tracking })}
        />
        <TypeSlider
          title="Line height"
          note="0 leaves each page's own."
          value={custom.type.lineHeight}
          limits={TYPE_LIMITS.lineHeight}
          format={(v) => (v ? v.toFixed(2) : "auto")}
          onChange={(lineHeight) => setType({ lineHeight })}
        />
        <p
          className="rounded border-[3px] border-gray-900 bg-canvas p-3 text-sm leading-6 text-ink"
          data-testid="type-sample"
        >
          <span className="font-pixelify text-lg font-bold">Header sample: Ranking papers by meaning</span>
          <br />
          Body sample: The quick brown fox jumps over the lazy dog. 0123456789 · nDCG@10 = 0.412 (95% CI 0.38–0.44)
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={btn} onClick={() => setType(DEFAULT_TYPE)}>
            Reset typography
          </button>
        </div>
      </Section>

      <Section title="Live scenery behind the app">
        <Row
          title="Look wallpapers"
          note="Every look has its own live wallpaper: Nokia-style games on Pocket Green, a sawmill on Lumberyard, digital rain on Phosphor, a drafting table on Blueprint, a sunset grid on Neon Horizon, a scriptorium on Old Parchment."
        >
          <Switch
            on={custom.wallpaper}
            label={`Look wallpapers: ${custom.wallpaper ? "on" : "off"}`}
            onClick={() => setUiCustom((c) => ({ ...c, wallpaper: !c.wallpaper }))}
          />
        </Row>
        <Row title="Live background" note="The garden's scene, dimmed under the page so text stays readable.">
          <Switch
            on={custom.live.on}
            label={`Live background: ${custom.live.on ? "on" : "off"}`}
            onClick={() => setLive({ on: !custom.live.on })}
          />
        </Row>
        <Row title="Scene">
          <select
            aria-label="Live background scene"
            value={custom.live.scene}
            onChange={(event) => setLive({ scene: event.target.value })}
            className="rounded border-[3px] border-gray-900 bg-field px-2 py-1 font-mono text-[11px] text-ink"
          >
            <option value="garden">Follow the garden</option>
            {BACKDROP_THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Page color over it" note="Higher is clearer text, lower shows more scenery. Never below 60%.">
          <input
            type="range"
            aria-label="Page color over the scenery"
            min={60}
            max={95}
            value={Math.round(custom.live.dim * 100)}
            onChange={(event) => setLive({ dim: Number(event.target.value) / 100 })}
            className="w-32"
          />
          <span className="w-10 text-right font-mono text-xs text-ink">{Math.round(custom.live.dim * 100)}%</span>
        </Row>
        <Row title="Still picture" note="A near-still frame instead of the moving scene.">
          <Switch
            on={custom.live.still}
            label={`Still picture: ${custom.live.still ? "on" : "off"}`}
            onClick={() => setLive({ still: !custom.live.still })}
          />
        </Row>
      </Section>

      <Section title="Garden scenery">
        {["Particles", "Sky & ground", "The tree", "The climb"].map((group) => (
          <div key={group}>
            <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
              {group}
            </p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {SCENE_LAYERS.filter((l) => l.group === group).map((layer) => (
                <Row key={layer.id} title={layer.label}>
                  <Switch
                    on={layers.isOn(layer.id)}
                    label={`${layer.label}: ${layers.isOn(layer.id) ? "on" : "off"}`}
                    onClick={() => layers.toggle(layer.id)}
                  />
                </Row>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={btn} onClick={() => layers.setAll(true, [])}>
            All on
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => layers.setAll(false, SCENE_LAYERS.map((l) => l.id))}
          >
            All off
          </button>
        </div>
      </Section>

      <Section title={`Charms · ${treeSpecies(sun.species).label} at ${sun.height} ft`}>
        {charms.map((charm, index) => {
          const unlocked = sun.cheats.includes(charm.word);

          return (
            <Row
              key={charm.word}
              title={charm.label}
              note={`${CHARM_KINDS[index]?.label} · ${unlocked ? "unlocked" : `grows at ${charm.height} ft`} · word: ${charm.word}`}
            >
              {unlocked ? (
                <Switch
                  on={sun.activeCheats.includes(charm.word)}
                  label={`${charm.label}: ${sun.activeCheats.includes(charm.word) ? "on" : "off"}`}
                  onClick={() => sun.redeemCheat(charm.word)}
                />
              ) : (
                <span className="font-mono text-[10px] font-bold uppercase text-muted">locked</span>
              )}
            </Row>
          );
        })}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={btn} onClick={() => sun.testArmCharms(true)}>
            Arm all unlocked
          </button>
          <button type="button" className={btn} onClick={() => sun.testArmCharms(false)}>
            Disarm all
          </button>
        </div>
        <p className="pt-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
          Put the tree at a stage
        </p>
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((name, index) => (
            <button
              key={name}
              type="button"
              className={btn}
              onClick={() => sun.testSetFertilizer(ferts[index] ?? 0)}
            >
              {name}
            </button>
          ))}
        </div>
        <Row title="Packets fed" note="Slide to set the planted tree's growth directly (0 to 3,000).">
          <input
            type="range"
            aria-label="Packets fed to the planted tree"
            min={0}
            max={3000}
            step={10}
            value={sun.fertilizer}
            onChange={(event) => sun.testSetFertilizer(Number(event.target.value))}
            className="w-40"
          />
          <span className="w-12 text-right font-mono text-xs text-ink">{sun.fertilizer}</span>
        </Row>
      </Section>

      {!garden && (
        <Section title="Tree colors">
          {TREE_SPECIES.map((species) => (
            <VariantRow key={species.id} species={species.id} />
          ))}
        </Section>
      )}

      {!garden && (
        <Section title="Backup">
          <p className="text-xs leading-5 text-muted">
            Copy all of these customizations as text, or paste a saved set back in.
          </p>
          <textarea
            aria-label="Customizations as text"
            value={backup}
            onChange={(event) => setBackup(event.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full rounded border-[3px] border-gray-900 bg-field p-2 font-mono text-[11px] text-ink"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={exportAll}>
              Export
            </button>
            <button type="button" className={btn} onClick={importAll}>
              Import
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setUiCustom(() => DEFAULT_UI_CUSTOM);
                layers.setAll(false, PARTICLE_LAYERS);
                setNote("Everything is back to how it started.");
              }}
            >
              Reset everything
            </button>
            {note && <span className="text-xs font-bold text-ink">{note}</span>}
          </div>
        </Section>
      )}
    </div>
  );
}

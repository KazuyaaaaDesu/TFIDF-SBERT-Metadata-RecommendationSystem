/**
 * SETTINGS — the preferences tab.
 *
 * Citation style chosen here becomes the default for the context
 * menu's "Copy as → Formatted citation", and the copy-behavior
 * toggles shape the BibTeX / DOI output. Preferences are stored in
 * this browser (utils/preferences.ts).
 *
 * Layout identity: "control panel" — a sticky section list on the
 * left, switchboard rows (label + hint, control, status lamp, reset)
 * on the right. Styles live in settings.css (`set-*`).
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import DevPanel from "../components/DevPanel";
import "./settings.css";

import { getRecommendationIndexStatus } from "../api";
import { useSiteMode } from "../state/siteMode";
import { useLayoutPrefs } from "../state/layoutPrefs";
import {
  CITATION_STYLES,
  readSettings,
  writeSettings,
  type CitationStyle,
} from "../utils/preferences";

const SCOPE_KEY = "paperrec_connections_scope";

function readScope(): "local" | "web" {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "web"
      ? "web"
      : "local";
  } catch {
    return "local";
  }
}

type Lamp = "on" | "off" | "changed";

function SetRow({
  title,
  note,
  lamp,
  value,
  onReset,
  atDefault,
  stack,
  children,
}: {
  title: string;
  note?: string;
  lamp: Lamp;
  value?: string;
  onReset?: () => void;
  atDefault?: boolean;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`set-row${stack ? " set-row-stack" : ""}`}>
      <span className="set-lamp" data-state={lamp} aria-hidden="true" />
      <div className="set-label">
        <p className="set-label-t">{title}</p>
        {note && <p className="set-label-n">{note}</p>}
      </div>
      <div className="set-ctl">
        {value && <span className="set-val">{value}</span>}
        {children}
        {onReset && (
          <button
            type="button"
            className="set-reset"
            disabled={atDefault}
            onClick={onReset}
            aria-label={`Reset ${title} to default`}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function SetPanel({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-settings-section={id}
      id={`set-${id}`}
      data-set-section={title}
      className="set-panel"
    >
      <div className="set-panel-head">
        <h2 className="font-pixelify text-lg font-bold text-ink">{title}</h2>
        {count && <span className="set-panel-count">{count}</span>}
      </div>
      <div className="set-panel-body">{children}</div>
      <div className="set-panel-foot" />
      <div className="set-screws" />
    </section>
  );
}

const PREF_SECTIONS: [string, string][] = [
  ["set-mode", "Site mode"],
  ["set-interface", "Interface"],
  ["set-citation-style", "Citation style"],
  ["set-copy", "Copy behavior"],
  ["set-pet", "Pixel pet"],
  ["set-connections", "Similar papers"],
];

/* Presentation mode (the shipped build for the defense): no developer or
   mode controls, an account section with sign-out, and an About panel. */
const PRESENTATION_SECTIONS: [string, string][] = [
  ["set-account", "Account"],
  ["set-mode", "Mode"],
  ["set-interface", "Interface"],
  ["set-citation-style", "Citation style"],
  ["set-copy", "Copy behavior"],
  ["set-connections", "Similar papers"],
  ["set-about", "About"],
];

function readAccount(): { name: string; email: string } {
  try {
    const email = window.localStorage.getItem("paperrec_user_email") ?? "";
    const name =
      window.localStorage.getItem("paperrec_user_name") ||
      (email ? email.split("@")[0] : "");

    return { name, email };
  } catch {
    return { name: "", email: "" };
  }
}

function jump(id: string) {
  document
    .getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const { mode, setMode } = useSiteMode();
  const presenting = mode === "presentation";
  // The Developer page does not exist in the shipped build.
  const tab = !presenting && params.get("tab") === "dev" ? "dev" : "preferences";
  const navigate = useNavigate();
  const [account] = useState(readAccount);
  const [indexStale, setIndexStale] = useState<boolean | null>(null);

  useEffect(() => {
    if (!presenting) return;
    getRecommendationIndexStatus()
      .then((status) => setIndexStale(status.stale))
      .catch(() => setIndexStale(null));
  }, [presenting]);

  function signOut() {
    try {
      for (const key of ["paperrec_logged_in", "paperrec_user_email", "paperrec_user_name", "paperrec_remember_me"]) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Best-effort.
    }
    navigate("/");
  }
  const { prefs, setNavLabels } = useLayoutPrefs();

  const [settings, setSettings] = useState(readSettings);
  const [scope, setScope] = useState<"local" | "web">(readScope);
  const [petVisible, setPetVisible] = useState(() => {
    try {
      return window.localStorage.getItem("paperrec_pet_visible") !== "0";
    } catch {
      return true;
    }
  });

  const mainRef = useRef<HTMLDivElement>(null);
  const [devSections, setDevSections] = useState<[string, string][]>([]);

  // The Developer panel owns its own sections; list them in the rail.
  useEffect(() => {
    if (tab !== "dev") return;
    const root = mainRef.current;
    if (!root) return;

    const scan = () => {
      const found: [string, string][] = [];
      root
        .querySelectorAll<HTMLElement>("[data-set-section]")
        .forEach((el, i) => {
          if (!el.id) el.id = `set-dev-${i}`;
          found.push([el.id, el.dataset.setSection ?? ""]);
        });
      setDevSections((prev) =>
        JSON.stringify(prev) === JSON.stringify(found) ? prev : found
      );
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tab]);

  function togglePet() {
    const next = !petVisible;
    setPetVisible(next);

    try {
      window.localStorage.setItem(
        "paperrec_pet_visible",
        next ? "1" : "0"
      );
    } catch {
      // Best-effort.
    }

    window.dispatchEvent(new Event("paperrec-settings-changed"));
  }

  function update(patch: Parameters<typeof writeSettings>[0]) {
    setSettings(writeSettings(patch));
  }

  function updateScope(next: "local" | "web") {
    setScope(next);

    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // Best-effort.
    }
  }

  const railItems = tab === "dev" ? devSections : presenting ? PRESENTATION_SECTIONS : PREF_SECTIONS;
  const modeLabel =
    mode === "library"
      ? "Library"
      : mode === "presentation"
        ? "Presentation"
        : "Researcher";
  const citeLabel =
    CITATION_STYLES.find((s) => s.id === settings.citationStyle)?.label ??
    settings.citationStyle;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5">
      <header>
        <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
          {presenting ? "Account" : "Preferences"}
        </p>

        <h1 className="font-pixelify mt-2 text-3xl font-bold leading-none text-ink">
          Settings
        </h1>

        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          {presenting
            ? "Your account and the preferences this browser remembers. The citation style sets the default for Copy as → Formatted citation in the paper context menu."
            : "These preferences stay in this browser. The citation style sets the default for Copy as → Formatted citation in the paper context menu."}
        </p>

        {!presenting && (
        <div role="tablist" aria-label="Settings pages" className="mt-4 flex gap-1.5">
          {(
            [
              ["preferences", "Preferences"],
              ["dev", "Developer"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setParams(id === "dev" ? { tab: "dev" } : {})}
              className={`rounded border-[3px] border-gray-900 px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
                tab === id ? "bg-accent text-onAccent" : "bg-surface text-ink hover:bg-accentSoft"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        )}
      </header>

      <div className="set-shell">
        <nav className="set-rail" aria-label="Settings sections">
          <p className="set-rail-title">Sections</p>
          {railItems.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="set-chip"
              onClick={() => jump(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="set-main" ref={mainRef}>
          {tab === "preferences" && (
          <div className="set-legend" aria-hidden="true">
            <span><i className="set-lamp" data-state="on" /> On</span>
            <span><i className="set-lamp" data-state="off" /> Off</span>
            <span><i className="set-lamp" data-state="changed" /> Changed from default</span>
          </div>
          )}

          {tab === "dev" && <DevPanel />}

          {tab === "preferences" && (
            <>

              {presenting && (
                <SetPanel id="account" title="Account" count={account.email || undefined}>
                  <SetRow title="Name" note="Shown on this device only." lamp="on" value={account.name || "Not set"}>
                    <span />
                  </SetRow>
                  <SetRow title="Email" note="The address you signed in with." lamp="on" value={account.email || "Not set"}>
                    <span />
                  </SetRow>
                  <SetRow
                    title="Session"
                    note="Signing out returns you to the sign-in page. It does not delete the repository or your saved papers."
                    lamp="on"
                    value="Signed in"
                  >
                    <button type="button" className="set-reset" style={{ opacity: 1 }} onClick={signOut}>
                      Sign out
                    </button>
                  </SetRow>
                </SetPanel>
              )}

              {presenting && (
                <SetPanel id="mode" title="Mode" count={modeLabel}>
                  <SetRow
                    title="Site mode"
                    note="Presentation is the shipped build. Library is the visitor-friendly librarian; Researcher is the full tool. Your own settings come back when you leave Presentation."
                    lamp="on"
                    stack
                  >
                    <div role="radiogroup" aria-label="Site mode" className="set-seg w-full flex-col sm:w-fit sm:flex-row">
                      {(
                        [
                          ["presentation", "PRESENTATION", "Shipped version"],
                          ["library", "LIBRARY", "Visitor view"],
                          ["researcher", "RESEARCHER", "Full pro tool"],
                        ] as const
                      ).map(([id, label, hint]) => (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={mode === id}
                          onClick={() => setMode(id)}
                          className={`flex flex-col px-3 py-2 text-left font-mono transition-colors pixel-ease ${
                            mode === id ? "bg-accent text-onAccent" : "text-muted hover:text-ink"
                          }`}
                        >
                          <span className="text-xs font-bold uppercase tracking-[0.1em]">{label}</span>
                          <span className="text-[10px] normal-case tracking-normal opacity-80">{hint}</span>
                        </button>
                      ))}
                    </div>
                  </SetRow>
                </SetPanel>
              )}

              {!presenting && (
              <SetPanel id="mode" title="Site mode" count={modeLabel}>
                <SetRow
                  title="Mode"
                  note="Library mode is the visitor-friendly librarian with the feature set the admin exposes; Researcher mode is the full pro tool and ignores feature locks. Switching is instant and persists in this browser."
                  lamp={mode === "researcher" ? "changed" : "on"}
                  stack
                >
                  <div
                    role="radiogroup"
                    aria-label="Site mode"
                    className="set-seg w-full flex-col sm:w-fit sm:flex-row"
                  >
                    {(
                      [
                        ["library", "LIBRARY", "Visitor view"],
                        ["researcher", "RESEARCHER", "Full pro tool"],
                        ["presentation", "PRESENTATION", "Shipped, free version"],
                      ] as const
                    ).map(([id, label, hint]) => {
                      const active = mode === id;

                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setMode(id)}
                          className={`border-[3px] px-4 py-2 text-left transition-colors pixel-ease ${
                            active
                              ? "border-gray-900 bg-accent text-onAccent"
                              : "border-transparent text-muted hover:text-ink"
                          }`}
                        >
                          <span className="block font-mono text-xs font-bold uppercase tracking-[0.12em]">
                            {label}
                          </span>
                          <span
                            className={`mt-0.5 block text-[11px] ${
                              active ? "text-onAccent/80" : ""
                            }`}
                          >
                            {hint}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </SetRow>
              </SetPanel>
              )}

              <SetPanel id="interface" title="Interface">
                <SetRow
                  title="Menu labels in the top bar"
                  note="Turn this off for an icon-only navigation; the title of each item remains available as a tooltip and to screen readers."
                  lamp={prefs.navLabels ? "on" : "off"}
                  value={prefs.navLabels ? "On" : "Off"}
                  atDefault={prefs.navLabels}
                  onReset={() => setNavLabels(true)}
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={prefs.navLabels}
                      onChange={(event) => setNavLabels(event.target.checked)}
                    />
                    <span className="font-bold">Show menu labels in the top bar</span>
                  </label>
                </SetRow>
              </SetPanel>

              <SetPanel
                id="citation-style"
                title="Preferred citation style"
                count={citeLabel}
              >
                <SetRow
                  title="Citation style"
                  note="Used when copying a formatted citation from selected papers."
                  lamp={settings.citationStyle === "apa" ? "on" : "changed"}
                  atDefault={settings.citationStyle === "apa"}
                  onReset={() => update({ citationStyle: "apa" })}
                  stack
                >
                  <div
                    role="radiogroup"
                    aria-label="Preferred citation style"
                    className="grid w-full gap-2 sm:grid-cols-2"
                  >
                    {CITATION_STYLES.map((style) => {
                      const active = settings.citationStyle === style.id;

                      return (
                        <button
                          key={style.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-citation-style={style.id}
                          onClick={() =>
                            update({ citationStyle: style.id as CitationStyle })
                          }
                          className={`border-[3px] border-gray-900 p-3 text-left transition-colors pixel-ease ${
                            active
                              ? "bg-accent text-onAccent"
                              : "bg-surface text-ink hover:bg-accentSoft"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-sm font-bold">{style.label}</span>

                            {active && (
                              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em]">
                                Default
                              </span>
                            )}
                          </span>

                          <span
                            className={`mt-1 block text-xs leading-5 ${
                              active ? "text-onAccent" : "text-muted"
                            }`}
                          >
                            {style.sample}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </SetRow>
              </SetPanel>

              <SetPanel id="copy" title="Copy behavior">
                <SetRow
                  title="DOI links in citations"
                  note="Adds https://doi.org/… to APA, MLA, Chicago, and IEEE citations."
                  lamp={settings.citationIncludeDoi ? "on" : "off"}
                  value={settings.citationIncludeDoi ? "On" : "Off"}
                  atDefault={settings.citationIncludeDoi}
                  onReset={() => update({ citationIncludeDoi: true })}
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={settings.citationIncludeDoi}
                      onChange={(event) =>
                        update({
                          citationIncludeDoi: event.target.checked,
                        })
                      }
                    />
                    <span className="font-bold">
                      Include DOI links in formatted citations
                    </span>
                  </label>
                </SetRow>

                <SetRow
                  title="Abstracts in BibTeX"
                  note="Batch file exports from My Library are unchanged."
                  lamp={settings.bibtexIncludeAbstract ? "on" : "off"}
                  value={settings.bibtexIncludeAbstract ? "On" : "Off"}
                  atDefault={settings.bibtexIncludeAbstract}
                  onReset={() => update({ bibtexIncludeAbstract: true })}
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={settings.bibtexIncludeAbstract}
                      onChange={(event) =>
                        update({
                          bibtexIncludeAbstract: event.target.checked,
                        })
                      }
                    />
                    <span className="font-bold">
                      Include abstracts in copied BibTeX
                    </span>
                  </label>
                </SetRow>
              </SetPanel>

              {!presenting && (
              <SetPanel id="pet" title="Pixel pet">
                <SetRow
                  title="Pixel pet companion"
                  note="The pet sits in the corner, shows tips, and removes papers that you drag onto it. Turn it off for a distraction-free view."
                  lamp={petVisible ? "on" : "off"}
                  value={petVisible ? "On" : "Off"}
                  atDefault={petVisible}
                  onReset={() => {
                    if (!petVisible) togglePet();
                  }}
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={petVisible}
                      onChange={togglePet}
                    />
                    <span className="font-bold">Show the pixel pet companion</span>
                  </label>
                </SetRow>
              </SetPanel>
              )}

              <SetPanel id="connections" title="Similar-papers scope" count={scope}>
                <SetRow
                  title="Default scope"
                  note="Which source the connections pane opens with. Local is the repository graph; Web reads live from OpenAlex."
                  lamp={scope === "local" ? "on" : "changed"}
                  atDefault={scope === "local"}
                  onReset={() => updateScope("local")}
                >
                  <div
                    role="radiogroup"
                    aria-label="Default connections scope"
                    className="set-seg"
                  >
                    {(["local", "web"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={scope === option}
                        onClick={() => updateScope(option)}
                        className={`px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                          scope === option
                            ? "bg-accent text-onAccent"
                            : "text-muted hover:text-ink"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </SetRow>
              </SetPanel>

              {presenting && (
                <SetPanel id="about" title="About">
                  <SetRow
                    title="Re:Search"
                    note="A paper repository and recommendation system for BulSU BSMCS students. Papers are ranked by a TF-IDF lexical signal, an S-BERT semantic signal and a metadata signal, blended under configurable weights."
                    lamp="on"
                  >
                    <span />
                  </SetRow>
                  <SetRow
                    title="Recommendation index"
                    note="The vectors behind search and recommendations. It is rebuilt from the Repository when papers change."
                    lamp={indexStale === null ? "off" : indexStale ? "changed" : "on"}
                    value={indexStale === null ? "Checking…" : indexStale ? "Needs rebuild" : "Up to date"}
                  >
                    <span />
                  </SetRow>
                </SetPanel>
              )}

              {!presenting && (
              <p className="text-xs text-muted">
                Current mode:{" "}
                <span className="font-bold text-ink">{modeLabel}</span>{" "}
                — switch it in the Site mode section above.
              </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

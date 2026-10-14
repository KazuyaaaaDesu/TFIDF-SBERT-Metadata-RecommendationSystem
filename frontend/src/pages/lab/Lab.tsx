import { useEffect, useRef, useState } from "react";
import { useNerdButtons } from "../../state/nerdButtons";
import { useSiteMode } from "../../state/siteMode";
import {
  comparePipelinesStream,
  webComparePipelines,
  type CompareResponse,
  type Paper,
  type SweepWeights,
} from "../../api";
import BattleJudge from "../../components/BattleJudge";
import BattleDifferencesPanel from "../../components/BattleDifferences";
import RecipeSweep from "../../components/RecipeSweep";
import { LabDial, MixBar, TriangleLocator } from "../../components/LabMix";
import RepositoryPickerDialog from "../../components/RepositoryPickerDialog";
import { pipelineConfigs, adjustDialAllocation, normalizeDialPositions } from "../../data/pipelineConfigs";
import { usePipelineMode } from "../../state/pipelineMode";
import PixelProgress from "../../components/retro/PixelProgress";
import FreqBars from "../../components/retro/FreqBars";
import Pagination from "../../components/retro/Pagination";
import TreeOfKnowledge from "../../components/retro/TreeOfKnowledge";
import RetroDialog from "../../components/retro/RetroDialog";
import StatsForNerds from "../../components/StatsForNerds";
import { PageHeader } from "../../components/ui";
import { ArrowRight } from "../../components/retro/PixelIcons";
import ResponsiveLabel, { labelProps } from "../../components/ResponsiveLabel";
import { FlaskConical, Radar, Sigma, Sprout } from "lucide-react";

/* ============================================================
   LAB — the recipe workshop.
   Build a custom algorithm recipe from the three signals with
   freely adjustable percentages, save recipes, then simulate a
   battle against the six presets. Every simulation is recorded
   in a local leaderboard with a win tally like the Arena's.
   ============================================================ */

interface Recipe {
  id: string;
  name: string;
  weights: { tfidf: number; sbert: number; metadata: number };
  /** Pre-loaded starter recipe, deletable like any other. */
  preset?: boolean;
}

interface LabRun {
  recipeName: string;
  weights: { tfidf: number; sbert: number; metadata: number };
  winnerPipelineId: string;
  winnerValue: number;
  createdAt: string;
  /** Whether the leader cleared the runner-up by the decisive margin.
      Absent on runs saved before verdicts existed (counted separately). */
  decisive?: boolean | null;
  contenders?: string[];
}

const RECIPES_KEY = "paperrec_lab_recipes";
const BATTLES_KEY = "paperrec_lab_battles";
const SEEDED_KEY = "paperrec_lab_recipes_seeded";

/* Battle history shows five simulations per page, matching the
   Arena's records table. */
const LAB_RUNS_PAGE_SIZE = 5;

/* Pre-loaded recipes: two signal purists, an even split, the
   learned weights from the citation benchmark, and a
   metadata-heavy mix. They load into the dials in one click and
   battle like any saved recipe. */
const PRESET_RECIPES: Recipe[] = [
  {
    id: "preset-lexical",
    name: "Lexical Purist",
    weights: { tfidf: 100, sbert: 0, metadata: 0 },
    preset: true,
  },
  {
    id: "preset-semantic",
    name: "Semantic Purist",
    weights: { tfidf: 0, sbert: 100, metadata: 0 },
    preset: true,
  },
  {
    id: "preset-even",
    name: "Even Split",
    weights: { tfidf: 34, sbert: 33, metadata: 33 },
    preset: true,
  },
  {
    id: "preset-learned",
    name: "Citation Winner",
    weights: { tfidf: 10, sbert: 90, metadata: 0 },
    preset: true,
  },
  {
    id: "preset-biblio",
    name: "Bibliographer",
    weights: { tfidf: 20, sbert: 20, metadata: 60 },
    preset: true,
  },
];

/** Seed the starter recipes once per browser. */
function initialRecipes(): Recipe[] {
  const stored = readRecipes();

  if (stored.length > 0) return stored;

  try {
    if (window.localStorage.getItem(SEEDED_KEY)) return stored;

    window.localStorage.setItem(SEEDED_KEY, "1");
    window.localStorage.setItem(
      RECIPES_KEY,
      JSON.stringify(PRESET_RECIPES),
    );
  } catch {
    // best-effort
  }

  return PRESET_RECIPES;
}

const LABEL: Record<string, string> = {
  tfidf: "TF-IDF",
  sbert: "S-BERT",
  metadata: "Metadata",
};

function readRecipes(): Recipe[] {
  try {
    const raw = window.localStorage.getItem(RECIPES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readBattles(): LabRun[] {
  try {
    const raw = window.localStorage.getItem(BATTLES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBattles(runs: LabRun[]) {
  try {
    window.localStorage.setItem(BATTLES_KEY, JSON.stringify(runs));
  } catch {
    // best-effort
  }
}

export default function Lab() {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(10);

  const [dials, setDials] = useState({ tfidf: 40, sbert: 40, metadata: 20 });
  const [recipeName, setRecipeName] = useState("My Recipe");
  const [recipes, setRecipes] = useState<Recipe[]>(initialRecipes);

  /* Experimental knobs beyond the three signals. */
  const [diversify, setDiversify] = useState(false);
  const [diversifyLambda, setDiversifyLambda] = useState(0.7);

  const [battle, setBattle] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // A newer simulation cancels the web fetch still in flight.
  const battleAbortRef = useRef<AbortController | null>(null);

  const [error, setError] = useState<string | null>(null);

  /* Web mode: battle the pipelines over live OpenAlex/Crossref/
     arXiv hits instead of the repository. */
  const [webMode, setWebMode] = useState(false);
  const [webSources, setWebSources] = useState(
    "openalex,crossref,arxiv",
  );
  const [webSort, setWebSort] = useState("relevance");
  const [openAccess, setOpenAccess] = useState(false);

  const [runs, setRuns] = useState<LabRun[]>(readBattles);
  const [runsPage, setRunsPage] = useState(1);



  const [tab, setTab] = useState<"recipe" | "sweep" | "garden">(
    "recipe",
  );

  /* The duel: a seed paper replaces the text query and is scored against
     its own references; progress is real (pipelines finished so far). */
  const [seedPaper, setSeedPaper] = useState<Paper | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [duelTab, setDuelTab] = useState<"results" | "differences" | "judge">("results");
  const [progress, setProgress] = useState<{ order: string[]; finished: string[] }>({
    order: [],
    finished: [],
  });

  const { setCustomWeights, setPipelineId } = usePipelineMode();

  /* Right-side Stats for Nerds pane: collapsible, and it traces the
     dial mix against a query you type here. */
  // Outside Researcher mode the Lab is a beta: the recipe bench, the duel and
  // the garden; no Sweep experiment and no Stats for Nerds.
  const { mode: siteMode } = useSiteMode();
  const beta = siteMode !== "researcher";
  const { on: nerdSwitch } = useNerdButtons();
  const nerdOn = nerdSwitch && !beta;
  const [statsOpenRaw, setStatsOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("paperrec_lab_stats") === "1";
    } catch {
      return false;
    }
  });
  const statsOpen = statsOpenRaw && nerdOn;

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "paperrec_lab_stats",
        statsOpen ? "1" : "0"
      );
    } catch {
      // best-effort
    }
  }, [statsOpen]);

  /* The trace follows the Recipe bench: the stats pane activates the
     custom pipeline and mirrors the bench dials into it. */
  useEffect(() => {
    if (statsOpen) {
      setPipelineId("custom");
      setCustomWeights(normalizeDialPositions(dials));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsOpen, setPipelineId, setCustomWeights]);

  /* Warn when the window is too narrow for the garden layout. */
  const gardenPanelRef = useRef<HTMLDivElement | null>(null);
  const [gardenNarrow, setGardenNarrow] = useState(false);
  useEffect(() => {
    const panel = gardenPanelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const measure = () => setGardenNarrow(panel.clientWidth < 720);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);



  const total = dials.tfidf + dials.sbert + dials.metadata;
  const normalized = {
    tfidf: total > 0 ? Math.round((dials.tfidf / total) * 1000) / 10 : 0,
    sbert: total > 0 ? Math.round((dials.sbert / total) * 1000) / 10 : 0,
    metadata: total > 0 ? Math.round((dials.metadata / total) * 1000) / 10 : 0,
  };

  const currentRecipeName =
    recipes.find((r) => r.name === recipeName)?.name ?? recipeName;

  function setDial(key: "tfidf" | "sbert" | "metadata", value: number) {
    setDials((current) => {
      const next = adjustDialAllocation(current, key, value);

      // Mirror the bench into the shared custom pipeline so the
      // stats trace follows the dials.
      setCustomWeights(normalizeDialPositions(next));

      return next;
    });
  }

  /** Set the dials (and the shared custom weights) without switching pipeline. */
  function applyMix(mix: { tfidf: number; sbert: number; metadata: number }) {
    setDials({ ...mix });
    setCustomWeights(normalizeDialPositions(mix));
  }

  /** Load a mix into the dials and activate the custom pipeline. */
  function loadMix(mix: { tfidf: number; sbert: number; metadata: number }) {
    setDials({ ...mix });
    setCustomWeights(normalizeDialPositions(mix));
    setPipelineId("custom");
  }

  function saveRecipe() {
    const name = recipeName.trim() || "Unnamed Recipe";
    const id = `${name}-${Date.now()}`;
    const recipe: Recipe = { id, name, weights: { ...dials } };
    setRecipes((current) => {
      const next = [...current, recipe];
      try {
        window.localStorage.setItem(RECIPES_KEY, JSON.stringify(next));
      } catch {
        // best-effort
      }
      return next;
    });
  }

  function deleteRecipe(id: string) {
    setRecipes((current) => {
      const next = current.filter((recipe) => recipe.id !== id);
      try {
        window.localStorage.setItem(RECIPES_KEY, JSON.stringify(next));
      } catch {
        // best-effort
      }
      return next;
    });
  }

  function loadRecipe(recipe: Recipe) {
    setRecipeName(recipe.name);
    loadMix(recipe.weights);
  }

  async function runBattle() {
    const useSeed = Boolean(seedPaper && !webMode);

    if (!useSeed && !query.trim()) {
      setError("Enter a query or pick a seed paper to start the simulation.");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress({ order: [], finished: [] });
    setDuelTab("results");

    battleAbortRef.current?.abort();
    const controller = new AbortController();
    battleAbortRef.current = controller;

    try {
      const customWeights = {
        tfidf: normalized.tfidf,
        sbert: normalized.sbert,
        metadata: normalized.metadata,
      };

      const data = webMode
        ? await webComparePipelines({
            q: query.trim(),
            topK,
            sources: webSources || "openalex,crossref,arxiv",
            sort: webSort,
            openAccess,
            customWeights,
            signal: controller.signal,
          })
        : await comparePipelinesStream(
            {
              query: useSeed ? undefined : query.trim(),
              seedPaperId: useSeed ? seedPaper!.id : undefined,
              topK,
              customWeights,
              mmrLambda: diversify ? diversifyLambda : undefined,
              recordBattle: false,
            },
            (event) => {
              if (event.event === "start") {
                setProgress({ order: event.pipelines, finished: [] });
              } else if (event.event === "pipeline") {
                setProgress((current) => ({
                  ...current,
                  finished: [...current.finished, event.id],
                }));
              }
            },
            controller.signal,
          );

      if (controller.signal.aborted) return;

      setBattle(data);

      if (data.winner) {
        const run: LabRun = {
          recipeName: currentRecipeName,
          weights: { ...normalized },
          winnerPipelineId: data.winner.pipeline_id,
          winnerValue: data.winner.value,
          createdAt: new Date().toISOString(),
          decisive: data.winner.decisive ?? null,
          contenders: data.winner.contenders,
        };
        const next = [run, ...runs].slice(0, 60);
        setRuns(next);
        writeBattles(next);
        setRunsPage(1);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;

      setBattle(null);
      setError(
        err instanceof Error ? err.message : "Lab battle failed.",
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  // ------------------------------------------------------------
  // Leaderboard: win tally across presets + recipes
  // ------------------------------------------------------------

  const tally = new Map<string, number>();
  const tooClose = runs.filter((run) => run.decisive === false).length;
  const unscored = runs.filter((run) => run.decisive == null).length;
  const decisiveCount = runs.length - tooClose - unscored;

  for (const run of runs) {
    // Only decisive wins count: a leader inside the margin is a coin flip.
    if (run.decisive !== true) continue;

    const key =
      run.winnerPipelineId === "custom"
        ? `custom:${run.recipeName}`
        : run.winnerPipelineId;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const tallyRows = [...tally.entries()]
    .map(([key, wins]) => ({ key, wins }))
    .sort((a, b) => b.wins - a.wins);

  /* Battle history pages five simulations at a time. */
  const runsPageCount = Math.max(
    1,
    Math.ceil(runs.length / LAB_RUNS_PAGE_SIZE),
  );
  const safeRunsPage = Math.min(runsPage, runsPageCount);
  const pagedRuns = runs.slice(
    (safeRunsPage - 1) * LAB_RUNS_PAGE_SIZE,
    safeRunsPage * LAB_RUNS_PAGE_SIZE,
  );

  function tallyLabel(key: string): string {
    if (key.startsWith("custom:")) return key.slice("custom:".length);
    const config = pipelineConfigs.find((c) => c.id === key);
    return config?.codename ?? key;
  }

  const configById = new Map(
    pipelineConfigs.map((config) => [config.id, config]),
  );

  function pipelineLabel(id: string): string {
    if (id === "custom") return currentRecipeName;
    return configById.get(id)?.codename ?? id;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1560px] items-start gap-4">
      <div className="lab-sheet min-w-0 flex-1">
      <PageHeader
        eyebrow="Lab"
        title="Re:Search Laboratory"
        description={
          beta
            ? "Beta: combine the three signals into your own recipe and duel it against the six presets on one query or seed paper. The garden is here too. More experiments arrive after the beta."
            : "Combine the three signals into your own recipe, duel it against the six presets on one query or seed paper, or sweep the whole blend triangle to see where quality lives. Experiments here are not saved to the Arena's log."
        }
      />

      <div className="mt-4" aria-hidden="true">
        <div className="lab-hazard" />
        <div className="lab-strip">
          <span>{beta ? "Beta · early access" : "Experimental area"}</span>
          <span>Notebook entry no. {String(runs.length + 1).padStart(3, "0")}</span>
          <span>Results here are not recorded to the Arena</span>
        </div>
      </div>

      <div className="mt-5 flex" role="tablist" aria-label="Lab sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "recipe"}
          onClick={() => setTab("recipe")}
          {...labelProps("Re:Search Laboratory")}
          className={`flex items-center justify-center rounded-l border-[3px] border-gray-900 px-3 py-1.5 text-sm font-semibold transition pixel-ease ${
            tab === "recipe"
              ? "bg-accent text-onAccent"
              : "bg-surface text-ink hover:bg-accentSoft"
          }`}
        >
          <ResponsiveLabel icon={FlaskConical}>Re:Search Laboratory</ResponsiveLabel>
        </button>
        {!beta && (
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sweep"}
          onClick={() => setTab("sweep")}
          {...labelProps("Sweep")}
          className={`-ml-[3px] flex items-center justify-center border-[3px] border-gray-900 px-3 py-1.5 text-sm font-semibold transition pixel-ease ${
            tab === "sweep"
              ? "bg-accent text-onAccent"
              : "bg-surface text-ink hover:bg-accentSoft"
          }`}
        >
          <ResponsiveLabel icon={Radar}>Sweep</ResponsiveLabel>
        </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={tab === "garden"}
          onClick={() => setTab("garden")}
          {...labelProps("Garden")}
          className={`-ml-[3px] flex items-center justify-center rounded-r border-[3px] border-gray-900 px-3 py-1.5 text-sm font-semibold transition pixel-ease ${
            tab === "garden"
              ? "bg-accent text-onAccent"
              : "bg-surface text-ink hover:bg-accentSoft"
          }`}
        >
          <ResponsiveLabel icon={Sprout}>Garden</ResponsiveLabel>
        </button>

        {nerdOn && (
        <button
          type="button"
          data-nerd=""
          aria-pressed={statsOpen}
          onClick={() => setStatsOpen((value) => !value)}
          title="Toggle the live Stats for Nerds panel (traces the dial mix)"
          aria-label="Stats for Nerds"
          className={`nerd-glitch-in ml-auto flex items-center gap-1 rounded border-[3px] border-gray-900 px-3 py-1.5 text-xs font-bold transition-colors pixel-ease ${
            statsOpen
              ? "bg-accent text-onAccent"
              : "bg-surface text-ink hover:bg-accentSoft"
          }`}
        >
          <ResponsiveLabel icon={Sigma}>Stats for Nerds</ResponsiveLabel>
          <span aria-hidden="true">{statsOpen ? "≫" : "≪"}</span>
        </button>
        )}
      </div>

      {tab === "recipe" && (
      <div className="mt-7 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        {/* ================= RECIPE BENCH ================= */}
        <section className="lab-card">
          <p className="lab-label lab-label--hot">Recipe bench</p>

          {(["tfidf", "sbert", "metadata"] as const).map((signal) => (
            <LabDial
              key={signal}
              signal={signal}
              value={dials[signal]}
              onChange={(value) => setDial(signal, value)}
            />
          ))}

          <div className="mb-3">
            <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
              Blend
            </p>
            <MixBar mix={dials} />
          </div>

          <div className="flex items-stretch gap-3">
          <div className="flex shrink-0 items-center">
            <TriangleLocator mix={dials} onChange={applyMix} width={116} />
          </div>
          <div className="min-w-0 flex-1 rounded-sm border-[2px] border-dashed border-gray-900 bg-canvas p-2.5 font-mono text-[11px] leading-5 text-ink">
            <p className="font-bold text-accent">S(d) =</p>
            <p className="mt-1">
              {normalized.tfidf / 100} · s'_tfidf(d)
              {normalized.sbert > 0 && (
                <>
                  <br />+ {normalized.sbert / 100} · s'_sbert(d)
                </>
              )}
              {normalized.metadata > 0 && (
                <>
                  <br />+ {normalized.metadata / 100} · s'_meta(d)
                </>
              )}
            </p>
          </div>
          </div>

          {/* Experimental — extra knobs beyond the three signals */}
          <div className="mt-4 border-t-[2px] border-gray-200 pt-3">
            <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
              Experimental
            </p>

            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={diversify}
                onChange={(event) =>
                  setDiversify(event.target.checked)
                }
                className="h-4 w-4"
              />
              Diversify every pipeline (MMR)
            </label>

            <label className="mt-2 flex items-center gap-2 font-mono text-xs text-muted">
              λ
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={diversifyLambda}
                disabled={!diversify}
                onChange={(event) =>
                  setDiversifyLambda(Number(event.target.value))
                }
                aria-label="MMR lambda"
                className="min-w-0 flex-1 disabled:opacity-40"
              />
              <span className="w-8 shrink-0 text-right font-bold text-ink">
                {diversifyLambda.toFixed(2)}
              </span>
            </label>

            <button
              type="button"
              onClick={() => loadMix({ tfidf: 10, sbert: 90, metadata: 0 })}
              className="mt-2 rounded border-[2px] border-gray-900 bg-white px-2 py-1 font-mono text-[10px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              Load learned weights (10/90/0)
            </button>

            <p className="mt-2 text-[10px] leading-4 text-muted">
              Learned weights come from an 18-query OpenAlex citation
              benchmark, where they beat the 40/40/20 hybrid by about
              0.06 NDCG; they are a research preset, not the deployed
              default. Diversification applies to repository battles —
              web battles ignore it.
            </p>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={recipeName}
              onChange={(e) => setRecipeName(e.target.value)}
              placeholder="Recipe name"
              aria-label="Recipe name"
              className="min-w-0 flex-1 rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink placeholder:text-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={saveRecipe}
              className="shrink-0 rounded border-[3px] border-gray-900 bg-accent px-3 py-2 text-sm font-semibold text-onAccent hover:brightness-110"
            >
              Save
            </button>
          </div>

          {recipes.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {recipes.map((recipe) => (
                <li
                  key={recipe.id}
                  className="flex items-center gap-2 rounded border-2 border-gray-900 bg-surface px-2 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => loadRecipe(recipe)}
                    title={`${recipe.weights.tfidf}/${recipe.weights.sbert}/${recipe.weights.metadata}`}
                    className="min-w-0 flex-1 truncate text-left text-sm font-bold text-ink hover:text-accent"
                  >
                    {recipe.name}
                  </button>
                  {recipe.preset && (
                    <span className="shrink-0 rounded border border-gray-900 px-1 font-mono text-[9px] font-bold uppercase tracking-wide text-muted">
                      preset
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-xs text-muted">
                    {recipe.weights.tfidf}/
                    {recipe.weights.sbert}/
                    {recipe.weights.metadata}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteRecipe(recipe.id)}
                    aria-label={`Delete ${recipe.name}`}
                    className="shrink-0 rounded border-2 border-gray-900 bg-white px-1.5 font-mono text-xs font-bold text-ink hover:bg-accent hover:text-onAccent"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ================= BATTLE SIM ================= */}
        <section className="flex flex-col gap-4">
          <div className="lab-card">
            <p className="lab-label lab-label--hot">Duel</p>
            {/* Repository / Web scope switcher */}
            <div className="mb-3 flex items-center gap-2">
              {(["repository", "web"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setWebMode(scope === "web")}
                  aria-pressed={webMode === (scope === "web")}
                  className={`rounded border-2 border-gray-900 px-2.5 py-1 text-[11px] font-bold tracking-[0.15em] uppercase transition-colors ${
                    webMode === (scope === "web")
                      ? "bg-accent text-onAccent"
                      : "bg-white text-ink hover:bg-field"
                  }`}
                >
                  {scope === "repository" ? "Repository" : "Web"}
                </button>
              ))}

              {webMode && (
                <span className="ml-auto text-[10px] leading-4 text-muted">
                  Web battles run the pipelines against live
                  OpenAlex / Crossref / arXiv hits.
                </span>
              )}
            </div>

            <label className="filter-label" htmlFor="lab-query">
              Query
            </label>
            <input
              id="lab-query"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runBattle();
              }}
              placeholder="e.g. neural network text similarity"
              className="ui-input text-base"
            />

            {!webMode && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em]">Seed paper</span>
                {seedPaper ? (
                  <>
                    <span className="min-w-0 max-w-full truncate rounded border-[2px] border-gray-900 bg-canvas px-2 py-0.5 text-ink">
                      {seedPaper.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSeedPaper(null)}
                      className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-bold text-ink hover:bg-accentSoft"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-bold text-ink hover:bg-accentSoft"
                  >
                    Pick from repository
                  </button>
                )}
                <span>
                  {seedPaper
                    ? "Scored against its own references (Judge tab)."
                    : "Optional: your recipe is then scored on real quality."}
                </span>
              </div>
            )}
            <RepositoryPickerDialog
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(paper) => {
                setSeedPaper(paper);
                setPickerOpen(false);
              }}
            />
            {webMode && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2.5">
                  <span className="text-[10px] font-bold tracking-[0.15em] text-muted uppercase">
                    Sources
                  </span>

                  {(["openalex", "crossref", "arxiv", "doaj"] as const).map(
                    (source) => (
                      <label
                        key={source}
                        className="flex cursor-pointer items-center gap-1 text-xs font-medium text-ink"
                      >
                        <input
                          type="checkbox"
                          checked={webSources.includes(source)}
                          onChange={() =>
                            setWebSources((current) =>
                              current.includes(source)
                                ? current
                                    .split(",")
                                    .filter((item) => item !== source)
                                    .join(",")
                                : [current, source]
                                    .filter(Boolean)
                                    .join(",")
                            )
                          }
                          className=""
                        />
                        {source === "openalex"
                          ? "OpenAlex"
                          : source === "crossref"
                            ? "Crossref"
                            : source === "doaj"
                              ? "DOAJ"
                              : "arXiv"}
                      </label>
                    ),
                  )}
                </div>

                <label className="flex items-center gap-1 text-xs font-medium text-ink">
                  <input
                    type="checkbox"
                    checked={openAccess}
                    onChange={(e) => setOpenAccess(e.target.checked)}
                    className=""
                  />
                  Open access only
                </label>

                <label className="flex items-center gap-1 text-xs font-medium text-ink">
                  <span className="text-[10px] font-bold tracking-[0.15em] text-muted uppercase">
                    Sort
                  </span>
                  <select
                    value={webSort}
                    onChange={(e) => setWebSort(e.target.value)}
                    className="rounded border-[2px] border-gray-900 bg-field px-2 py-1 text-xs font-medium text-ink focus:outline-none"
                  >
                    <option value="relevance">Relevance</option>
                    <option value="year">Newest first</option>
                  </select>
                </label>
              </div>
            )}

            <div className="mt-3 flex items-end justify-between gap-3">
              <label className="filter-label" htmlFor="lab-topk">
                <span>Depth</span>
              </label>
              <select
                id="lab-topk"
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
                className="min-h-10 rounded border-[3px] border-gray-900 bg-field px-3 text-sm font-medium text-ink focus:outline-none"
              >
                <option value={5}>Top 5</option>
                <option value={10}>Top 10</option>
                <option value={15}>Top 15</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => void runBattle()}
              disabled={loading || !(query.trim() || (seedPaper && !webMode))}
              className="mt-4 w-full rounded border-[3px] border-gray-900 bg-accent px-4 py-2.5 text-sm font-semibold text-onAccent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Simulating battle…" : "Simulate battle"}
            </button>
          </div>

          {loading && (
            <div className="lab-card">
              <PixelProgress
                value={
                  webMode || progress.order.length === 0
                    ? null
                    : progress.finished.length / progress.order.length
                }
                stage={
                  webMode || progress.order.length === 0
                    ? "RUNNING 7 PIPELINES"
                    : `${progress.finished.length} OF ${progress.order.length} PIPELINES DONE`
                }
              />
              {progress.finished.length > 0 && (
                <p className="mt-2 font-mono text-[10px] text-muted">
                  Done: {progress.finished.map((id) => pipelineLabel(id)).join(" · ")}
                </p>
              )}
            </div>
          )}

          {error && <div className="status-error">{error}</div>}

          {!battle && !loading && !error && (
            <div className="lab-card lab-card--flat">
              <p className="lab-label">Specimen tray</p>
              <p className="text-xs leading-5 text-muted">
                A duel puts your recipe and the six presets side by side. Each takes a slot; the results fill them in.
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[...pipelineConfigs.map((config) => config.codename), "Your recipe"].map((name, index) => (
                  <li
                    key={name}
                    className={`mx-auto flex aspect-square w-full max-w-[112px] flex-col items-center justify-center rounded-full border-2 border-dashed px-2 text-center font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${
                      index === pipelineConfigs.length
                        ? "border-gray-900 bg-accentSoft text-ink"
                        : "border-gray-900/40 text-muted"
                    }`}
                  >
                    <span className="text-[9px] opacity-60">{String(index + 1).padStart(2, "0")}</span>
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {battle && !loading && (
            <>
              {battle.winner && (
                <div className="lab-card lab-card--ink">
                  <p className="lab-label lab-label--hot">Result</p>
                  <p className="animate-blink flex items-center gap-2 font-mono text-xs font-bold tracking-[0.3em] text-accent">
                    <ArrowRight className="h-3 w-3" />
                    {battle.winner.decisive === false
                      ? "TOO CLOSE TO CALL"
                      : "CONSENSUS LEADER"}
                  </p>
                  <p className="mt-2 font-mono text-sm font-bold tracking-[0.12em] text-onInk">
                    {pipelineLabel(battle.winner.pipeline_id)}
                  </p>
                  {battle.winner.decisive === false && (
                    <p className="mt-1 text-xs font-bold text-accent">
                      {(battle.winner.contenders ?? []).map(pipelineLabel).join(" · ")} are within{" "}
                      {Math.round((battle.winner.min_margin ?? 0.02) * 100)} points of each other. The name above is
                      only the nominal leader.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-onInk/70">
                    {(battle.winner.value * 100).toFixed(0)}% of
                    available consensus · avg consensus rank #
                    {battle.winner.avg_consensus_rank}
                  </p>
                </div>
              )}

              <div role="tablist" aria-label="Duel results" className="flex gap-1.5">
                {(
                  [
                    ["results", "Results"],
                    ["differences", "Why they differ"],
                    ["judge", "Judge"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={duelTab === id}
                    onClick={() => setDuelTab(id)}
                    className={`rounded border-[2px] border-gray-900 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em] ${
                      duelTab === id ? "bg-accent text-onAccent" : "bg-surface text-ink hover:bg-accentSoft"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {duelTab === "differences" && (
                <BattleDifferencesPanel differences={battle.differences} name={pipelineLabel} />
              )}
              {duelTab === "judge" && (
                <BattleJudge key={`${battle.query}-${battle.seed_paper_id}-${battle.pipelines.length}-${runs.length}`} battle={battle} name={pipelineLabel} />
              )}
              {duelTab === "results" && (
              <div className="lab-card">
                <p className="lab-label">Specimens</p>
                <ul className="space-y-2">
                  {battle.pipelines.map((pipeline) => {
                    const isCustom = pipeline.id === "custom";
                    const top = pipeline.results[0];
                    return (
                      <li
                        key={pipeline.id}
                        className={`rounded border-2 border-gray-900 px-3 py-2 ${
                          isCustom ? "bg-accentSoft" : "bg-canvas"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-bold text-ink">
                            {pipelineLabel(pipeline.id)}
                            {isCustom && (
                              <span className="ml-2 rounded border-2 border-gray-900 bg-accent px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.1em] text-onAccent">
                                YOURS
                              </span>
                            )}
                          </p>
                          <p className="shrink-0 font-mono text-xs text-muted">
                            {pipeline.results.length} results
                          </p>
                        </div>
                        {top && (
                          <p className="mt-1 truncate text-xs text-muted">
                            #1 {top.title ?? `Paper #${top.paper_id}`}
                            {top.year ? ` · ${top.year}` : ""}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              )}
            </>
          )}
        </section>

        {/* ================= LEADERBOARD ================= */}
        <section className="lab-card">
          <p className="lab-label">Logbook</p>

          {runs.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              No simulations yet. Run a battle and the winner takes
              a place on the board.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] leading-4 text-muted">
                Counts decisive wins only: {decisiveCount} decisive, {tooClose} too close to call
                {unscored > 0 ? `, ${unscored} older runs without a margin` : ""}.
              </p>
              {tallyRows.length === 0 && (
                <p className="text-sm leading-6 text-muted">
                  No decisive winner yet. Every battle so far was within the margin.
                </p>
              )}
              <ol className="divide-y divide-gray-200">
                {tallyRows.map((row, index) => (
                  <li
                    key={row.key}
                    className={`flex items-center gap-3 py-2 ${
                      index === 0 ? "bg-canvas" : ""
                    }`}
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-xs font-bold text-muted">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">
                      {tallyLabel(row.key)}
                    </span>
                    {index === 0 && (
                      <span className="animate-blink font-mono text-xs font-bold tracking-[0.2em] text-accent">
                        CHAMPION
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {row.wins} win{row.wins === 1 ? "" : "s"} ·{" "}
                      {Math.round((row.wins / Math.max(1, decisiveCount)) * 100)}%
                    </span>
                  </li>
                ))}
              </ol>

              <div className="mt-4 border-t-2 border-gray-200 pt-3">
                <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
                  Wins by entry
                </p>
                <FreqBars
                  data={tallyRows.map((row) => ({
                    label: tallyLabel(row.key),
                    value: row.wins,
                  }))}
                  ariaLabel="Win frequency per recipe or preset"
                />
              </div>

              <p className="mt-3 border-t-2 border-gray-200 pt-2 font-mono text-xs text-muted">
                Battle history · {runs.length} simulations · page{" "}
                {safeRunsPage} of {runsPageCount}
              </p>
              <ul className="mt-2 space-y-1">
                {pagedRuns.map((run, index) => (
                  <li
                    key={index}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate font-mono text-muted">
                      {run.decisive === false
                        ? "Too close · "
                        : ""}
                      {run.winnerPipelineId === "custom"
                        ? run.recipeName
                        : tallyLabel(run.winnerPipelineId)}
                    </span>
                    <span className="shrink-0 font-mono text-muted">
                      {new Date(run.createdAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </li>
                ))}
              </ul>

              {runsPageCount > 1 && (
                <Pagination
                  page={safeRunsPage}
                  pageCount={runsPageCount}
                  onPageChange={setRunsPage}
                  total={runs.length}
                  pageSize={LAB_RUNS_PAGE_SIZE}
                  className="mt-2 border-t-2 border-gray-200"
                />
              )}
            </>
          )}
        </section>
      </div>
      )}

      {!beta && tab === "sweep" && (
        <div className="mt-6">
          <RecipeSweep
            presetName={(id) => pipelineConfigs.find((c) => c.id === id)?.codename ?? id}
            onLoad={(weights: SweepWeights) => {
              setRecipeName(`Sweep ${weights.tfidf}/${weights.sbert}/${weights.metadata}`);
              loadMix(weights);
              setTab("recipe");
            }}
          />
        </div>
      )}

      {tab === "garden" && (
        <div ref={gardenPanelRef} className="mt-6">
          {gardenNarrow && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-lg border-[3px] border-gray-900 bg-accentSoft px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wide text-ink"
            >
              <span aria-hidden="true">{"\u26A0"}</span>
              <span>
                This window is narrow — the garden and its shops will
                stack, and the picker rows may scroll. Widen the
                window for the full layout.
              </span>
            </div>
          )}
          {/* garden heading */}
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-pixelify text-xl font-bold leading-none text-ink">
                The Garden
              </p>
              <p className="mt-1 max-w-xl text-xs leading-5 text-muted">
                The tree carries its own carved menu (six frames to choose from): Shop opens the sun
                shop, the skins and the themes, and the Almanac holds
                its charms (parts of the garden it unlocks as it grows),
                the scenery switches and how to earn sun. Three thousand
                packets take it from seed to ancient tree.
              </p>
            </div>
            <div
              className="flex items-center gap-1.5 rounded-lg border-[3px] border-gray-900 bg-surface px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-ink shadow-[2px_2px_0_rgba(0,0,0,0.12)]"
              title="Three thousand packets take the tree from seed to ancient maple"
            >
              <span aria-hidden="true" className="text-accent">
                {"\u25CF"}
              </span>
              3,000 packets
            </div>
          </div>

          {/* the Tree of Knowledge card is the whole garden; its
              toolbar hosts the menus (shop, skins, wallet). */}
          <TreeOfKnowledge />
        </div>
      )}
      </div>

      {/* Stats for Nerds — pop-up, like the repository picker */}
      <RetroDialog
        open={statsOpen}
        title="Stats for Nerds"
        size="lg"
        confirmLabel="Close"
        onConfirm={() => setStatsOpen(false)}
      >
        <StatsForNerds
          hideHeader
          contextNote="The trace follows the Lab's query and Top-K, through the Recipe bench dials — the same computation the search runs, ready for your methodology chapter."
          inputs={
            query.trim()
              ? { mode: "keyword", query, topK }
              : null
          }
        />
      </RetroDialog>
    </div>
  );
}
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  BarChart3,
  Download,
  FileText,
  Layers,
  Trophy,
} from "lucide-react";

import {
  discardTournament,
  exportTournament,
  reanalyzeTournament,
  GatherJob,
  gatherLiterature,
  getActiveTournament,
  getGatherStatus,
  getTournament,
  getTournamentHistory,
  getTournamentPool,
  getTournamentStatus,
  linkReferences,
  resumeTournament,
  startTournament,
  stopTournament,
  TournamentExportFormat,
  TournamentMetric,
  TournamentOutcome,
  TournamentPair,
  TournamentResult,
  TournamentRunStatus,
  TournamentRunSummary,
} from "../api";
import { pipelineConfigs, pipelineName } from "../data/pipelineConfigs";
import { intFieldError } from "../utils/intField.ts";
import {
  MAX_QUERIES,
  METRIC_PROFILE,
  describeRecommendation,
  estimateRuntime,
  recommendedSettings,
  requiredQueries,
  type MetricId,
} from "../utils/tournamentDefaults.ts";
import GatherProgress from "./GatherProgress";
import { useNerdButtons } from "../state/nerdButtons";
import ErrorBoundary from "./ErrorBoundary";
import TournamentInterpretation from "./TournamentInterpretation";
import TournamentNerdStats from "./TournamentNerdStats";
import TournamentProgress from "./TournamentProgress";
import RetroDialog from "./retro/RetroDialog";
import { Star } from "./retro/PixelIcons";

/* ============================================================
   TOURNAMENT PANEL
   The statistically grounded sibling of the battle. Same cabinet:
   a marquee, the screen (the rules + press start) and a high-score
   board; then a numbered rail of result tabs and a log.

   Every pipeline is scored on many leave-one-out citation queries
   against the paper's real references, and paired tests decide
   whether anyone is actually better. Unlike the single-bout
   consensus winner, a verdict here can honestly be "tie" or
   "inconclusive".
   ============================================================ */

const configById = new Map(pipelineConfigs.map((c) => [c.id, c]));

/* Mirror the server's limits (app/services/evaluation/tournament.py). */
const MAX_TOP_K = 50;
const MAX_MIN_REFS = 20;
const MAX_SEED = 2_147_483_647;
const MAX_LABEL = 60;

function name(id: string): string {
  const config = configById.get(id);
  return config ? pipelineName(config) : id;
}

const METRIC_LABELS: Record<TournamentMetric, string> = {
  ndcg: "nDCG@k",
  mrr: "MRR@k",
  recall: "Recall@20",
  hit: "Hit@k",
};

const OUTCOME_COPY: Record<TournamentOutcome, { title: string; blink: boolean }> =
  {
    winner: { title: "WINNER", blink: true },
    tie: { title: "TIE GROUP · NO SINGLE WINNER", blink: false },
    inconclusive: { title: "INCONCLUSIVE · NEED MORE QUERIES", blink: false },
  };

const RESULT_TABS = [
  { id: "verdict", label: "Verdict", icon: Trophy },
  { id: "board", label: "Leaderboard", icon: BarChart3 },
  { id: "pairwise", label: "Pairwise", icon: ArrowLeftRight },
  { id: "metrics", label: "Metrics", icon: Layers },
  { id: "interpret", label: "Interpretation", icon: FileText },
  { id: "data", label: "Data", icon: Download },
] as const;

type ResultTab = (typeof RESULT_TABS)[number]["id"];

const EXPORT_MIME: Record<TournamentExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  pairwise: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
};

const EXPORT_LABELS: Record<TournamentExportFormat, string> = {
  csv: "Per-query scores (CSV)",
  pairwise: "Pairwise tests (CSV)",
  json: "Full record (JSON)",
};

function fmt(value: number, digits = 3): string {
  return value.toFixed(digits);
}

/** "p < 0.001" / "p = 0.043" -- the operator belongs to the value. */
function fmtP(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}

/** Hand a text export to the browser under the server's filename. */
function saveText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Trim, drop control characters, collapse whitespace, cap the length. */
function cleanLabel(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL);
}

/* Shared control styles: light buttons for panels, dark for the screen. */
const BTN =
  "inline-flex h-9 items-center justify-center whitespace-nowrap rounded border-[3px] border-gray-900 bg-white px-3 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:cursor-not-allowed disabled:opacity-50";

const SCREEN_BTN =
  "rounded border-[2px] border-onInk/40 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onInk/80 transition-colors pixel-ease hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50";

const SCREEN_INPUT =
  "h-8 w-full min-w-0 rounded border-[2px] border-onInk/40 bg-gray-950 px-2 font-mono text-xs text-onInk placeholder:text-onInk/40 focus:border-accent focus:outline-none disabled:opacity-60";

function ScreenField({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  hint?: string;
  /** The line under the control, so every field in the row is as tall. */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      title={hint}
      className="flex min-w-0 flex-col gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80"
    >
      {label}
      {children}
      <span className="min-h-[2.2em] text-[10px] font-normal normal-case leading-[1.15] tracking-normal text-onInk/50">
        {note}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------
   WHOLE-NUMBER TEXT FIELDS
   A number input that coerces on every keystroke cannot be cleared
   and retyped (an empty box becomes 0 or the minimum straight away).
   These keep what the person typed as text, validate it strictly and
   say what is wrong, and only hand a number to the rest of the panel
   when the text really is a whole number in range.
   ------------------------------------------------------------ */

interface IntField {
  text: string;
  setText: (text: string) => void;
  /** The parsed number, or null while the text is invalid. */
  value: number | null;
  error: string | null;
  /** Tidy the text on blur ("007" -> "7", " 12 " -> "12"). */
  normalize: () => void;
}

function useIntField(initial: number, min: number, max: number): IntField {
  const [text, setText] = useState(String(initial));
  const error = intFieldError(text, min, max);

  return {
    text,
    setText,
    value: error ? null : Number(text.trim()),
    error,
    normalize: () => {
      if (!error) setText(String(Number(text.trim())));
    },
  };
}

/** A labelled text box for an IntField: range hint, or the error. */
function IntInput({
  label,
  hint,
  field,
  min,
  max,
  disabled,
  warning,
  fixedNote,
}: {
  label: string;
  hint: string;
  field: IntField;
  min: number;
  max: number;
  disabled: boolean;
  /** Valid but below the recommended minimum: amber, not an error. */
  warning?: string | null;
  /** The setting does not apply (e.g. Recall is always at 20). */
  fixedNote?: string;
}) {
  const id = `tournament-${label.toLowerCase().replace(/\W+/g, "-")}`;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label
        htmlFor={id}
        title={hint}
        className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={field.text}
        disabled={disabled || fixedNote != null}
        aria-invalid={field.error != null}
        aria-describedby={`${id}-note`}
        onChange={(e) => field.setText(e.target.value)}
        onBlur={field.normalize}
        className={`${SCREEN_INPUT} ${
          field.error ? "!border-red-400 focus:!border-red-400" : ""
        }`}
      />
      <p
        id={`${id}-note`}
        role={field.error ? "alert" : undefined}
        className={`min-h-[2.2em] text-[10px] leading-[1.15] ${
          field.error
            ? "font-bold text-red-300"
            : warning && !fixedNote
              ? "text-accent"
              : "text-onInk/50"
        }`}
      >
        {field.error ?? fixedNote ?? warning ?? `${min}\u2013${max}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------
   THE PANEL
   ------------------------------------------------------------ */

export default function TournamentPanel() {
  const queriesField = useIntField(60, 2, MAX_QUERIES);
  const topKField = useIntField(10, 1, MAX_TOP_K);
  const minRefsField = useIntField(3, 1, MAX_MIN_REFS);
  const seedField = useIntField(0, 0, MAX_SEED);
  const [metric, setMetric] = useState<TournamentMetric>("ndcg");
  const [label, setLabel] = useState("");
  /* Which pipelines compete. All six by default; two is a head-to-head
     (three times faster, and the way to resolve a close pair). */
  const [selected, setSelected] = useState<string[]>(
    pipelineConfigs.map((c) => c.id),
  );
  const pipelinesValid = selected.length >= 2;
  function togglePipeline(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : // keep the canonical order so runs are comparable
          pipelineConfigs.map((c) => c.id).filter((x) => x === id || current.includes(x)),
    );
  }

  const inputsValid =
    pipelinesValid &&
    queriesField.value != null &&
    topKField.value != null &&
    minRefsField.value != null &&
    seedField.value != null;

  /* Values used while the text is mid-edit and invalid: the last good
     number, so the eligible count and copy never flash NaN. */
  const nQueries = queriesField.value ?? 60;
  const minRefs = minRefsField.value ?? 3;

  const [pool, setPool] = useState<{
    available: number;
    required: number;
  } | null>(null);
  /* The tournament job running (or paused / failed) on the server. */
  const [run, setRun] = useState<TournamentRunStatus | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const running = run?.status === "running";
  const [linking, setLinking] = useState(false);
  const [job, setJob] = useState<GatherJob | null>(null);
  const gathering = job?.state === "running";
  const [gatherOpen, setGatherOpen] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [poolTick, setPoolTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TournamentResult | null>(null);
  const [history, setHistory] = useState<TournamentRunSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [tab, setTab] = useState<ResultTab>("verdict");

  const busy = running || gathering || linking || runBusy;

  /* Per-metric starting minimums: how many queries the metric needs to
     tell two pipelines apart, its top-k, and the references a query must
     have. Applied when the metric changes and once the eligible count is
     known; "Use recommended" re-applies them after manual edits. */
  const profile = METRIC_PROFILE[metric as MetricId];
  const recommendation = recommendedSettings(
    metric as MetricId,
    pool?.available ?? null,
  );

  function applyRecommended(forMetric: MetricId, available: number | null) {
    const rec = recommendedSettings(forMetric, available);
    queriesField.setText(String(rec.queries));
    topKField.setText(String(rec.topK));
    minRefsField.setText(String(rec.minRefs));
  }

  function chooseMetric(next: TournamentMetric) {
    setMetric(next);
    applyRecommended(next as MetricId, pool?.available ?? null);
  }

  /* Once the eligible count first arrives, start from the recommended
     numbers (the boxes began at generic defaults). */
  const autoApplied = useRef(false);
  useEffect(() => {
    if (pool != null && !autoApplied.current) {
      autoApplied.current = true;
      applyRecommended(metric as MetricId, pool.available);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  const needed = requiredQueries(profile.sd);
  const queriesWarning =
    queriesField.value != null && queriesField.value < needed
      ? `Under the ~${needed} advised`
      : null;
  const minRefsWarning =
    minRefsField.value != null && minRefsField.value < profile.minRefs
      ? `Best with ${profile.minRefs}+`
      : null;

  function refreshHistory() {
    getTournamentHistory(1, 100)
      .then((data) => {
        setHistory(data.runs);
        setHistoryTotal(data.total);
      })
      .catch(() => {
        setHistory([]);
        setHistoryTotal(0);
      });
  }

  useEffect(refreshHistory, []);

  useEffect(() => {
    let cancelled = false;
    getTournamentPool(minRefs)
      .then((data) => {
        if (!cancelled)
          setPool({
            available: data.available,
            required: data.required_n_for_0_05,
          });
      })
      .catch(() => {
        if (!cancelled) setPool(null);
      });
    return () => {
      cancelled = true;
    };
  }, [minRefs, poolTick]);

  async function start() {
    if (
      queriesField.value == null ||
      topKField.value == null ||
      minRefsField.value == null ||
      seedField.value == null
    ) {
      setError("Fix the highlighted settings before starting.");
      return;
    }

    setRunBusy(true);
    setError(null);
    setLinkNote(null);
    try {
      // Returns at once; the run lives on the server from here on.
      setRun(
        await startTournament({
          pipelines: selected,
          topK: topKField.value,
          nQueries: queriesField.value,
          minRefs: minRefsField.value,
          primaryMetric: metric,
          seed: seedField.value,
          label: cleanLabel(label),
        }),
      );
      setResult(null);
      setPollFailed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tournament failed.");
    } finally {
      setRunBusy(false);
    }
  }

  /* One status check. A finished run becomes the shown result; a failed
     check (offline, laptop just woke) only flags the connection -- the
     run itself is unaffected and the next poll recovers. */
  const pollOnce = useCallback(async (id: number) => {
    try {
      const status = await getTournamentStatus(id);
      setPollFailed(false);

      if (status.status === "done") {
        setResult(await getTournament(id));
        setTab("verdict");
        setRun(null);
        refreshHistory();
      } else {
        setRun(status);
      }
    } catch {
      setPollFailed(true);
    }
  }, []);

  /* Re-attach to a run left going (page reload, tab reopened). */
  useEffect(() => {
    getActiveTournament()
      .then((active) => {
        if (active.run) setRun(active.run);
      })
      .catch(() => undefined);
  }, []);

  /* Follow a running tournament. Polling also fires the moment the tab
     is visible again or the network returns, so waking a sleeping laptop
     shows the true state straight away instead of after the next tick. */
  useEffect(() => {
    if (run?.status !== "running") return;
    const id = run.run_id;
    const timer = window.setInterval(() => void pollOnce(id), 1500);
    const wake = () => {
      if (document.visibilityState !== "hidden") void pollOnce(id);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [run?.status, run?.run_id, pollOnce]);

  async function stopRun() {
    if (!run) return;
    setRunBusy(true);
    try {
      await stopTournament(run.run_id);
      await pollOnce(run.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pause.");
    } finally {
      setRunBusy(false);
    }
  }

  async function resumeRun() {
    if (!run) return;
    setRunBusy(true);
    setError(null);
    try {
      setRun(await resumeTournament(run.run_id));
      setPollFailed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume.");
    } finally {
      setRunBusy(false);
    }
  }

  async function discardRun() {
    if (!run) return;
    setRunBusy(true);
    try {
      await discardTournament(run.run_id);
      setRun(null);
      refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not discard.");
    } finally {
      setRunBusy(false);
    }
  }

  async function link() {
    setLinking(true);
    setError(null);
    setLinkNote(null);
    try {
      const out = await linkReferences();
      setLinkNote(
        `Linked ${out.rows_linked} references to library papers` +
          (out.failed_batches
            ? ` (${out.failed_batches} lookup batch(es) failed; try again).`
            : "."),
      );
      setPoolTick((tick) => tick + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Linking failed.");
    } finally {
      setLinking(false);
    }
  }

  async function gather() {
    setGatherOpen(false);
    setError(null);
    setLinkNote(null);
    try {
      setJob(await gatherLiterature(300));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gathering failed.");
    }
  }

  /* Pick up a gather that is already running (page reload) once. */
  useEffect(() => {
    getGatherStatus()
      .then((status) => {
        if (status.state === "running") setJob(status);
      })
      .catch(() => undefined);
  }, []);

  /* Poll while a gather runs; refresh the eligible count when done. */
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = window.setInterval(() => {
      getGatherStatus()
        .then((status) => {
          setJob(status);
          if (status.state !== "running") setPoolTick((tick) => tick + 1);
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job?.state]);

  async function load(id: number) {
    setError(null);
    try {
      setResult(await getTournament(id));
      setTab("verdict");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run.");
    }
  }

  /* High scores: tournaments won per pipeline, from the full log. */
  const board = useMemo(() => {
    const wins = new Map<string, number>();
    for (const run of history) {
      if (run.outcome === "winner" && run.winner_pipeline_id) {
        wins.set(
          run.winner_pipeline_id,
          (wins.get(run.winner_pipeline_id) ?? 0) + 1,
        );
      }
    }
    const decisive = [...wins.values()].reduce((sum, n) => sum + n, 0);
    const finished = history.filter(
      (run) => !run.status || run.status === "done",
    ).length;
    const rows = pipelineConfigs
      .map((c) => ({ id: c.id, wins: wins.get(c.id) ?? 0 }))
      .sort((a, b) => b.wins - a.wins);
    return { rows, decisive, undecided: finished - decisive };
  }, [history]);

  const status = running
    ? "Scoring"
    : run
      ? run.status === "error"
        ? "Stopped"
        : "Paused"
      : gathering
        ? "Gathering"
        : result
          ? "Tournament complete"
          : "Insert coin";

  return (
    <div className="space-y-3">
      {/* ======================================================
          THE CABINET
          ====================================================== */}
      <section
        aria-label="Tournament cabinet"
        className="overflow-hidden rounded-lg border-[3px] border-gray-900 bg-gray-900 text-onInk shadow-[6px_6px_0_rgba(0,0,0,0.25)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-accent px-3 py-1.5 text-onAccent">
          <p className="flex items-center gap-2 font-pixelify text-lg font-bold uppercase leading-none tracking-[0.2em]">
            <Star className="h-4 w-4" aria-hidden="true" />
            Tournament
            <Star className="h-4 w-4" aria-hidden="true" />
          </p>
          <p
            aria-live="polite"
            className={`font-mono text-xs font-bold uppercase tracking-[0.25em] ${
              busy || !result ? "animate-blink" : ""
            }`}
          >
            {status}
          </p>
        </div>

        <div className="grid gap-2 p-2.5 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* THE SCREEN */}
          <div className="rounded border-[3px] border-black/60 bg-gray-950 p-3 shadow-[inset_0_0_0_2px_rgba(255,255,255,0.08),inset_0_0_36px_rgba(0,0,0,0.55)]">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-onInk">
              Player one · set the rules
            </p>

            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 border-b-[3px] border-accent pb-3 sm:grid-cols-3 xl:grid-cols-6">
              <IntInput
                label="Queries"
                hint="Papers to use as queries"
                field={queriesField}
                min={2}
                max={MAX_QUERIES}
                disabled={busy}
                warning={queriesWarning}
              />
              <IntInput
                label="Top-k"
                hint="List length the metrics score"
                field={topKField}
                min={1}
                max={MAX_TOP_K}
                disabled={busy}
                fixedNote={profile.topKFixed ? "fixed at 20" : undefined}
              />
              <IntInput
                label="Min refs"
                hint="A paper needs this many resolved references to be a query"
                field={minRefsField}
                min={1}
                max={MAX_MIN_REFS}
                disabled={busy}
                warning={minRefsWarning}
              />
              <ScreenField
                label="Metric"
                hint="Chosen before the run; it decides the verdict"
                note="sets the minimums below"
              >
                <select
                  className={SCREEN_INPUT}
                  value={metric}
                  disabled={busy}
                  onChange={(e) =>
                    chooseMetric(e.target.value as TournamentMetric)
                  }
                >
                  {(Object.keys(METRIC_LABELS) as TournamentMetric[]).map(
                    (key) => (
                      <option key={key} value={key}>
                        {METRIC_LABELS[key]}
                      </option>
                    ),
                  )}
                </select>
              </ScreenField>
              <IntInput
                label="Seed"
                hint="Fixes sampling and resampling (0 or higher)"
                field={seedField}
                min={0}
                max={MAX_SEED}
                disabled={busy}
              />
              <ScreenField
                label="Label"
                hint="An optional name saved with the run"
                note={`optional \u00b7 ${label.length}/${MAX_LABEL}`}
              >
                <input
                  className={SCREEN_INPUT}
                  type="text"
                  maxLength={MAX_LABEL}
                  value={label}
                  placeholder="optional"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </ScreenField>
            </div>

            {/* WHO COMPETES */}
            <div className="mt-2 border-b-2 border-dashed border-onInk/25 pb-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80">
                  Pipelines
                </span>
                {pipelineConfigs.map((config) => {
                  const on = selected.includes(config.id);
                  return (
                    <button
                      key={config.id}
                      type="button"
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => togglePipeline(config.id)}
                      className={`rounded border-[2px] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease disabled:cursor-not-allowed disabled:opacity-50 ${
                        on
                          ? "border-accent bg-accent text-onAccent"
                          : "border-onInk/40 text-onInk/70 hover:border-accent hover:text-accent"
                      }`}
                    >
                      {pipelineName(config)}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[10px] text-onInk/60">Presets</span>
                <button
                  type="button"
                  disabled={busy}
                  className={SCREEN_BTN}
                  onClick={() => setSelected(pipelineConfigs.map((c) => c.id))}
                >
                  All six
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={SCREEN_BTN}
                  title="Head-to-head: does adding metadata to S-BERT help?"
                  onClick={() => setSelected(["sbert", "sbert_metadata"])}
                >
                  S-BERT vs +metadata
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={SCREEN_BTN}
                  title="Head-to-head: S-BERT against TF-IDF"
                  onClick={() => setSelected(["tfidf", "sbert"])}
                >
                  TF-IDF vs S-BERT
                </button>
                <span
                  role={pipelinesValid ? undefined : "alert"}
                  className={`ml-auto text-[11px] ${
                    pipelinesValid ? "text-onInk/60" : "font-bold text-red-300"
                  }`}
                >
                  {pipelinesValid
                    ? `${selected.length} pipelines · ${estimateRuntime(
                        Math.min(nQueries, pool?.available ?? nQueries),
                        selected.length,
                      )}`
                    : "Pick at least two pipelines."}
                </span>
              </div>
              {selected.length === 2 && (
                <p className="mt-1 text-[11px] leading-4 text-onInk/60">
                  A head-to-head: close pairs need many queries, and nDCG needs
                  the fewest of the four metrics to separate them.
                </p>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1 basis-72 text-[11px] leading-4 text-onInk/70">
                <span className="font-bold text-onInk/90">Recommended · </span>
                {describeRecommendation(metric as MetricId, recommendation)}{" "}
                {profile.why}
              </p>
              <button
                type="button"
                className={SCREEN_BTN}
                onClick={() =>
                  applyRecommended(metric as MetricId, pool?.available ?? null)
                }
                disabled={busy}
                title="Fill Queries, Top-k and Min refs with the recommended numbers"
              >
                Use recommended
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={SCREEN_BTN}
                onClick={() => void link()}
                disabled={busy}
                title="Match each paper's cached references to papers in your library (OpenAlex lookup)"
              >
                {linking ? "Linking…" : "Link references"}
              </button>
              <button
                type="button"
                className={SCREEN_BTN}
                onClick={() => setGatherOpen(true)}
                disabled={busy}
                title="Import the works your papers cite (from OpenAlex) so there are references to score against"
              >
                {gathering ? "Gathering…" : "Gather literature"}
              </button>

              <button
                type="button"
                onClick={() => void start()}
                disabled={
                  busy ||
                  !inputsValid ||
                  (pool != null && pool.available < 2)
                }
                title={
                  inputsValid ? undefined : "Fix the highlighted settings first"
                }
                className={`ml-auto rounded border-[3px] border-black/60 bg-accent px-5 py-1.5 font-pixelify text-base font-bold uppercase tracking-[0.2em] text-onAccent shadow-[0_4px_0_rgba(0,0,0,0.45)] transition-all pixel-ease hover:brightness-110 active:translate-y-[3px] active:shadow-[0_1px_0_rgba(0,0,0,0.45)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  !busy &&
                  inputsValid &&
                  (pool == null || pool.available >= 2)
                    ? "animate-blink"
                    : ""
                }`}
              >
                {running ? "Running…" : runBusy ? "Starting…" : "Press start"}
              </button>
            </div>

            {/* what the screen says: the live job, or the attract text */}
            <div className="mt-2 border-t-2 border-dashed border-onInk/25 pt-2">
              {run ? (
                <TournamentProgress
                  run={run}
                  disconnected={pollFailed}
                  busy={runBusy}
                  onStop={() => void stopRun()}
                  onResume={() => void resumeRun()}
                  onDiscard={() => void discardRun()}
                />
              ) : job && job.state !== "idle" ? (
                <GatherProgress job={job} />
              ) : (
                <>
                  <p className="font-mono text-xs leading-5 text-onInk/90">
                    {pool
                      ? `${pool.available} eligible ${
                          pool.available === 1 ? "query" : "queries"
                        }${
                          pool.available < nQueries
                            ? ` (fewer than the ${nQueries} requested)`
                            : ""
                        } · detecting a 0.05 nDCG gap at SD 0.2 needs about ${pool.required}.`
                      : "Checking eligible queries…"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-onInk/80">
                    Each query is a paper&apos;s own title, abstract and
                    keywords; the relevant set is its resolved references
                    (grade 2) and citers (grade 1). The paper and its
                    duplicates are hidden from every pipeline, and the winner
                    must beat every rival in paired tests, not just lead on
                    average.
                  </p>
                </>
              )}

              {pool != null && pool.available < 2 && !run && (
                <p className="mt-2 text-xs leading-5 text-onInk/80">
                  No paper has {minRefs}+ references that resolve to other
                  papers in your library, so there is nothing to score
                  against. Press <strong>Link references</strong>, or{" "}
                  <strong>Gather literature</strong> to import the works they
                  cite.
                </p>
              )}
              {linkNote && (
                <p className="mt-2 font-mono text-xs text-onInk/80">
                  {linkNote}
                </p>
              )}
            </div>
          </div>

          {/* HIGH SCORES */}
          <aside
            aria-label="High scores"
            className="flex flex-col rounded border-[3px] border-black/60 bg-gray-950 p-3 shadow-[inset_0_0_0_2px_rgba(255,255,255,0.08)]"
          >
            <p className="flex items-center gap-1.5 font-pixelify text-sm font-bold uppercase tracking-[0.2em] text-onInk">
              <Trophy className="h-4 w-4" aria-hidden="true" />
              High scores
            </p>
            <ol className="mt-2 space-y-1.5">
              {board.rows.map((entry, index) => {
                const share =
                  board.decisive > 0 ? entry.wins / board.decisive : 0;
                return (
                  <li key={entry.id} className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-4 text-right text-onInk/85">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-bold tracking-[0.1em] text-onInk">
                        {name(entry.id)}
                      </span>
                      {index === 0 && entry.wins > 0 && (
                        <Star
                          className="animate-blink h-3 w-3 text-accent"
                          aria-label="Champion"
                        />
                      )}
                      <span className="w-8 text-right font-bold text-onInk">
                        {entry.wins}
                      </span>
                    </div>
                    <div
                      className="ml-6 mt-0.5 h-1 overflow-hidden bg-onInk/15"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.round(share * 100)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="mt-auto border-t border-onInk/20 pt-2 font-mono text-[10px] font-bold uppercase leading-4 tracking-[0.15em] text-onInk/75">
              {historyTotal} {historyTotal === 1 ? "tournament" : "tournaments"}{" "}
              run
              {board.undecided > 0
                ? ` · ${board.undecided} without a winner`
                : ""}
            </p>
          </aside>
        </div>
      </section>

      {error && <div className="status-error">{error}</div>}

      {/* ======================================================
          RESULTS
          ====================================================== */}
      {result && !running && (
        <TournamentResults
          result={result}
          tab={tab}
          onTab={setTab}
          onError={setError}
          onResult={setResult}
        />
      )}

      {/* ======================================================
          LOG
          ====================================================== */}
      <section
        aria-label="Tournament log"
        className="rounded border-[3px] border-gray-900 bg-surface"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-canvas px-3 py-2">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
            Tournament log · {historyTotal}{" "}
            {historyTotal === 1 ? "run" : "runs"}
          </p>
        </div>
        {history.length === 0 ? (
          <div className="px-3 py-4">
            <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-ink">
              No tournaments yet
            </p>
            <p className="mt-1 text-xs text-ink/70">
              Press start above. Every tournament is logged here with its
              verdict and every per-query score.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-900/20 text-xs">
            {history.slice(0, 10).map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span className="min-w-0 font-mono">
                  #{run.id} · {new Date(run.created_at).toLocaleString()} ·{" "}
                  {run.status && run.status !== "done"
                    ? `${run.status} · `
                    : `${run.n_queries} queries · `}
                  {run.label ? `${run.label} · ` : ""}
                  <strong>
                    {run.status && run.status !== "done"
                      ? "unfinished"
                      : run.outcome === "winner" && run.winner_pipeline_id
                        ? `winner ${name(run.winner_pipeline_id)}`
                        : run.outcome}
                  </strong>
                </span>
                <button
                  type="button"
                  className={BTN}
                  onClick={() =>
                    run.status && run.status !== "done"
                      ? void getTournamentStatus(run.id)
                          .then(setRun)
                          .catch(() => undefined)
                      : void load(run.id)
                  }
                >
                  {run.status && run.status !== "done" ? "Open" : "View"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RetroDialog
        open={gatherOpen}
        title="Gather literature"
        confirmLabel="Gather up to 300"
        cancelLabel="Not now"
        onCancel={() => setGatherOpen(false)}
        onConfirm={() => void gather()}
      >
        <div className="flex flex-col gap-2.5">
          <p className="text-ink">
            Look up reference lists and fetch the works your papers cite from OpenAlex, adding up to{" "}
            <span className="font-bold">300</span> of them to your library,
            so the tournament has references to score against.
          </p>

          <ul className="list-disc space-y-1 pl-5 text-ink">
            <li>
              Papers with no cached reference list get theirs first, so they
              can act as queries; then references are linked to your library.
            </li>
            <li>
              Most-cited references still missing come next; works without an
              abstract are skipped.
            </li>
            <li>Papers you already have are linked, not duplicated.</li>
            <li>
              The recommendation index is rebuilt afterwards, which can take
              a few minutes.
            </li>
          </ul>

          <p className="select-all rounded border-[2px] border-gray-900 bg-canvas px-2 py-1 font-mono text-[11px] text-ink">
            extraction_method = &quot;openalex-gather&quot;
          </p>

          <p className="text-muted">
            Added papers carry the tag above, so you can find them again.
          </p>
        </div>
      </RetroDialog>
    </div>
  );
}

/* ------------------------------------------------------------
   RESULTS: the cartridge rail and one panel per result type
   ------------------------------------------------------------ */

function TournamentResults({
  result,
  tab,
  onTab,
  onError,
  onResult,
}: {
  result: TournamentResult;
  tab: ResultTab;
  onTab: (tab: ResultTab) => void;
  onError: (message: string | null) => void;
  /** A re-analysis replaced the shown result. */
  onResult: (result: TournamentResult) => void;
}) {
  const { on: nerdOn } = useNerdButtons();
  const { verdict } = result;
  const copy = OUTCOME_COPY[verdict.outcome];
  const metricName =
    METRIC_LABELS[result.primary_metric]?.replace("k", String(result.top_k)) ??
    result.primary_metric;

  const groupOf = useMemo(() => {
    const map = new Map<string, number>();
    verdict.tie_groups.forEach((group, index) =>
      group.forEach((id) => map.set(id, index)),
    );
    return map;
  }, [verdict.tie_groups]);

  const maxHi = Math.max(0.0001, ...verdict.ranking.map((row) => row.hi));
  const pct = (value: number) => `${Math.min(100, (value / maxHi) * 100)}%`;

  const pairs = useMemo(() => {
    const map = new Map<string, TournamentPair>();
    verdict.pairwise.forEach((p) => map.set(`${p.a}|${p.b}`, p));
    return map;
  }, [verdict.pairwise]);

  const order = verdict.ranking.map((row) => row.pipeline);

  return (
    <div className="space-y-3">
      {/* RAIL */}
      <div className="overflow-x-auto rounded border-[3px] border-gray-900 bg-gray-900 p-1.5">
        <div
          role="tablist"
          aria-label="Tournament results"
          className="flex min-w-max gap-1.5"
        >
          {RESULT_TABS.map(({ id, label, icon: Icon }, index) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={label}
                onClick={() => onTab(id)}
                className={`relative flex items-center gap-1.5 rounded border-[2px] px-2.5 py-1.5 font-pixelify text-[11px] font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
                  active
                    ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-3px_0_rgba(0,0,0,0.3)]"
                    : "border-gray-700 bg-gray-800 text-onInk/75 hover:border-accent hover:text-accent"
                }`}
              >
                <span
                  className={`text-[9px] leading-none ${
                    active ? "text-onAccent/70" : "text-onInk/40"
                  }`}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div key={tab} className="animate-step-in space-y-3">
        {/* ---------------- VERDICT ---------------- */}
        {tab === "verdict" && (
          <section className="rounded border-[3px] border-gray-900 bg-gray-900 p-3 text-onInk">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1 basis-80">
                <p
                  className={`flex items-center gap-2 font-mono text-xs font-bold tracking-[0.3em] text-accent ${
                    copy.blink ? "animate-blink" : ""
                  }`}
                >
                  <Star className="h-3.5 w-3.5" />
                  {copy.title}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {verdict.winner ? (
                    <>
                      <span className="rounded border-[2px] border-gray-900 bg-surface px-2 py-1 font-mono text-sm font-bold tracking-[0.12em] text-ink">
                        {name(verdict.winner)}
                      </span>
                      <span className="font-mono text-xs text-onInk/70">
                        {verdict.winner}
                      </span>
                    </>
                  ) : (
                    verdict.top_group?.map((id) => (
                      <span
                        key={id}
                        className="rounded border-[2px] border-gray-900 bg-surface px-2 py-1 font-mono text-sm font-bold tracking-[0.12em] text-ink"
                      >
                        {name(id)}
                      </span>
                    ))
                  )}
                </div>

                <p className="mt-2 text-xs leading-5 text-onInk/70">
                  {verdict.reason} {result.n_queries} queries scored
                  {result.dropped.length > 0
                    ? `, ${result.dropped.length} dropped`
                    : ""}
                  ; {metricName} was fixed before the run.{" "}
                  {verdict.omnibus
                    ? `Omnibus Friedman χ²(${verdict.omnibus.df}) = ${fmt(
                        verdict.omnibus.statistic,
                        2,
                      )}, ${fmtP(verdict.omnibus.p_value)}.`
                    : ""}{" "}
                  Seed {result.seed}.
                </p>
              </div>

              {verdict.ranking[0] && (
                <div className="ml-auto shrink-0 text-right">
                  <p className="font-mono text-3xl font-bold leading-none text-accent">
                    {fmt(verdict.ranking[0].mean, 2)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-onInk/70">
                    top mean {metricName}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---------------- LEADERBOARD ---------------- */}
        {tab === "board" && (
          <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
            <p className="font-mono text-xs font-bold tracking-[0.2em] text-ink">
              LEADERBOARD · MEAN {metricName.toUpperCase()} WITH 95% CI
            </p>
            <ol className="mt-2 space-y-2">
              {verdict.ranking.map((row, index) => {
                const group = groupOf.get(row.pipeline) ?? 0;
                const tied = verdict.tie_groups[group]?.length > 1;
                return (
                  <li
                    key={row.pipeline}
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)_2rem] items-center gap-x-2 gap-y-1 sm:grid-cols-[1.5rem_9rem_minmax(0,1fr)_11rem_2rem]"
                  >
                    <span className="font-mono text-xs text-ink/70">
                      {index + 1}
                    </span>
                    <span className="truncate font-mono text-xs font-bold">
                      {name(row.pipeline)}
                    </span>
                    <div className="relative order-last col-span-3 h-4 rounded bg-gray-900/10 sm:order-none sm:col-span-1">
                      <div
                        className="absolute inset-y-0 left-0 rounded bg-accent/70"
                        style={{ width: pct(row.mean) }}
                      />
                      <div
                        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-gray-900"
                        style={{
                          left: pct(row.lo),
                          width: `calc(${pct(row.hi)} - ${pct(row.lo)})`,
                        }}
                        title={`${fmt(row.lo)} – ${fmt(row.hi)}`}
                      />
                    </div>
                    <span className="hidden text-right font-mono text-xs tabular-nums sm:block">
                      {fmt(row.mean)} [{fmt(row.lo)}, {fmt(row.hi)}]
                    </span>
                    <span
                      className="text-right font-mono text-xs font-bold"
                      title={tied ? "Not separable from its group" : "Alone"}
                    >
                      {tied ? `G${group + 1}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-xs text-ink/70">
              Pipelines sharing a G-label are not statistically separable
              after Holm correction. Overlapping intervals alone are not the
              test; the Pairwise tab is.
            </p>
          </section>
        )}

        {/* ---------------- PAIRWISE ---------------- */}
        {tab === "pairwise" && (
          <section className="overflow-x-auto rounded border-[3px] border-gray-900 bg-surface p-3">
            <p className="font-mono text-xs font-bold tracking-[0.2em] text-ink">
              PAIRWISE SIGNIFICANCE · ROW MINUS COLUMN
            </p>
            <table className="mt-2 w-full min-w-[640px] table-fixed border-collapse text-xs">
              <colgroup>
                <col className="w-36" />
                {order.map((id) => (
                  <col key={id} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {order.map((id) => (
                    <th
                      key={id}
                      className="truncate px-1 pb-1 text-center font-mono"
                      title={name(id)}
                    >
                      {name(id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.map((rowId, i) => (
                  <tr key={rowId}>
                    <th
                      className="truncate pr-2 text-left font-mono"
                      title={name(rowId)}
                    >
                      {name(rowId)}
                    </th>
                    {order.map((colId, j) => {
                      if (i === j)
                        return (
                          <td
                            key={colId}
                            className="bg-gray-900/10 text-center"
                          >
                            —
                          </td>
                        );
                      const forward = pairs.get(`${rowId}|${colId}`);
                      const backward = pairs.get(`${colId}|${rowId}`);
                      const pair = forward ?? backward;
                      if (!pair) return <td key={colId} />;
                      const sign = forward ? 1 : -1;
                      const diff = pair.mean_diff * sign;
                      return (
                        <td
                          key={colId}
                          className={`border border-gray-900/20 p-1 text-center font-mono ${
                            pair.significant
                              ? diff > 0
                                ? "bg-accent/30 font-bold"
                                : "bg-red-500/25 font-bold"
                              : ""
                          }`}
                          title={`Δ ${fmt(diff)} (95% CI ${fmt(
                            forward ? pair.lo : -pair.hi,
                          )} to ${fmt(
                            forward ? pair.hi : -pair.lo,
                          )}), ${
                            pair.effect_kind === "h"
                              ? `Cohen's h ${fmt((pair.effect_size ?? 0) * sign, 2)}`
                              : `${pair.paired_delta !== undefined ? "Paired δ" : "Cliff's δ"} ${fmt((pair.effect_size ?? pair.paired_delta ?? pair.cliffs_delta) * sign, 2)}`
                          }${pair.effect_label ? ` (${pair.effect_label})` : ""}, Holm ${fmtP(pair.p_adjusted)}`}
                        >
                          {diff >= 0 ? "+" : ""}
                          {fmt(diff)}
                          <br />
                          <span className="text-[10px] font-normal text-ink/70">
                            {fmtP(pair.p_adjusted)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink/70">
              Shaded cells are significant after Holm correction. Hover a cell
              for the CI on the difference and Cliff&apos;s δ. A significant
              but tiny difference is not a meaningful win.
            </p>
          </section>
        )}

        {/* ---------------- METRICS ---------------- */}
        {tab === "metrics" && (
          <section className="overflow-x-auto rounded border-[3px] border-gray-900 bg-surface p-3">
            <p className="font-mono text-xs font-bold tracking-[0.2em] text-ink">
              SECONDARY METRICS · NOT USED FOR THE VERDICT
            </p>
            <table className="mt-2 w-full min-w-[480px] text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted">
                  <th className="pb-1">Pipeline</th>
                  {Object.keys(result.secondary).map((key) => (
                    <th key={key} className="pb-1">
                      {METRIC_LABELS[key as TournamentMetric]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.map((id) => (
                  <tr key={id} className="font-mono">
                    <td className="py-0.5 font-bold">{name(id)}</td>
                    {Object.entries(result.secondary).map(
                      ([key, byPipeline]) => {
                        const cell = byPipeline[id];
                        return (
                          <td key={key}>
                            {cell
                              ? `${fmt(cell.mean)} [${fmt(cell.lo)}, ${fmt(cell.hi)}]`
                              : "—"}
                          </td>
                        );
                      },
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* ---------------- INTERPRETATION ---------------- */}
        {tab === "interpret" && (
          <TournamentInterpretation result={result} nameOf={name} />
        )}

        {/* ---------------- DATA ---------------- */}
        {tab === "data" && (
          <>
            <DataPanel result={result} onError={onError} onResult={onResult} />
            {/* The full inferential output, for the Stats-for-Nerds switch. */}
            {nerdOn && (
              <ErrorBoundary label="The tournament statistics" resetKey={result.run_id}>
                <TournamentNerdStats />
              </ErrorBoundary>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Run facts and the export picker, laid out like the battle log's. */
function DataPanel({
  result,
  onError,
  onResult,
}: {
  result: TournamentResult;
  onError: (message: string | null) => void;
  onResult: (result: TournamentResult) => void;
}) {
  const [format, setFormat] = useState<TournamentExportFormat>("csv");
  const [downloading, setDownloading] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);

  /* The scores never change; the tests that read them can improve. This
     recomputes the verdict from the stored scores with the current code. */
  async function reanalyze() {
    if (result.run_id == null) return;
    setReanalyzing(true);
    onError(null);
    try {
      onResult(await reanalyzeTournament(result.run_id));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Re-analysis failed.");
    } finally {
      setReanalyzing(false);
    }
  }
  const runId = result.run_id;

  async function download() {
    if (runId == null) return;
    setDownloading(true);
    onError(null);
    try {
      const payload = await exportTournament(runId, format);
      saveText(payload.filename, payload.text, EXPORT_MIME[format]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setDownloading(false);
    }
  }

  const facts: [string, string][] = [
    ["Run", runId != null ? `#${runId}` : "unsaved"],
    ["Queries", `${result.n_queries} (${result.dropped.length} dropped)`],
    ["Pipelines", String(result.pipelines.length)],
    ["Metric", `${result.primary_metric}@${result.top_k}`],
    ["Min refs", String(result.min_refs)],
    ["Seed", String(result.seed)],
  ];

  return (
    <section className="rounded border-[3px] border-gray-900 bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b-[3px] border-gray-900 bg-canvas px-3 py-2">
        <label className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Export
          <select
            value={format}
            onChange={(e) =>
              setFormat(e.target.value as TournamentExportFormat)
            }
            disabled={downloading || runId == null}
            aria-label="Export format"
            className="h-9 rounded border-[3px] border-gray-900 bg-surface px-2 font-mono text-[11px] normal-case tracking-normal text-ink"
          >
            {(Object.keys(EXPORT_LABELS) as TournamentExportFormat[]).map(
              (key) => (
                <option key={key} value={key}>
                  {EXPORT_LABELS[key]}
                </option>
              ),
            )}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading || runId == null}
          title={runId == null ? "Unsaved runs can't be exported" : undefined}
          className={BTN}
        >
          {downloading ? "Exporting…" : "Download"}
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-3 font-mono text-xs sm:grid-cols-3">
        {facts.map(([key, value]) => (
          <div key={key}>
            <dt className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
              {key}
            </dt>
            <dd className="font-bold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="border-t border-gray-900/20 px-3 py-2 text-xs text-ink/70">
        The per-query CSV has one row per pipeline per query, enough to
        re-run any test elsewhere. The JSON holds the whole verdict, the
        secondary metrics and the dropped queries.
      </p>

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-900/20 px-3 py-2">
        <button
          type="button"
          onClick={() => void reanalyze()}
          disabled={reanalyzing || result.run_id == null}
          className={BTN}
          title="Recompute the verdict from the stored scores with the current tests (the scores are not touched)"
        >
          {reanalyzing ? "Working…" : "Re-run statistics"}
        </button>
        <span className="text-xs text-ink/70">
          Uses the stored scores with the current tests, e.g. after a better
          test replaces an older one. The scores are never changed.
        </span>
      </div>
    </section>
  );
}

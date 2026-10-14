import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  BarChart3,
  Download,
  History,
  Layers,
  Quote,
  Scale,
  Split,
  Table,
  Trophy,
} from "lucide-react";

import {
  archiveBattleHistory,
  comparePipelines,
  comparePipelinesStream,
  deleteBattleHistory,
  exportBattleHistory,
  getBattleHistory,
  webComparePipelines,
  BattleExportFormat,
  BattleRun,
  BattleVerdictCounts,
  CompareResponse,
  Paper,
} from "../../api";
import RepositoryPickerDialog from "../../components/RepositoryPickerDialog";
import BattleJudge from "../../components/BattleJudge";
import BattleDifferencesPanel from "../../components/BattleDifferences";
import BattleSeries from "../../components/BattleSeries";

import { pipelineConfigs, pipelineName } from "../../data/pipelineConfigs";
import { isPresentationStored } from "../../utils/presentation";
import { triggerSlimeAnimation } from "../../utils/slimeEvents";
import PixelProgress from "../../components/retro/PixelProgress";
import { useSun } from "../../state/sun";
import StaggerIn from "../../components/retro/StaggerIn";
import RetroDialog from "../../components/retro/RetroDialog";
import PageTabs from "../../components/PageTabs";
import ErrorBoundary from "../../components/ErrorBoundary";
import TournamentPanel from "../../components/TournamentPanel";
import FreqBars from "../../components/retro/FreqBars";
import Pagination from "../../components/retro/Pagination";
import { ArrowRight, Star } from "../../components/retro/PixelIcons";
import { Button, PageHeader, PageShell } from "../../components/ui";
import HuntItem from "../../components/retro/HuntItem";
import { HUNT_ITEMS } from "../../data/hunt";
import { useStatsDrawer } from "../../state/statsDrawer";

// ============================================================
// PIPELINE BATTLE — EVALUATION PAGE
// ============================================================
//
// Runs all six recommendation pipelines against the same query
// and shows them side by side: consensus ranking, the battle
// grid (which pipeline ranked which paper where), score bars,
// and pairwise agreement statistics.

const configById = new Map(
  pipelineConfigs.map((config) => [config.id, config])
);

const BATTLE_IDS = [
  "tfidf",
  "sbert",
  "tfidf_sbert",
  "tfidf_metadata",
  "sbert_metadata",
  "tfidf_sbert_metadata",
];

function displayName(id: string): string {
  const config = configById.get(id);

  return config ? pipelineName(config) : id;
}

/* Battle round names: the six pipelines in execution order. */
const BATTLE_STAGES = BATTLE_IDS.map((id) => displayName(id));


function formatScore(value: number | null): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toFixed(4);
}

/* ----
   RESEARCH CONTROLS

   The Arena is also the study's instrument, so the run log needs the
   three things a collection protocol requires and a game screen does
   not: naming a run, getting the history out as a file, and starting
   the tally from empty. Each of those lives beside the thing it acts
   on -- the tag next to Press start, the export and reset next to the
   battle log -- so nobody can archive the wrong table by accident.
   ---- */

/* The six classes the campaign queries are drawn from. Offered as
   suggestions rather than enforced: a walkthrough run on something
   else is still a legitimate run to record, and rejecting it would
   push people into leaving the field blank, which tells an analyst
   strictly less than an unfamiliar value does. */
const SUBJECT_CLASSES = [
  "Machine Learning",
  "Natural Language Processing",
  "Information Retrieval",
  "Data Mining",
  "Computer Vision",
  "Software Engineering",
];

/* Namespace prefix for a formal campaign run. Free text on purpose --
   the campaign names runs after the query they hold, and a dropdown
   of legal labels would only get in the way of that. */
const CAMPAIGN_LABEL_PREFIX = "campaign-";

/* Hand a downloaded export to the browser under the name the server
   gave it. A blob URL rather than a data: URI because a JSONL export
   of a full campaign runs to megabytes, and revoking the object URL
   straight after the click is what keeps the tab from holding it. */
function downloadText(filename: string, text: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function PipelineChip({
  pipelineId,
  grow = false,
}: {
  pipelineId: string;
  /** Grow to fill its flex column and truncate long names. */
  grow?: boolean;
}) {
  const config = configById.get(pipelineId);

  return (
    <span
      className={
        grow
          ? "flex w-full max-w-full flex-col items-stretch gap-1"
          : "inline-flex flex-col items-start gap-1"
      }
    >
      <span
        className={`rounded border-[2px] border-gray-900 bg-surface px-1.5 py-0.5 font-mono text-xs font-bold tracking-[0.12em] text-ink ${
          grow ? "max-w-full truncate" : "max-w-[150px] truncate"
        }`}
      >
        {displayName(pipelineId)}
      </span>
      {!isPresentationStored() && (
        <span
          className={`font-mono text-xs text-muted ${
            grow ? "w-full truncate" : "max-w-[150px] truncate"
          }`}
        >
          {pipelineId}
        </span>
      )}
    </span>
  );
}

export default function Evaluation() {
  const { grantTokens } = useSun();
  const { publish: publishStats } = useStatsDrawer();

  const [queryText, setQueryText] = useState("");
  /* A seed paper replaces the text query: the battle is then scored
     automatically against the paper's own references (Judge tab). */
  const [seedPaper, setSeedPaper] = useState<Paper | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [topK, setTopK] = useState(10);
  const [battle, setBattle] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // A newer battle cancels the web fetch still in flight.
  const battleAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BattleRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPages, setHistoryPages] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [serverTally, setServerTally] = useState<
    { pipeline_id: string; wins: number }[]
  >([]);
  const [verdicts, setVerdicts] = useState<BattleVerdictCounts | null>(null);
  const [copiedCitation, setCopiedCitation] = useState<string | null>(null);

  /* Research tag applied to the NEXT recorded battle. Held here rather
     than sent per keystroke so an untagged walkthrough is the default
     state, not something that has to be undone. */
  const [runLabel, setRunLabel] = useState("");
  const [subjectClass, setSubjectClass] = useState("");

  /* Export / archive / reset, all of which act on the whole table. */
  const [exportFormat, setExportFormat] = useState<BattleExportFormat>("csv");
  const [exporting, setExporting] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  /* A delete is not offered as a button. Archiving already covers the
     campaign workflow -- it empties the log AND keeps the runs -- so a
     permanent-delete control would only ever be reached by someone who
     wants to lose data. It lives in the archive dialog instead, behind
     its own second confirmation. */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [logNotice, setLogNotice] = useState<string | null>(null);

  /* Page-level view: the battle, or the ranking math. */
  const [pageTab, setPageTab] = useState<"battle" | "tournament">("battle");

  /* Arena results are tab-separated instead of one long stack. */
  const [resultsTab, setResultsTab] = useState<
    "overview" | "consensus" | "pairwise" | "grid" | "scores" | "differences" | "judge" | "cite"
  >("overview");

  /* Web mode: battle the pipelines over live OpenAlex/Crossref/arXiv
     hits instead of the repository. */
  const [webMode, setWebMode] = useState(false);
  const hasInput = Boolean(seedPaper && !webMode) || Boolean(queryText.trim());
  const [webSources, setWebSources] = useState(
    "openalex,crossref,arxiv",
  );
  const [webSort, setWebSort] = useState("relevance");
  const [openAccess, setOpenAccess] = useState(false);

  const HISTORY_PAGE_SIZE = 5;

  async function loadHistory(page: number = historyPage) {
    try {
      const response = await getBattleHistory(page, HISTORY_PAGE_SIZE);
      setHistory(response.runs);
      setHistoryTotal(response.total);
      setHistoryPages(response.pages);
      setHistoryPage(response.page);
      setServerTally(response.tally);
      setVerdicts(response.verdicts ?? null);
    } catch {
      // History is best-effort; the battle itself still works.
    }
  }

  useEffect(() => {
    void loadHistory(1);
  }, []);

  /* Battle-round ticker: walks the six codenames while loading. */
  /* Real progress: the pipelines the server has finished so far. A web
     battle is not streamed, so its meter stays indeterminate. */
  const [progress, setProgress] = useState<{
    order: string[];
    finished: { id: string; seconds: number; top: string | null }[];
  }>({ order: [], finished: [] });

  const finishedCount = progress.finished.length;
  const totalCount = progress.order.length || BATTLE_STAGES.length;
  const nextUp = progress.order.find(
    (id) => !progress.finished.some((entry) => entry.id === id),
  );

  async function runBattle() {
    if (!hasInput) {
      setError("Enter a query or pick a seed paper to start the battle.");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress({ order: [], finished: [] });

    // The pet zaps when the battle starts.
    triggerSlimeAnimation("zap");

    battleAbortRef.current?.abort();
    const controller = new AbortController();
    battleAbortRef.current = controller;

    try {
      const data = webMode
        ? await webComparePipelines({
            q: queryText.trim(),
            topK,
            sources: webSources || "openalex,crossref,arxiv",
            sort: webSort,
            openAccess,
            signal: controller.signal,
          })
        : await comparePipelinesStream(
            {
              query: seedPaper ? undefined : queryText.trim(),
              seedPaperId: seedPaper?.id,
              topK,
              runLabel: runLabel.trim() || undefined,
              subjectClass: subjectClass || undefined,
            },
            (event) => {
              if (event.event === "start") {
                setProgress({ order: event.pipelines, finished: [] });
              } else if (event.event === "pipeline") {
                setProgress((current) => ({
                  ...current,
                  finished: [
                    ...current.finished,
                    {
                      id: event.id,
                      seconds: event.seconds,
                      top: event.results[0]?.title ?? null,
                    },
                  ],
                }));
              }
            },
            controller.signal,
          );

      if (controller.signal.aborted) return;

      setBattle(data);

      // Publish the battle to the universal statistics panel.
      if (!webMode) {
        publishStats({
          pipelineId: "compare",
          mode: "keyword",
          query: seedPaper ? seedPaper.title : queryText.trim(),
          topK,
        });
      }
      // Web battles never touch the tally/history.
      if (!webMode) {
        void loadHistory();
        // Every finished local battle pays a growth token (3/day).
        grantTokens(1, undefined, "battle");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;

      setBattle(null);
      setError(
        err instanceof Error
          ? err.message
          : "Pipeline comparison failed."
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  // ----------------------------------------------------------
  // RUN LOG — export, archive, reset
  // ----------------------------------------------------------

  /* One shared notice line for the three log actions. They all end in
     the same place -- "the log now holds N runs" -- and a dialog that
     closes itself leaves nothing behind, so the outcome is said once
     here and fades. */
  function sayLog(message: string) {
    setLogNotice(message);
    window.setTimeout(
      () => setLogNotice((current) => (current === message ? null : current)),
      6_000,
    );
  }

  async function downloadHistory(format: BattleExportFormat) {
    setExporting(true);

    try {
      const payload = await exportBattleHistory(format);

      downloadText(
        payload.filename,
        payload.text,
        format === "csv" ? "text/csv;charset=utf-8" : "application/x-ndjson",
      );

      sayLog(`Exported ${historyTotal} runs to ${payload.filename}.`);
    } catch (err) {
      sayLog(
        err instanceof Error ? err.message : "Export failed.",
      );
    } finally {
      setExporting(false);
    }
  }

  async function archiveHistory() {
    setArchiving(true);

    try {
      const result = await archiveBattleHistory();

      setArchiveOpen(false);
      sayLog(
        `Archived ${result.archived} runs to ${result.path}. The log is empty.`,
      );

      await loadHistory(1);
    } catch (err) {
      sayLog(
        err instanceof Error ? err.message : "Archive failed.",
      );
    } finally {
      setArchiving(false);
    }
  }

  /* ----------------------------------------------------------
     A delete is not offered as a button. Archiving already covers the
     campaign workflow -- it empties the log AND keeps the runs -- so a
     permanent-delete control would only ever be reached by someone
     who wants to lose data. It lives in the archive dialog instead,
     behind its own second confirmation, for the rare case where the
     runs really must not be kept anywhere.
     ---------------------------------------------------------- */

  async function destroyHistory() {
    setDeleting(true);

    try {
      const result = await deleteBattleHistory();

      setDeleteOpen(false);
      setArchiveOpen(false);
      sayLog(`Deleted ${result.deleted} runs. No copy was kept.`);

      await loadHistory(1);
    } catch (err) {
      sayLog(
        err instanceof Error ? err.message : "Delete failed.",
      );
    } finally {
      setDeleting(false);
    }
  }

  // ----------------------------------------------------------
  // WIN TALLY over time, derived from the recorded battle runs.
  // ----------------------------------------------------------

  const tally = BATTLE_IDS.map((id) => ({
    id,
    wins: serverTally.find((entry) => entry.pipeline_id === id)?.wins ?? 0,
  })).sort(
    (a, b) =>
      b.wins - a.wins ||
      BATTLE_IDS.indexOf(a.id) - BATTLE_IDS.indexOf(b.id),
  );

  const leader = tally[0];
  const totalRuns = historyTotal;

  /* Winner-score histogram over the loaded history page: buckets
     in 10-point steps from 50% up (battle winners below 50% are
     rare and pooled into the first bucket by the clamp). */
  const scoreBuckets = [0, 1, 2, 3, 4].map((bucket) => ({
    label: `${50 + bucket * 10}-${59 + bucket * 10}%`,
    value: history.filter((run) => {
      if (run.winner_value == null) return false;

      const pct =
        run.winner_metric === "independence_weighted_consensus"
          ? run.winner_value * 100
          : null;

      if (pct === null) return false;

      return (
        Math.min(4, Math.max(0, Math.floor((pct - 50) / 10))) ===
        bucket
      );
    }).length,
  }));
  const currentStreak =
    leader && leader.wins > 0
      ? (() => {
          let count = 0;
          for (const run of history) {
            // Only decisive wins extend a streak; a too-close battle breaks it.
            if (run.decisive === true && run.winner_pipeline_id === leader.id) {
              count++;
            } else {
              break;
            }
          }
          return count;
        })()
      : 0;

  function formatRunTime(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const rankById = (pipelineId: string, paperId: number): number | null => {
    const pipeline = battle?.pipelines.find(
      (entry) => entry.id === pipelineId
    );

    if (!pipeline) return null;

    const found = pipeline.results.find(
      (result) => result.paper_id === paperId
    );

    return found
      ? pipeline.results.indexOf(found) + 1
      : null;
  };

  const scoreById = (pipelineId: string, paperId: number): number | null => {
    const pipeline = battle?.pipelines.find(
      (entry) => entry.id === pipelineId
    );

    const found = pipeline?.results.find(
      (result) => result.paper_id === paperId
    );

    return found?.score ?? null;
  };

  // Papers shown in the battle grid: the consensus ranking,
  // trimmed to the requested depth (top_k), then paged.
  const gridPapers =
    battle?.consensus.slice(0, battle.top_k) ?? [];

  const GRID_PAGE_SIZE = 5;
  const gridPageCount = Math.max(
    1,
    Math.ceil(gridPapers.length / GRID_PAGE_SIZE),
  );
  const [gridPage, setGridPage] = useState(1);

  // Pairwise cards page at 6 per page (3 card rows x 2 columns) so
  // the section stays roughly the same height as the consensus
  // podium it sits next to.
  const PAIR_PAGE_SIZE = 6;
  const pairPageCount = Math.max(
    1,
    Math.ceil((battle?.pairwise.length ?? 0) / PAIR_PAGE_SIZE),
  );
  const [pairPage, setPairPage] = useState(1);

  useEffect(() => {
    setGridPage(1);
    setPairPage(1);
    setResultsTab("overview");
  }, [battle]);

  const gridPageStart = (gridPage - 1) * GRID_PAGE_SIZE;
  const pagedGridPapers = gridPapers.slice(
    gridPageStart,
    gridPageStart + GRID_PAGE_SIZE,
  );

  const pairPageStart = (pairPage - 1) * PAIR_PAGE_SIZE;
  const pagedPairs = (battle?.pairwise ?? []).slice(
    pairPageStart,
    pairPageStart + PAIR_PAGE_SIZE,
  );

  /* Citation-ready write-ups of the current battle, one per style,
     for copy-paste into a manuscript. Every figure comes straight
     from this run. */
  const citations = (() => {
    if (!battle) return null;

    const today = new Date();
    const monthLong = today.toLocaleString("en-US", { month: "long" });
    const monthShort = today.toLocaleString("en-US", { month: "short" });
    const day = today.getDate();
    const year = today.getFullYear();

    const mlaDate = `${day} ${monthShort}. ${year}`;
    const chicagoDate = `${monthLong} ${day}, ${year}`;
    const ieeeDate = `${monthShort}. ${day}, ${year}`;

    const subject = battle.query
      ? `"${battle.query}"`
      : `seed paper #${battle.seed_paper_id}`;

    const winnerId = battle.winner?.pipeline_id ?? "n/a";
    const winnerChip = displayName(winnerId);
    const winnerPct = battle.winner
      ? Math.round(battle.winner.value * 100)
      : 0;

    const leader = battle.consensus[0];
    const leaderText =
      leader?.title != null
        ? ` Top consensus paper: "${leader.title}"` +
          (leader.year ? ` (${leader.year})` : "") +
          "."
        : "";

    /* Pairwise extremes for the verbose APA interpretation. */
    const resultCount = (id: string) =>
      battle.pipelines.find((pipeline) => pipeline.id === id)?.results
        .length ?? 0;

    const normalizedOverlap = (pair: (typeof battle.pairwise)[number]) =>
      pair.overlap / Math.max(1, Math.min(resultCount(pair.a), resultCount(pair.b)));

    const rankedPairs = [...battle.pairwise].sort(
      (first, second) => normalizedOverlap(second) - normalizedOverlap(first),
    );
    const closest = rankedPairs[0];
    const farthest = rankedPairs[rankedPairs.length - 1];
    const nameOf = (id: string) => displayName(id);
    const pairText = (pair: (typeof battle.pairwise)[number] | undefined) =>
      pair
        ? `${nameOf(pair.a)} and ${nameOf(pair.b)}, which shared ` +
          `${pair.overlap} of ${Math.min(resultCount(pair.a), resultCount(pair.b))} ` +
          `returned papers (mean rank gap ` +
          `${
            pair.mean_rank_gap != null
              ? pair.mean_rank_gap.toFixed(2)
              : "n/a"
          })`
        : null;

    const pipelineNames = battle.pipelines
      .map((pipeline) => nameOf(pipeline.id))
      .join(", ");

    /* Verbose APA-style interpretation: a full paragraph a reader
       can drop into a manuscript, not a reference-list entry. */
    const apaText =
      `On ${monthLong} ${day}, ${year}, the Re:Search prototype ` +
      `compared ${battle.pipelines.length} content-based recommendation ` +
      `pipelines on the ${battle.query ? "query" : "seed paper"} ` +
      `${subject} at a depth of ${battle.top_k} results per pipeline: ` +
      `${pipelineNames}. ` +
      (battle.winner?.decisive === false
        ? `No pipeline led decisively: ${(battle.winner.contenders ?? [])
            .map(nameOf)
            .join(", ")} were within ${Math.round(
            (battle.winner.min_margin ?? 0.02) * 100,
          )} percentage points of each other, so the battle is too close to call. ` +
          `The nominal consensus leader was `
        : "The consensus leader was ") +
      `${winnerChip} ` +
      `(${winnerId}), which captured ${winnerPct}% of the available ` +
      "independence-weighted consensus" +
      (battle.winner?.avg_consensus_rank != null
        ? ` at an average consensus rank of #${battle.winner.avg_consensus_rank}`
        : "") +
      ". Agreement was strongest between " +
      (pairText(closest) ?? "n/a") +
      ", while the least agreement occurred between " +
      (pairText(farthest) ?? "n/a") +
      "." +
      (leader?.title != null
        ? ` Across all pipelines, the paper with the broadest consensus ` +
          `was "${leader.title}"` +
          (leader.year ? ` (${leader.year})` : "") +
          (leader.votes != null
            ? `, ranked by ${leader.votes} of ${battle.pipelines.length} pipelines`
            : "") +
          "."
        : "") +
      " Agreement is interpreted with independence weighting, so a " +
      "pipeline's consensus is discounted when the agreeing pipeline " +
      "shares its signals, which prevents a hybrid from being " +
      "confirmed by its own components.";

    return [
      {
        id: "apa",
        label: "APA 7 (interpretation)",
        text: apaText,
      },
      {
        id: "mla",
        label: "MLA 9",
        text:
          `"Comparative Pipeline Battle for ${subject}." ` +
          "Re:Search Arena, local Re:Search recommendation " +
          `prototype, ${mlaDate}. Software battle report. Winner: ` +
          `${winnerChip}, ${winnerPct}% independence-weighted ` +
          `consensus at top-${battle.top_k}.${leaderText}`,
      },
      {
        id: "chicago",
        label: "Chicago",
        text:
          `Re:Search Arena. "Comparative Pipeline Battle for ` +
          `${subject}." Software battle report, local Re:Search ` +
          `recommendation prototype, ${chicagoDate}. Winner: ` +
          `${winnerChip} at ${winnerPct} percent independence-` +
          `weighted consensus.${leaderText}`,
      },
      {
        id: "ieee",
        label: "IEEE",
        text:
          `Re:Search Arena, "Comparative pipeline battle for ` +
          `${subject}," software battle report, local Re:Search ` +
          `recommendation prototype, ${ieeeDate}. Winner: ` +
          `${winnerChip}, ${winnerPct}% independence-weighted ` +
          `consensus.${leaderText}`,
      },
    ];
  })();

  async function copyCitation(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCitation(id);
      window.setTimeout(
        () =>
          setCopiedCitation((current) =>
            current === id ? null : current,
          ),
        1600,
      );
    } catch {
      setCopiedCitation(null);
    }
  }

  /* Result tabs: an arcade cartridge rail — numbered, icon-led
     chips on an ink rail, active tab pressed in accent. */
  const RESULT_TABS = [
    { id: "overview", label: "Winner", icon: Trophy },
    { id: "consensus", label: "Consensus", icon: Layers },
    { id: "pairwise", label: "Pairwise", icon: ArrowLeftRight },
    { id: "grid", label: "Battle grid", icon: Table },
    { id: "scores", label: "Scores", icon: BarChart3 },
    { id: "differences", label: "Why they differ", icon: Split },
    { id: "judge", label: "Judge", icon: Scale },
    { id: "cite", label: "Interpretation", icon: Quote },
  ] as const;

  return (
    <PageShell className="!max-w-[1200px] !gap-5 !py-6">
      <HuntItem item={HUNT_ITEMS.find((item) => item.id === "hunt-key")!} />
      <PageHeader
        eyebrow="Arena"
        title={pageTab === "tournament" ? "Pipeline tournament" : "Pipeline battle"}
        description={
          pageTab === "tournament"
            ? "Score all six pipelines on many papers whose references are known, then test whether any of them is genuinely better."
            : "Run all six pipelines on one query. Compare the consensus ranking, the per-pipeline ranks, and the pairwise agreement."
        }
      />

      <div>
        <PageTabs
          label="Arena view"
          active={pageTab}
          onChange={setPageTab}
          options={[
            { id: "battle", label: "Battle" },
            { id: "tournament" as const, label: "Tournament" },
          ]}
        />
      </div>

      {pageTab === "tournament" ? (
        <ErrorBoundary label="The tournament">
          <TournamentPanel />
        </ErrorBoundary>
      ) : (
        <>

      {/* ======================================================
          THE CABINET — marquee, the screen (the query), and the
          high scores. The default view: insert a query, press start.
          ====================================================== */}

      <section
        aria-label="Battle cabinet"
        data-arena-cabinet=""
        className="overflow-hidden rounded-lg border-[3px] border-gray-900 bg-gray-900 text-onInk shadow-[6px_6px_0_rgba(0,0,0,0.25)]"
      >
        {/* the marquee */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-accent px-4 py-2 text-onAccent">
          <p className="flex items-center gap-2 font-pixelify text-lg font-bold uppercase leading-none tracking-[0.2em]">
            <Star className="h-4 w-4" aria-hidden="true" />
            Pipeline battle
            <Star className="h-4 w-4" aria-hidden="true" />
          </p>
          <p
            aria-live="polite"
            className={`font-mono text-xs font-bold uppercase tracking-[0.25em] ${
              loading || !battle ? "animate-blink" : ""
            }`}
          >
            {loading
              ? webMode
                ? "Searching the web…"
                : `${finishedCount} of ${totalCount} pipelines done`
              : battle
                ? "Battle complete"
                : "Insert query"}
          </p>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* THE SCREEN */}
          <div className="rounded border-[3px] border-black/60 bg-gray-950 p-4 shadow-[inset_0_0_0_2px_rgba(255,255,255,0.08),inset_0_0_36px_rgba(0,0,0,0.55)]">
            {/* mode select */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-onInk/70">
                Select field
              </span>
              {(["repository", "web"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setWebMode(scope === "web")}
                  aria-pressed={webMode === (scope === "web")}
                  /* The explanation is a tooltip, not a caption. As a
                     <span> in this row it became a layout participant:
                     with the 300px high-scores pane beside it the left
                     column is narrow enough that the sentence wrapped to
                     an orphan right-aligned line at 1440 and sat inline
                     at 860, so the same control changed height with the
                     window and pushed the query field down a line. */
                  title={
                    scope === "web"
                      ? "Live hits from the scholarly sources ticked below. " +
                        "Web battles are never recorded to the tally."
                      : "Rank your own repository."
                  }
                  className={`rounded border-[2px] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.15em] transition-colors pixel-ease ${
                    webMode === (scope === "web")
                      ? "border-accent bg-accent text-onAccent"
                      : "border-onInk/40 text-onInk/80 hover:border-accent hover:text-accent"
                  }`}
                >
                  {scope === "repository" ? "Repository" : "Web"}
                </button>
              ))}
            </div>

            <label
              htmlFor="arena-query"
              className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-onInk"
            >
              {isPresentationStored() ? "Search query" : "Player one · enter query"}
            </label>
            <div className="mt-1.5 flex items-center gap-2 border-b-[3px] border-accent pb-1.5">
              <span aria-hidden="true" className="font-pixelify text-xl font-bold text-onInk">
                &gt;
              </span>
              <input
                id="arena-query"
                type="text"
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runBattle();
                }}
                placeholder="e.g. neural network text similarity"
                disabled={loading || Boolean(seedPaper && !webMode)}
                className="min-w-0 flex-1 bg-transparent font-pixelify text-lg text-onInk caret-[rgb(var(--accent))] placeholder:text-onInk/50 focus:outline-none"
              />
            </div>

            {!webMode && (
              <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80">
                <span>Seed paper</span>
                {seedPaper ? (
                  <>
                    <span className="min-w-0 max-w-full truncate rounded border-[2px] border-onInk/40 px-2 py-1 text-xs normal-case tracking-normal text-onInk">
                      {seedPaper.title}
                    </span>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setSeedPaper(null)}
                      className="rounded border-[2px] border-onInk/40 px-2 py-1 hover:border-accent hover:text-accent"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setPickerOpen(true)}
                    className="rounded border-[2px] border-onInk/40 px-2 py-1 hover:border-accent hover:text-accent"
                  >
                    Pick from repository
                  </button>
                )}
                <span className="normal-case tracking-normal text-onInk/60">
                  {seedPaper
                    ? "Scored against its own references."
                    : "Optional. Seed battles are judged automatically."}
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80">
                Depth
                <select
                  value={topK}
                  onChange={(event) => setTopK(Number(event.target.value))}
                  disabled={loading}
                  className="rounded border-[2px] border-onInk/40 bg-gray-950 px-2 py-1 font-mono text-xs text-onInk focus:border-accent focus:outline-none"
                >
                  <option value={5}>Top 5</option>
                  <option value={10}>Top 10</option>
                  <option value={15}>Top 15</option>
                </select>
              </label>

              <button
                type="button"
                onClick={runBattle}
                disabled={loading || !hasInput}
                className={`ml-auto rounded border-[3px] border-black/60 bg-accent px-5 py-1.5 font-pixelify text-base font-bold uppercase tracking-[0.2em] text-onAccent shadow-[0_4px_0_rgba(0,0,0,0.45)] transition-all pixel-ease hover:brightness-110 active:translate-y-[3px] active:shadow-[0_1px_0_rgba(0,0,0,0.45)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  !loading && hasInput ? "animate-blink" : ""
                }`}
              >
                {loading ? "Running…" : isPresentationStored() ? "Run Arena" : "Press start"}
              </button>
            </div>

            {/* RUN TAG — what the next recorded battle will be called.
                Only for repository battles: web battles never reach
                the log, so a tag beside the web options would promise
                a record that is not written. */}
            {!webMode && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t-2 border-dashed border-onInk/20 pt-3">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/70">
                  Run tag
                </span>

                <label className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80">
                  Label
                  <input
                    type="text"
                    value={runLabel}
                    onChange={(event) => setRunLabel(event.target.value)}
                    disabled={loading}
                    placeholder={`${CAMPAIGN_LABEL_PREFIX}ml-text-5`}
                    aria-label="Run label for the next battle"
                    className="w-44 rounded border-[2px] border-onInk/40 bg-gray-950 px-2 py-1 font-mono text-xs normal-case text-onInk placeholder:text-onInk/40 focus:border-accent focus:outline-none"
                  />
                </label>

                <label className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/80">
                  Class
                  <input
                    type="text"
                    value={subjectClass}
                    onChange={(event) => setSubjectClass(event.target.value)}
                    disabled={loading}
                    placeholder="none"
                    list="arena-subject-classes"
                    aria-label="Subject class for the next battle"
                    className="w-48 rounded border-[2px] border-onInk/40 bg-gray-950 px-2 py-1 font-mono text-xs normal-case text-onInk placeholder:text-onInk/40 focus:border-accent focus:outline-none"
                  />
                </label>

                <datalist id="arena-subject-classes">
                  {SUBJECT_CLASSES.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>

                <span className="text-[11px] leading-4 text-onInk/60">
                  {runLabel.trim() || subjectClass
                    ? "Recorded under that name."
                    : "Untagged — not usable as campaign data."}
                </span>
              </div>
            )}

            {webMode && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-onInk/80">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/70">
                    Sources
                  </span>
                  {(["openalex", "crossref", "arxiv", "doaj"] as const).map((source) => (
                    <label key={source} className="flex cursor-pointer items-center gap-1.5 hover:text-onInk">
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
                              : [current, source].filter(Boolean).join(","),
                          )
                        }
                        className=""
                      />
                      {source === "openalex" ? "OpenAlex" : source === "crossref" ? "Crossref" : source === "doaj" ? "DOAJ" : "arXiv"}
                    </label>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 hover:text-onInk">
                  <input
                    type="checkbox"
                    checked={openAccess}
                    onChange={(event) => setOpenAccess(event.target.checked)}
                    className=""
                  />
                  Open access only
                </label>
                <label className="flex items-center gap-1.5 hover:text-onInk">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em]">Sort</span>
                  <select
                    value={webSort}
                    onChange={(event) => setWebSort(event.target.value)}
                    className="rounded border-[2px] border-onInk/40 bg-gray-950 px-2 py-0.5 text-xs text-onInk focus:outline-none"
                  >
                    <option value="relevance">Relevance</option>
                    <option value="year">Newest first</option>
                  </select>
                </label>
              </div>
            )}

            {/* what the screen says: the attract text, the rounds, or the result line */}
            <div className="mt-3 border-t-2 border-dashed border-onInk/25 pt-3">
              {loading ? (
                <div>
                  <p className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-[0.15em] text-onInk">
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    {webMode
                      ? "Searching the web"
                      : nextUp
                        ? `Running: ${displayName(nextUp)}`
                        : finishedCount > 0
                          ? "Comparing the lists"
                          : "Starting"}
                  </p>
                  <PixelProgress
                    value={webMode || progress.order.length === 0 ? null : finishedCount / totalCount}
                    stage={webMode ? undefined : `${finishedCount} OF ${totalCount} DONE`}
                    className="mt-3 w-full"
                  />
                  {progress.finished.length > 0 && (
                    <ul className="mt-3 space-y-0.5 font-mono text-[10px] text-onInk/80">
                      {progress.finished.map((entry) => (
                        <li key={entry.id} className="flex gap-2">
                          <span className="w-28 shrink-0 truncate font-bold text-onInk">
                            {displayName(entry.id)}
                          </span>
                          <span className="w-10 shrink-0 text-right">{entry.seconds.toFixed(1)}s</span>
                          <span className="min-w-0 truncate">{entry.top ?? "no results"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : battle?.winner ? (
                <p className="font-mono text-xs leading-5 text-onInk/90">
                  <span className="font-bold uppercase tracking-[0.2em] text-onInk">Last battle · </span>
                  {battle.winner.decisive === false
                    ? `Too close to call: ${(battle.winner.contenders ?? [battle.winner.pipeline_id])
                        .map(displayName)
                        .join(", ")} are within ${Math.round((battle.winner.min_margin ?? 0.02) * 100)} points.`
                    : `${displayName(battle.winner.pipeline_id)} led with ${(battle.winner.value * 100).toFixed(0)}% of the consensus.`}{" "}
                  The result is below.
                </p>
              ) : (
                <p className="text-xs leading-5 text-onInk/80">
                  A battle runs all six pipelines on one query. The pipelines compete on the same prepared text; the
                  winner takes the largest share of independence-weighted consensus. Seed-paper mode is in{" "}
                  <Link to="/recommendations" className="font-bold text-onInk underline hover:decoration-2">
                    Recommendations
                  </Link>
                  .
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
              {isPresentationStored() ? "Decisive wins" : "High scores"}
            </p>
            <ol className="mt-2 space-y-1.5">
              {tally.map((entry, index) => {
                const share = totalRuns > 0 ? entry.wins / totalRuns : 0;

                return (
                  <li key={entry.id} className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-4 text-right text-onInk/85">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-bold tracking-[0.1em] text-onInk">
                        {displayName(entry.id)}
                      </span>
                      {index === 0 && entry.wins > 0 && (
                        <Star className="animate-blink h-3 w-3 text-accent" aria-label="Champion" />
                      )}
                      <span className="w-8 text-right font-bold text-onInk">{entry.wins}</span>
                    </div>
                    <div className="ml-6 mt-0.5 h-1 overflow-hidden bg-onInk/15" aria-hidden="true">
                      <div className="h-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="mt-auto border-t border-onInk/20 pt-2 font-mono text-[10px] font-bold uppercase leading-4 tracking-[0.15em] text-onInk/75">
              {totalRuns} {totalRuns === 1 ? "battle" : "battles"} fought
              {verdicts
                ? ` · ${verdicts.decisive} decisive · ${verdicts.too_close} too close`
                : ""}
              {verdicts && verdicts.unknown + verdicts.legacy > 0
                ? ` · ${verdicts.unknown + verdicts.legacy} unscored (older)`
                : ""}
              {currentStreak > 1
                ? ` · streak ×${currentStreak} for ${displayName(leader.id)}`
                : ""}
            </p>
          </aside>
        </div>
      </section>

      {/* ======================================================
          ERROR
          ====================================================== */}

      {error && (
        <div className="status-error">{error}</div>
      )}

      {/* ======================================================
          RESULTS
          ====================================================== */}

      {!loading && battle && (
        <div className="space-y-4">
          {/* ------------------------------------------------
              RESULT TABS — one panel per result type, the first
              one is the summary, the last the recorded history
              ------------------------------------------------ */}

          {/* RAIL — always visible; the battle grid/scores/records are the
              default view, the rest adapt once a battle lands */}
          <div className="rounded border-[3px] border-gray-900 bg-gray-900 p-2">
            <div
              role="tablist"
              aria-label="Arena results"
              className="flex flex-wrap gap-1.5"
            >
              {RESULT_TABS.map(({ id, label, icon: Icon }, index) => {
                const active = resultsTab === id;

                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={label}
                    onClick={() => setResultsTab(id)}
                    className={`relative flex items-center gap-1.5 rounded border-[2px] px-2 py-1.5 font-pixelify text-[11px] font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
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

          <div key={resultsTab} className="animate-step-in space-y-4">

          {/* ------------------------------------------------
              WINNER BANNER
              ------------------------------------------------ */}

          {resultsTab === "overview" && battle?.winner && (
            <section className="rounded border-[3px] border-gray-900 bg-gray-900 p-4 text-onInk">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="animate-blink flex items-center gap-2 font-mono text-xs font-bold tracking-[0.3em] text-accent">
                    <Star className="h-3.5 w-3.5" />
                    {battle.winner.decisive === false
                      ? "TOO CLOSE TO CALL · NO QUALITY VERDICT"
                      : "CONSENSUS LEADER · NO QUALITY VERDICT"}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="rounded border-[2px] border-gray-900 bg-surface px-2 py-1 font-mono text-sm font-bold tracking-[0.12em] text-ink">
                      {displayName(battle.winner.pipeline_id)}
                    </span>
                    <span className="font-mono text-xs text-onInk/70">
                      {battle.winner.pipeline_id}
                    </span>
                  </div>

                  {battle.winner.decisive === false && (
                    <p className="mt-2 text-xs font-bold leading-5 text-accent">
                      {(battle.winner.contenders ?? []).map(displayName).join(" · ")} are within{" "}
                      {Math.round((battle.winner.min_margin ?? 0.02) * 100)} points of each other
                      {battle.winner.margin != null
                        ? ` (lead ${(battle.winner.margin * 100).toFixed(1)} points)`
                        : ""}
                      . The name above is only the nominal leader; do not read it as a win.
                    </p>
                  )}

                  <p className="mt-2 text-xs leading-5 text-onInk/70">
                    Captured the most independence-weighted
                    consensus across its top-{battle.top_k} results
                    {battle.winner.avg_consensus_rank !== null
                      ? ` · avg consensus rank #${battle.winner.avg_consensus_rank}`
                      : ""}
                    . Agreement with a rival pipeline counts only as
                    much as that rival is built from different
                    signals, a pipeline cannot be confirmed by its
                    own hybrids. This is agreement on one query, not
                    accuracy: use the Tournament tab to test which
                    pipeline is actually better.
                  </p>
                </div>

                <div className="shrink-0 sm:text-right">
                  <p className="font-mono text-3xl font-bold leading-none text-accent">
                    {(battle.winner.value * 100).toFixed(0)}%
                  </p>
                  <p className="mt-1 font-mono text-xs text-onInk/70">
                    of available consensus
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* ------------------------------------------------
              SCORE DISTRIBUTION — GROUPED BY RANK
              ------------------------------------------------ */}

          {resultsTab === "scores" && battle && (
          <section className="rounded border-[3px] border-gray-900 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <p className="text-sm font-bold text-ink">
                Score distribution
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                One row per rank position: the six pipelines'
                scores for that spot, scaled against the highest
                score across all pipelines.
              </p>
            </div>

            {(() => {
              const allScores = battle.pipelines.flatMap(
                (pipeline) =>
                  pipeline.results.map((result) => result.score)
              );

              const globalMax =
                allScores.length > 0
                  ? Math.max(...allScores)
                  : 0;

              const maxRanks = Math.min(
                5,
                Math.max(
                  0,
                  ...battle.pipelines.map(
                    (pipeline) => pipeline.results.length
                  ),
                ),
              );

              if (maxRanks === 0) {
                return (
                  <p className="px-2 py-1.5 text-sm leading-6 text-muted">
                    No scores to chart. The repository returned
                    no results for this query.
                  </p>
                );
              }

              return (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px]">
                    <thead>
                      <tr className="border-b-[3px] border-gray-900">
                        <th className="px-3 py-1.5 text-left text-xs uppercase tracking-wide text-muted">
                          Rank
                        </th>

                        {BATTLE_IDS.map((id) => (
                          <th key={id} className="px-2 py-1.5 text-center">
                            <div className="flex flex-col items-center gap-1">
                              <PipelineChip pipelineId={id} />
                              {id === battle.winner?.pipeline_id && (
                                <span className="animate-blink flex items-center gap-1 font-mono text-xs font-bold tracking-[0.2em] text-accent">
                                  <Star className="h-3 w-3" />
                                  WINNER
                                </span>
                              )}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {Array.from(
                        { length: maxRanks },
                        (_, index) => index + 1
                      ).map((rank) => (
                        <tr
                          key={rank}
                          className="border-b border-gray-200 last:border-b-0"
                        >
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-sm font-bold text-ink">
                            #{rank}
                          </td>

                          {BATTLE_IDS.map((id) => {
                            const pipeline = battle.pipelines.find(
                              (entry) => entry.id === id
                            );
                            const result = pipeline?.results[rank - 1];

                            if (!result) {
                              return (
                                <td
                                  key={id}
                                  className="px-2 py-1.5 text-center font-mono text-xs text-muted"
                                >
                                  —
                                </td>
                              );
                            }

                            const isWinner =
                              id === battle.winner?.pipeline_id;

                            return (
                              <td key={id} className="px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <div
                                    className={`h-4 flex-1 overflow-hidden rounded border-[2px] border-gray-900 bg-field ${
                                      isWinner ? "ring-2 ring-gray-900" : ""
                                    }`}
                                  >
                                    <div
                                      className={`h-full ${
                                        isWinner ? "bg-accent" : "bg-ink"
                                      }`}
                                      style={{
                                        width: `${
                                          globalMax > 0
                                            ? (result.score / globalMax) * 100
                                            : 0
                                        }%`,
                                      }}
                                    />
                                  </div>
                                  <span className="w-14 shrink-0 text-right font-mono text-xs text-muted">
                                    {formatScore(result.score)}
                                  </span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
          )}

          {/* ------------------------------------------------
              CONSENSUS PODIUM
              ------------------------------------------------ */}

          {resultsTab === "consensus" && battle && (
          <div>

          <section className="rounded border-[3px] border-gray-900 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <p className="text-sm font-bold text-ink">
                Consensus ranking
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Papers ordered by how many of the {battle.pipelines.length}{" "}
                pipelines ranked them, then by average rank.
              </p>
            </div>

            <div className="divide-y divide-gray-200">
              {gridPapers.slice(0, 5).map((entry, index) => (
                <StaggerIn key={entry.paper_id} index={index}>
                  <div className="flex items-center gap-2 px-4 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[3px] border-gray-900 bg-surface font-mono text-xs font-bold text-ink">
                      {index + 1}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {entry.title ?? `Paper #${entry.paper_id}`}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        Paper #{entry.paper_id}
                        {entry.year ? ` · ${entry.year}` : ""}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="rounded border-[2px] border-gray-900 bg-accent px-2 py-0.5 font-mono text-xs font-bold text-onAccent">
                        {entry.votes}/{battle.pipelines.length} votes
                      </span>
                      <span className="font-mono text-xs text-muted">
                        avg rank {formatScore(entry.avg_rank)}
                        {entry.best_rank
                          ? ` · best #${entry.best_rank}`
                          : ""}
                      </span>
                    </div>
                  </div>
                </StaggerIn>
              ))}
            </div>
          </section>
          </div>
          )}

          {/* ------------------------------------------------
              PAIRWISE AGREEMENT
              ------------------------------------------------ */}

          {resultsTab === "pairwise" && battle && (
          <div>
              <section className="rounded border-[3px] border-gray-900 bg-white">
                <div className="border-b border-gray-200 px-4 py-3">
                  <p className="text-sm font-bold text-ink">
                    Pairwise agreement
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Overlap = papers both pipelines ranked. Mean rank gap =
                    average absolute rank difference over shared papers
                    (lower = more agreement).
                  </p>
                </div>

                <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
                  {pagedPairs.map((pair, index) => {
                    const countA =
                      battle.pipelines.find((p) => p.id === pair.a)
                        ?.results.length ?? 0;
                    const countB =
                      battle.pipelines.find((p) => p.id === pair.b)
                        ?.results.length ?? 0;

                    // Overlap can never exceed what both pipelines
                    // actually returned — use that as the denominator.
                    const maxOverlap = Math.min(countA, countB);

                    return (
                    <StaggerIn
                      key={`${pair.a}-${pair.b}`}
                      index={pairPageStart + index}
                    >
                      <div className="rounded border-[2px] border-gray-900 bg-canvas p-2">
                        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <PipelineChip pipelineId={pair.a} />
                          <span className="font-mono text-xs text-muted">vs</span>
                          <PipelineChip pipelineId={pair.b} />
                        </div>

                        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-ink">
                          <span>
                            overlap{" "}
                            <span className="font-bold">
                              {pair.overlap}/{maxOverlap}
                            </span>
                          </span>
                          <span>
                            rank gap{" "}
                            <span className="font-bold">
                              {formatScore(pair.mean_rank_gap)}
                            </span>
                          </span>
                        </div>
                      </div>
                    </StaggerIn>
                    );
                  })}
                </div>

                <Pagination
                  page={pairPage}
                  pageCount={pairPageCount}
                  onPageChange={setPairPage}
                  total={battle.pairwise.length}
                  pageSize={PAIR_PAGE_SIZE}
                  className="border-t-[3px] border-gray-900"
                />
              </section>
            </div>
          )}

          {/* ------------------------------------------------
              BATTLE GRID
              ------------------------------------------------ */}

          {resultsTab === "grid" && battle && (
          <section className="rounded border-[3px] border-gray-900 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <p className="font-pixelify text-sm font-bold text-ink">
                Battle grid
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Rank of each paper under each pipeline. Empty cell =
                the paper did not make that pipeline's top-{battle.top_k}.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b-[3px] border-gray-900">
                    <th className="px-3 py-1.5 text-xs uppercase tracking-wide text-muted">
                      Paper
                    </th>
                    {BATTLE_IDS.map((id) => (
                      <th
                        key={id}
                        className="whitespace-nowrap px-2 py-1.5 text-right"
                      >
                        <PipelineChip pipelineId={id} />
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {pagedGridPapers.map((entry, index) => (
                    <StaggerIn
                      as="tr"
                      key={entry.paper_id}
                      index={gridPageStart + index}
                      className="border-b border-gray-200 last:border-b-0"
                    >
                      <td className="max-w-[260px] px-3 py-1.5">
                          <p className="truncate font-medium text-ink">
                            {entry.title ?? `Paper #${entry.paper_id}`}
                          </p>
                          <p className="mt-0.5 text-xs text-muted">
                            #{entry.paper_id}
                            {entry.year ? ` · ${entry.year}` : ""}
                          </p>
                        </td>

                        {BATTLE_IDS.map((id) => {
                          const rank = rankById(id, entry.paper_id);
                          const score = scoreById(id, entry.paper_id);

                          return (
                            <td
                              key={id}
                              className="whitespace-nowrap px-2 py-1.5 text-right"
                            >
                              {rank === null ? (
                                <span className="inline-block min-w-[52px] text-muted">—</span>
                              ) : (
                                <span className="inline-flex min-w-[52px] flex-col items-end">
                                  <span className="font-mono text-sm font-bold leading-5 text-ink">
                                    #{rank}
                                  </span>
                                  <span className="font-mono text-xs leading-5 text-muted">
                                    {formatScore(score)}
                                  </span>
                                </span>
                              )}
                            </td>
                          );
                        })}
                    </StaggerIn>
                  ))}
                </tbody>
              </table>

              <Pagination
                page={gridPage}
                pageCount={gridPageCount}
                onPageChange={setGridPage}
                total={gridPapers.length}
                pageSize={GRID_PAGE_SIZE}
                className="border-t-[3px] border-gray-900"
              />
            </div>
          </section>
          )}

          {/* ------------------------------------------------
              SCORE BARS — the same scores read down a pipeline
              rather than across a rank row. It is a second view of
              the table above, not a second "Score distribution":
              both panels are gated on resultsTab === "scores", so
              before this heading was corrected the Scores tab showed
              two identically-titled sections stacked on each other,
              each restating ranks 1-5 for every pipeline.
              ------------------------------------------------ */}

          {resultsTab === "scores" && battle && (
          <section className="rounded border-[3px] border-gray-900 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <p className="text-sm font-bold text-ink">
                Each pipeline&rsquo;s top 5
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                The same scores as above, read down one pipeline at a
                time. Use it to see a pipeline&rsquo;s shape — whether
                it separates its first hit or flattens out.
              </p>
            </div>

            <div className="space-y-3 px-4 py-3">
              {(() => {
                const allScores = battle.pipelines.flatMap(
                  (pipeline) =>
                    pipeline.results.map((result) => result.score)
                );

                const globalMax =
                  allScores.length > 0
                    ? Math.max(...allScores)
                    : 0;

                return BATTLE_IDS.map((id) => {
                  const pipeline = battle.pipelines.find(
                    (entry) => entry.id === id
                  );

                  if (!pipeline || pipeline.results.length === 0) {
                    return null;
                  }

                  const maxScore = Math.max(
                    ...pipeline.results.map((result) => result.score)
                  );

                  return (
                    <div key={id}>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <PipelineChip pipelineId={id} />
                          {id === battle.winner?.pipeline_id && (
                            <span className="animate-blink flex items-center gap-1 font-mono text-xs font-bold tracking-[0.2em] text-accent">
                              <Star className="h-3 w-3" />
                              WINNER
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-xs text-muted">
                          max {formatScore(maxScore)}
                        </span>
                      </div>

                      <div className="space-y-1">
                        {pipeline.results.slice(0, 5).map((result) => (
                          <div
                            key={result.paper_id}
                            className="flex items-center gap-2"
                          >
                            <span className="w-7 shrink-0 text-right font-mono text-xs text-muted">
                              #{pipeline.results.indexOf(result) + 1}
                            </span>

                            <div
                              className={`h-4 flex-1 overflow-hidden rounded border-[2px] border-gray-900 bg-field ${
                                id === battle.winner?.pipeline_id
                                  ? "ring-2 ring-gray-900"
                                  : ""
                              }`}
                            >
                              <div
                                className={`h-full ${
                                  id === battle.winner?.pipeline_id
                                    ? "bg-accent"
                                    : "bg-ink"
                                }`}
                                style={{
                                  width: `${
                                    globalMax > 0
                                      ? (result.score / globalMax) * 100
                                      : 0
                                  }%`,
                                }}
                              />
                            </div>

                            <span className="w-14 shrink-0 font-mono text-xs text-muted">
                              {formatScore(result.score)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </section>
          )}

          {/* ------------------------------------------------
              INTERPRETATION — citation-ready result summaries
              ------------------------------------------------ */}

          {resultsTab === "differences" && battle && (
            <BattleDifferencesPanel
              differences={battle.differences}
              name={displayName}
            />
          )}

          {resultsTab === "judge" && battle && (
            <BattleJudge
              key={battle.battle_id ?? "unrecorded"}
              battle={battle}
              name={displayName}
              onJudged={() => void loadHistory(historyPage)}
            />
          )}

          {resultsTab === "cite" && battle && citations && (
            <section className="rounded border-[3px] border-gray-900 bg-white">
              <div className="border-b border-gray-200 px-4 py-3">
                <p className="font-pixelify text-sm font-bold text-ink">
                  Result interpretation
                </p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  The current battle written up citation-style. Copy a
                  whole block into a manuscript, then fit it to your
                  sentence; every figure comes straight from this run.
                </p>
              </div>

              <div className="space-y-3 px-4 py-3">
                {citations.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded border-[2px] border-gray-900 bg-canvas p-2"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
                        {entry.label}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void copyCitation(entry.id, entry.text)
                        }
                        className="rounded border-[2px] border-gray-900 bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
                      >
                        {copiedCitation === entry.id
                          ? "Copied \u2713"
                          : "Copy"}
                      </button>
                    </div>
                    <p className="select-all whitespace-pre-wrap font-mono text-xs leading-5 text-ink">
                      {entry.text}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          </div>
        </div>
      )}

      {/* ======================================================
          BATTLE LOG — the scoreboard of past runs. Always here;
          a finished battle lands on top of it.
          ====================================================== */}

      <BattleSeries
        topK={topK}
        name={displayName}
        onBattle={() => void loadHistory(1)}
      />

      <section
        aria-label="Battle log"
        data-arena-log=""
        className="overflow-hidden rounded-lg border-[3px] border-gray-900 bg-white shadow-[4px_4px_0_rgba(0,0,0,0.2)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-gray-900 px-3 py-1.5 text-onInk">
          <p className="flex items-center gap-2 font-pixelify text-sm font-bold uppercase tracking-[0.2em]">
            <History className="h-4 w-4 text-accent" aria-hidden="true" />
            Battle log
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-onInk/80">
            {historyTotal} {historyTotal === 1 ? "run" : "runs"} · page {historyPage} of {historyPages}
          </p>
        </div>

        {/* ----
            EXPORT / ARCHIVE — the collection protocol's controls,
            directly under the count they act on. The format dropdown
            is CSV vs JSONL rather than a file type menu because the
            two are genuinely different artefacts: CSV is a table for
            a spreadsheet, JSONL is the analysis file that carries
            every run's full consensus and agreement structure.
            ---- */}
        <div className="flex flex-wrap items-center gap-2 border-b-[3px] border-gray-900 bg-canvas px-4 py-3">
          <label className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export
            <select
              value={exportFormat}
              onChange={(event) =>
                setExportFormat(event.target.value as BattleExportFormat)
              }
              disabled={exporting || historyTotal === 0}
              aria-label="Export format"
              className="rounded border-[2px] border-gray-900 bg-white px-2 py-1 font-mono text-[11px] text-ink focus:outline-none disabled:opacity-50"
            >
              <option value="csv">CSV · one row per run</option>
              <option value="jsonl">JSONL · full responses</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => void downloadHistory(exportFormat)}
            disabled={exporting || historyTotal === 0}
            className="rounded border-[3px] border-gray-900 bg-white px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Download"}
          </button>

          <button
            type="button"
            onClick={() => setArchiveOpen(true)}
            disabled={historyTotal === 0}
            className="rounded border-[3px] border-gray-900 bg-white px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:cursor-not-allowed disabled:opacity-50"
          >
            Archive &amp; reset
          </button>

          <span className="text-[11px] leading-4 text-muted">
            Archives write every run to storage/exports/ before the log is
            cleared, so a reset never destroys the tally it was measuring.
          </span>
        </div>

        {logNotice && (
          <p
            role="status"
            className="border-b-[3px] border-gray-900 bg-accentSoft px-3 py-1.5 font-mono text-[11px] text-ink"
          >
            {logNotice}
          </p>
        )}

        {history.length === 0 ? (
          <div className="px-3 py-5 text-center">
            <p className="animate-blink font-pixelify text-lg font-bold uppercase tracking-[0.2em] text-ink">
              No battles yet
            </p>
            <p className="mt-1 text-xs text-muted">Enter a query above and press start. Every battle is logged here.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs [&_th]:align-middle [&_td]:align-middle">
                <thead>
                  <tr className="border-b-[3px] border-gray-900 bg-canvas">
                    <th className="w-12 px-3 py-1.5 text-right uppercase tracking-wide text-muted">#</th>
                    <th className="px-2 py-1.5 uppercase tracking-wide text-muted">Time</th>
                    <th className="px-2 py-1.5 uppercase tracking-wide text-muted">Query</th>
                    <th className="px-2 py-1.5 uppercase tracking-wide text-muted">Tag</th>
                    <th className="px-2 py-1.5 text-left uppercase tracking-wide text-muted">Winner</th>
                    <th className="px-3 py-1.5 text-right uppercase tracking-wide text-muted">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((run, index) => {
                    const fresh =
                      index === 0 && historyPage === 1 && battle?.battle_id != null && !webMode && !loading;

                    return (
                      <StaggerIn
                        as="tr"
                        key={run.id}
                        index={index}
                        className={`border-b border-gray-200 last:border-b-0 ${fresh ? "shadow-[inset_4px_0_0_rgb(var(--accent))]" : ""}`}
                      >
                        <td className="px-3 py-1.5 text-right font-mono text-muted">
                          {historyTotal - ((historyPage - 1) * HISTORY_PAGE_SIZE + index)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted">
                          {formatRunTime(run.created_at)}
                          {fresh && (
                            <span className="animate-blink ml-2 rounded bg-accent px-1 py-0.5 text-[9px] font-bold tracking-[0.15em] text-onAccent">
                              NEW
                            </span>
                          )}
                        </td>
                        <td className="max-w-[280px] px-2 py-1.5">
                          <p className="truncate font-medium text-ink">
                            {run.query ?? `Seed paper #${run.seed_paper_id}`}
                          </p>
                        </td>
                        {/* The tag column is what makes a formal run
                            identifiable in the log itself. Every run
                            recorded before the research log existed
                            shows an em dash: that blank IS the signal
                            that a row predates the campaign. */}
                        <td className="max-w-[180px] px-2 py-1.5">
                          {run.run_label || run.subject_class ? (
                            <>
                              {run.run_label && (
                                <p className="truncate font-mono text-[11px] font-bold text-ink">
                                  {run.run_label}
                                </p>
                              )}
                              {run.subject_class && (
                                <p className="truncate font-mono text-[10px] text-muted">
                                  {run.subject_class}
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="font-mono text-muted">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-left">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <PipelineChip pipelineId={run.winner_pipeline_id} />
                            {run.decisive === false && (
                              <span className="rounded border border-gray-900/40 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted">
                                too close
                              </span>
                            )}
                            {run.judged_basis && (
                              <span
                                className="rounded border border-gray-900 bg-accentSoft px-1 py-px font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-ink"
                                title={run.judged_leader ? `Judged leader: ${displayName(run.judged_leader)}` : "Judged"}
                              >
                                judged
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono font-bold text-ink">
                          {run.winner_value != null
                            ? run.winner_metric === "independence_weighted_consensus"
                              ? `${(run.winner_value * 100).toFixed(0)}%`
                              : `${run.winner_value.toFixed(2)}/6`
                            : "—"}
                        </td>
                      </StaggerIn>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-gray-200 px-3 py-1.5">
              <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
                Winner score spread (this page)
              </p>
              <FreqBars data={scoreBuckets} ariaLabel="Winner score frequency distribution" />
            </div>

            <Pagination
              page={historyPage}
              pageCount={historyPages}
              onPageChange={(next) => void loadHistory(next)}
              total={historyTotal}
              pageSize={HISTORY_PAGE_SIZE}
              className="border-t-[3px] border-gray-900"
            />
          </>
        )}
      </section>

      {/* ======================================================
          ARCHIVE & RESET — the campaign's starting gun.

          The dialog states the two facts that make the action
          reviewable rather than frightening: exactly how many runs
          will be written out, and exactly where they will land. The
          filename is quoted as a pattern, not invented, because the
          server stamps the timestamp at the moment of writing.
          ====================================================== */}

      <RetroDialog
        open={archiveOpen}
        title="Archive and reset the battle log"
        confirmLabel={archiving ? "Archiving…" : `Archive ${historyTotal} runs`}
        cancelLabel="Keep the log"
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void archiveHistory()}
      >
        <div className="flex flex-col gap-2.5">
          <p className="text-ink">
            <span className="font-bold">{historyTotal}</span>{" "}
            {historyTotal === 1 ? "run" : "runs"} will be written to a
            JSONL file under
          </p>

          <p className="select-all rounded border-[2px] border-gray-900 bg-canvas px-2 py-1 font-mono text-[11px] text-ink">
            storage/exports/battle_runs-&lt;timestamp&gt;.jsonl
          </p>

          <p className="text-ink">
            and then the battle log is cleared, so the tally counts only
            the runs you collect from here on. The archive keeps every
            run in full — its consensus ranking, per-pipeline ranks and
            pairwise agreement — so a reset costs you nothing that was
            already collected.
          </p>

          <p className="text-muted">
            Existing archive files are never overwritten; each reset adds
            a new one.
          </p>

          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="self-start rounded border-[2px] border-gray-900 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft"
          >
            Delete instead, keep nothing
          </button>
        </div>
      </RetroDialog>

      {/* Second dialog, one level deeper: archiving already satisfies
          the protocol, so a permanent delete has to be asked for
          twice before it will happen. */}
      <RetroDialog
        open={deleteOpen}
        title="Delete the battle log"
        size="sm"
        confirmLabel={deleting ? "Deleting…" : "Delete, keep nothing"}
        cancelLabel="Go back"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void destroyHistory()}
      >
        <p className="text-ink">
          All {historyTotal} {historyTotal === 1 ? "run" : "runs"} will
          be deleted and nothing will be written anywhere. There is no
          way to recover them.
        </p>
      </RetroDialog>
        </>
      )}
    </PageShell>
  );
}
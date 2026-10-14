import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Database,
  Globe,
  Maximize2,
  SlidersHorizontal,
  Search as SearchIcon,
  Sigma,
  Table,
} from "lucide-react";
import ResponsiveLabel from "../../components/ResponsiveLabel";
import {
  listPapers,
  saveToLibrary,
  removeFromLibrary,
  deletePaper,
  deletePaperPdf,
  getLibrary,
  getSyncStatus,
  rebuildRecommendationIndex,
  startSync,
  type SyncJob,
  searchWeb,
  importPaperFromMetadata,
  getRecommendations,
  getWebRecommendations,
  getPaper,
  notifyRecommendationIndexStale,
  Paper,
  SearchResult,
  WebSearchResult,
} from "../../api";
import PaperViewerModal from "../../components/PaperViewerModal";
import MathText from "../../components/MathText";
import PetFigure from "../../components/PetFigure";
import LayoutOptions from "../../components/LayoutOptions";
import StaggerIn from "../../components/retro/StaggerIn";
import Pagination from "../../components/retro/Pagination";
import PaneHandle, { usePaneWidth } from "../../components/ResizeHandle";
import { accession, spineColor } from "../../utils/catalogue.ts";
import "./repository.css";
import Highlight from "../../components/Highlight";
import WebSimilarPanel from "../../components/WebSimilarPanel";
import ConnectionsPane from "../../components/ConnectionsPane";
import ConnectionsWorkbench from "../../components/ConnectionsWorkbench";
import InspectorPopup, {
  INSPECTOR_TABS,
  type InspectorTab,
} from "../../components/InspectorPopup";
import {
  PaperDetailsBody,
  PaperNotesBody,
  PaperPdfBody,
} from "../../components/InspectorBodies";
import LiteratureMenu from "../../components/LiteratureMenu";
import RepoStatsPane from "../../components/RepoStatsPane";
import AlgorithmConsole from "../../components/AlgorithmConsole";
import EditableCell from "../../components/EditableCell";
import RetroDialog from "../../components/retro/RetroDialog";
import { Check, Star } from "../../components/retro/PixelIcons";
import { Button, EmptyState, PageHeader, TextInput } from "../../components/ui";
import HuntItem from "../../components/retro/HuntItem";
import { HUNT_ITEMS } from "../../data/hunt";
import { usePipelineMode } from "../../state/pipelineMode";
import {
  pipelineName,
  pipelineConfigs,
  customPipelineConfig,
} from "../../data/pipelineConfigs";
import {
  SUBJECT_FILTERS,
  CATEGORY_FILTERS,
  DOCUMENT_TYPE_FILTERS,
} from "../../data/catalog";
import { useCatalog } from "../../hooks/useCatalog";
import { useLayoutPrefs } from "../../state/layoutPrefs";
import { useNerdButtons } from "../../state/nerdButtons";
import { useSiteMode } from "../../state/siteMode";
import { useSun } from "../../state/sun";
import { useLongPressFeed } from "../../utils/longPress";
import { useStatsDrawer } from "../../state/statsDrawer";
import { triggerSlimeAnimation } from "../../utils/slimeEvents";
import {
  blendRecommendations,
  seedWebQuery,
  type BlendRow,
} from "../../utils/blendRecommendations";

function categoryOf(paper: Paper) {
  const parts = paper.subject_category?.split(":", 2).map((p) => p.trim());
  return { subject: parts?.[0] ?? "", category: parts?.[1] ?? "" };
}


/* Resizable pane bounds (persisted per browser). */
const REPO_LEFT_KEY = "paperrec_repo_pane_left";
const REPO_LEFT_MIN = 220;
const REPO_LEFT_MAX = 420;
const REPO_RIGHT_KEY = "paperrec_repo_pane_right";
const REPO_RIGHT_MIN = 300;
const REPO_RIGHT_MAX = 560;

type SearchMode = "repository" | "web" | "recommend";

/** MMR lambda used by the Diversify toggle (matches the Search page). */
const MMR_LAMBDA = 0.7;

/** Per-browser preference for blending web hits into Recommend. */
const BLEND_WEB_KEY = "paperrec_repo_blend_web";

/** Stable identity for a web hit (dedupe across repeat searches). */
function webKey(result: WebSearchResult): string {
  return result.doi ?? result.landing_url ?? result.title;
}

const WEB_INSPECTOR_TABS = INSPECTOR_TABS.filter(
  (tab) => tab.id === "details" || tab.id === "similar",
);

export default function Repository() {
  const catalog = useCatalog();
  const { prefs } = useLayoutPrefs();
  const presenting = useSiteMode().mode === "presentation";
  /* The advanced similar-papers layer (zones, edge-strength, topic
     edges, year gradient) unlocks with Pro; basic gets the plain graph. */
  const { proUnlocked } = useSun();

  /* Resizable pane widths (persisted per browser). */

  const [leftPaneW, resizeLeft] = usePaneWidth(
    REPO_LEFT_KEY,
    288,
    REPO_LEFT_MIN,
    REPO_LEFT_MAX,
  );

  const [rightPaneW, resizeRight] = usePaneWidth(
    REPO_RIGHT_KEY,
    384,
    REPO_RIGHT_MIN,
    REPO_RIGHT_MAX,
  );

  // Backend-owned taxonomy: seed filters until the catalog loads,
  // then the live values (including any subjects/categories added
  // by new references).
  const subjects: string[] = [
    "All Subjects",
    ...(catalog?.subjects ?? SUBJECT_FILTERS.slice(1)),
  ];
  const categories: string[] = [
    "All Categories",
    ...(catalog?.categories ?? CATEGORY_FILTERS.slice(1)),
  ];
  const documentTypes: string[] = [
    "All",
    ...(catalog?.document_types ?? DOCUMENT_TYPE_FILTERS.slice(1)),
  ];

  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  /* Themed confirmation pop-up (replaces the native confirm boxes). */
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    onYes: () => void | Promise<void>;
  } | null>(null);

  function askConfirm(
    title: string,
    body: string,
    onYes: () => void | Promise<void>,
  ) {
    setConfirm({ title, body, onYes });
  }

  /* Recommendation search (the merged Search scope): ranked results
     run through the same pipeline, top_k and MMR controls. */
  const [recommendResults, setRecommendResults] = useState<
    SearchResult[]
  >([]);
  const [recommendLoading, setRecommendLoading] = useState(false);
  const [recommendError, setRecommendError] = useState<
    string | null
  >(null);
  const [recommendSearched, setRecommendSearched] = useState(false);
  const lastRecommendRef = useRef<{ query: string; seed?: number } | null>(null);
  const recommendRequestRef = useRef(0);
  const [topK, setTopK] = useState(10);
  const [diversify, setDiversify] = useState(false);
  // Opt-in: also fetch live web recommendations and merge them into
  // the Recommend list (off by default, remembered per browser).
  const [blendWeb, setBlendWebRaw] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(BLEND_WEB_KEY) === "1";
    } catch {
      return false;
    }
  });
  function setBlendWeb(next: boolean) {
    setBlendWebRaw(next);
    try {
      window.localStorage.setItem(BLEND_WEB_KEY, next ? "1" : "0");
    } catch {
      // Best-effort.
    }
  }
  // Merged rows (null = blend off for the list on screen) and the
  // notice shown when the web half failed.
  const [blendRows, setBlendRows] = useState<BlendRow[] | null>(null);
  const [blendNotice, setBlendNotice] = useState<string | null>(null);
  const [subject, setSubject] = useState(subjects[0]);
  const [category, setCategory] = useState(categories[0]);
  const [documentType, setDocumentType] = useState(documentTypes[0]);
  const [minYear, setMinYear] = useState(2008);
  const [maxYear, setMaxYear] = useState(2026);

  // Year-filter helpers: an emptied field is 0 (unset) and must not
  // reach the backend as a literal 0 -- max_year=0 would filter
  // everything out. Swap the pair when the user inverts the range.
  function parseYear(raw: string): number {
    if (raw === "") return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function handleMinYearChange(raw: string) {
    const value = parseYear(raw);
    setMinYear(value);
    if (value > 0 && maxYear > 0 && value > maxYear) setMaxYear(value);
  }

  function handleMaxYearChange(raw: string) {
    const value = parseYear(raw);
    setMaxYear(value);
    if (value > 0 && minYear > 0 && value < minYear) setMinYear(value);
  }

  // null (not 0) means "no year filter" on the backend.
  const yearFilter = (year: number) => (year > 0 ? year : undefined);
  const [sortBy, setSortBy] = useState("relevance");
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<InspectorTab>("details");
  // Shared tabbed inspector pop-up (same tab bodies as the inline pane).
  const [popupOpen, setPopupOpen] = useState(false);
  const [webTab, setWebTab] = useState<"details" | "similar">("details");

  // Right-side Stats for Nerds pane (live while you search).
  const { on: nerdOn } = useNerdButtons();
  const [statsOpenRaw, setStatsOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("paperrec_repo_stats") === "1";
    } catch {
      return false;
    }
  });
  // The pane goes with its button when the nerd buttons are switched off.
  const statsOpen = statsOpenRaw && nerdOn;

  function toggleStats() {
    const next = !statsOpen;
    setStatsOpen(next);
    if (next) setInspectorCollapsed(false);

    try {
      window.localStorage.setItem(
        "paperrec_repo_stats",
        next ? "1" : "0"
      );
    } catch {
      // Best-effort.
    }
  }
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // ------------------------------------------------------------
  // Mendeley-style library views + sortable table
  // ------------------------------------------------------------
  const [systemView, setSystemView] = useState<
    "all" | "recent" | "favorites" | "unsorted"
  >("all");
  const [sortColumn, setSortColumn] = useState<
    "title" | "author" | "year" | "date"
  >("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);

  /* Collapsible sidebar sections (persisted per browser). */
  const [foldersOpen, setFoldersOpen] = useState<boolean>(() => {
    try {
      return (
        window.localStorage.getItem("paperrec_repo_folders_open") !== "0"
      );
    } catch {
      return true;
    }
  });

  const [authorsOpen, setAuthorsOpen] = useState<boolean>(() => {
    try {
      return (
        window.localStorage.getItem("paperrec_repo_authors_open") === "1"
      );
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "paperrec_repo_folders_open",
        foldersOpen ? "1" : "0"
      );
      window.localStorage.setItem(
        "paperrec_repo_authors_open",
        authorsOpen ? "1" : "0"
      );
    } catch {
      // best-effort
    }
  }, [foldersOpen, authorsOpen]);

  /* Collapsible inspector (the right details/stats pane). */
  const [inspectorCollapsed, setInspectorCollapsed] = useState<
    boolean
  >(() => {
    try {
      /* Closed by default: the list gets the room until a paper is picked.
         Only an explicit choice (the toggles) is remembered. */
      return window.localStorage.getItem("paperrec_repo_inspector") !== "0";
    } catch {
      return true;
    }
  });

  /* Narrow screens: the filters wait behind a button, so the list comes first. */
  const [filtersOpenNarrow, setFiltersOpenNarrow] = useState(false);

  /* How wide the list is decides how many columns it can afford. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWidth, setListWidth] = useState(1000);

  useEffect(() => {
    const el = listRef.current;

    if (!el) return;

    const measure = () => setListWidth(el.clientWidth);

    measure();

    const ro = new ResizeObserver(measure);

    ro.observe(el);

    return () => ro.disconnect();
  }, []);
  const compactList = listWidth < 720;

  function toggleInspector() {
    const next = !inspectorCollapsed;
    setInspectorCollapsed(next);

    try {
      window.localStorage.setItem(
        "paperrec_repo_inspector",
        next ? "1" : "0"
      );
    } catch {
      // Best-effort.
    }
  }

  /* Authors present in the current fetch, most frequent first. */
  const authorList = useMemo(() => {
    const counts = new Map<string, number>();

    for (const paper of papers) {
      const first = paper.author?.split(";")[0].trim();
      if (!first) continue;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [papers]);

  // Right-click literature menu for the current selection.
  const [literatureMenu, setLiteratureMenu] = useState<{
    x: number;
    y: number;
    papers: Paper[];
  } | null>(null);

  // Status line for context-menu actions + a reload trigger the
  // background jobs (metadata refresh, merge) can poke.
  const [actionMessage, setActionMessage] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Load the saved-library set once so Favorites/★ reflect reality.
  useEffect(() => {
    getLibrary()
      .then((entries) =>
        setSavedIds(new Set(entries.map((entry) => entry.paper.id))),
      )
      .catch(() => {});
  }, []);

  // Notes live in localStorage (no backend field yet).
  const [notes, setNotes] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("paperrec_notes") ?? "{}",
      );
    } catch {
      return {};
    }
  });

  function saveNotes(id: number, text: string) {
    setNotes((prev) => {
      const next = { ...prev, [id]: text };
      try {
        localStorage.setItem("paperrec_notes", JSON.stringify(next));
      } catch {
        // best-effort
      }
      return next;
    });
  }

  // ------------------------------------------------------------
  // Pipeline integration: pick an algorithm (shared with the nav
  // MODE chip and the Search tab) and rank the repository list by
  // similarity to the selected paper.
  // ------------------------------------------------------------
  const { pipelineId, setPipelineId, customWeights } =
    usePipelineMode();
  const { publish: publishStats } = useStatsDrawer();
  const activePipelineConfig =
    pipelineId === "custom"
      ? customPipelineConfig(customWeights)
      : pipelineConfigs.find((config) => config.id === pipelineId) ??
    pipelineConfigs[pipelineConfigs.length - 1];

  const similarityMode = sortBy === "similarity";

  const [similarity, setSimilarity] = useState<
    Map<number, { score: number; rank: number }> | null
  >(null);
  const [similarityLoading, setSimilarityLoading] = useState(false);

  useEffect(() => {
    if (!similarityMode || !selectedPaper) {
      setSimilarity(null);
      return;
    }

    let cancelled = false;
    setSimilarityLoading(true);

    getRecommendations({
      pipeline: pipelineId,
      seedPaperId: selectedPaper.id,
      // The API bounds recommendation requests at 100.
      topK: 100,
      // The custom pipeline needs the dial allocation; without it
      // the API rejects the request and the sort silently dies.
      ...(pipelineId === "custom"
        ? { weights: customWeights }
        : {}),
    })
      .then((results) => {
        if (cancelled) {
          return;
        }
        const map = new Map<number, { score: number; rank: number }>();
        results.forEach((result, index) => {
          map.set(result.paper.id, {
            score: result.score,
            rank: index + 1,
          });
        });
        setSimilarity(map);
      })
      .catch(() => {
        if (!cancelled) {
          setSimilarity(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSimilarityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [similarityMode, selectedPaper?.id, pipelineId, customWeights]);

  // ------------------------------------------------------------
  // Web search (OpenAlex + Crossref) — toggled next to the
  // repository scope. Peer-reviewed only by default.
  // ------------------------------------------------------------
  const [searchMode, setSearchMode] = useState<SearchMode>("repository");
  const [webResults, setWebResults] = useState<WebSearchResult[]>([]);
  const [selectedWeb, setSelectedWeb] = useState<WebSearchResult | null>(null);
  const [webLoading, setWebLoading] = useState(false);
  const [webSearched, setWebSearched] = useState(false);
  // A newer web search cancels the one still in flight, so repeated
  // clicks never leave a stale response to overwrite fresh results.
  const webAbortRef = useRef<AbortController | null>(null);
  const [peerReviewed, setPeerReviewed] = useState(true);
  const [openAccessOnly, setOpenAccessOnly] = useState(false);
  const [webSources, setWebSources] = useState("openalex,crossref,arxiv");
  // "algorithm" ranks the hits with the active recommendation pipeline;
  // the others keep the sources' own ordering.
  const [webSort, setWebSort] = useState<
    "algorithm" | "relevance" | "citations" | "year"
  >("algorithm");
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [webImportStatus, setWebImportStatus] = useState<
    Record<string, "saved" | "exists">
  >({});
  const [webRowErrors, setWebRowErrors] = useState<Record<string, string>>({});

  // Pagination (10 papers per page; resets whenever the filtered
  // result set changes).
  const PAPERS_PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [papers]);

  // System views filter the fetched set (backend filters apply first).
  const viewPapers = useMemo(() => {
    const scoped = authorFilter
      ? papers.filter(
          (paper) =>
            paper.author?.toLowerCase().includes(authorFilter.toLowerCase()) ??
            false,
        )
      : papers;

    if (systemView === "favorites") {
      return scoped.filter((p) => savedIds.has(p.id));
    }
    if (systemView === "unsorted") {
      return scoped.filter((p) => !p.subject_category);
    }
    if (systemView === "recent") {
      return [...scoped].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
    }
    return scoped;
  }, [papers, systemView, savedIds, authorFilter]);

  // Sortable columns (client-side; similarity ranking overrides).
  const sortedPapers = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...viewPapers];

    arr.sort((a, b) => {
      let result = 0;

      if (sortColumn === "title") {
        result = (a.title ?? "").localeCompare(b.title ?? "");
      } else if (sortColumn === "author") {
        result = (a.author ?? "").localeCompare(b.author ?? "");
      } else if (sortColumn === "year") {
        result = (a.publication_year ?? 0) - (b.publication_year ?? 0);
      } else {
        result = a.created_at.localeCompare(b.created_at);
      }

      return result * dir;
    });

    return arr;
  }, [viewPapers, sortColumn, sortDir]);

  function toggleSort(column: typeof sortColumn) {
    if (sortColumn === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDir("desc");
    }
  }

  // In similarity mode the filtered set is re-ranked by the
  // selected pipeline's score against the selected paper.
  const rankedPapers =
    similarityMode && similarity
      ? [...sortedPapers].sort(
          (a, b) =>
            (similarity.get(b.id)?.score ?? -Infinity) -
            (similarity.get(a.id)?.score ?? -Infinity),
        )
      : sortedPapers;

  const pageCount = Math.max(
    1,
    Math.ceil(rankedPapers.length / PAPERS_PAGE_SIZE),
  );
  const pageStart = (page - 1) * PAPERS_PAGE_SIZE;
  const pagedPapers = rankedPapers.slice(
    pageStart,
    pageStart + PAPERS_PAGE_SIZE,
  );

  const location = useLocation();
  const navigate = useNavigate();
  const navigationState = location.state as { selectSeed?: boolean; pipeline?: string; query?: string; mode?: string; seedPaperId?: number } | null;
  const isSelectingSeed = navigationState?.selectSeed === true;
  const seedPipeline = navigationState?.pipeline ?? "tfidf";

  // The home page's search box and cross-page "find similar" /
  // "use as seed" links land here: pre-fill the query (or the seed
  // paper) and jump straight into the Recommend scope.
  useEffect(() => {
    const incomingQuery = navigationState?.query;
    const incomingSeed = navigationState?.seedPaperId;

    if (navigationState?.mode === "seed" && incomingSeed !== undefined) {
      setSearchMode("recommend");
      void runRecommendSearch(undefined, incomingSeed);
    } else if (incomingQuery && incomingQuery.trim()) {
      setSearch(incomingQuery);
      setSearchMode("recommend");
      void runRecommendSearch(incomingQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Local fetch is suspended while the web scope is active so the
    // query typed for a web search doesn't re-hit the backend.
    if (searchMode === "web") return;

    // Ignore responses from superseded requests (one fires per keystroke),
    // so a slow earlier query cannot overwrite the newer results.
    let stale = false;
    setLoading(true);
    setError(null);
    listPapers({
      search: search || undefined,
      subject,
      category,
      document_type: documentType,
      min_year: yearFilter(minYear),
      max_year: yearFilter(maxYear),
      sort_by: sortBy,
    })
      .then((rows) => {
        if (!stale) setPapers(rows);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => {
      stale = true;
    };
  }, [searchMode, search, subject, category, documentType, minYear, maxYear, sortBy, reloadToken]);

  // Context-menu messages fade after a beat.
  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timer = window.setTimeout(
      () => setActionMessage(""),
      8000
    );

    return () => window.clearTimeout(timer);
  }, [actionMessage]);

  /* ------------------------------------------------------------
     Web search uses legitimate APIs only (OpenAlex, Crossref,
     arXiv), peer-reviewed types by default, server-side
     filtering.
     ------------------------------------------------------------ */

  /* ------------------------------------------------------------
     Recommendation search (the merged Search scope): ranks the
     repository's own papers with the active pipeline, top_k and
     the optional MMR diversification.
     ------------------------------------------------------------ */

  async function runRecommendSearch(queryOverride?: string, seedOverride?: number) {
    const query = (queryOverride ?? search).trim();

    if (!query && seedOverride === undefined) {
      setError("Enter a query to rank the corpus.");
      return;
    }

    // What an algorithm click re-runs, and which response is the newest.
    lastRecommendRef.current = { query, seed: seedOverride };
    const requestId = ++recommendRequestRef.current;

    setRecommendLoading(true);
    setRecommendError(null);

    // Opt-in web half, fetched in parallel. It never throws: a failure
    // resolves to null so the local results still land.
    const blendController = blendWeb ? new AbortController() : null;
    const webHalf: Promise<WebSearchResult[] | null> = blendController
      ? (async () => {
          try {
            let webQuery = query;
            if (!webQuery && seedOverride !== undefined) {
              const seedPaper =
                papers.find((p) => p.id === seedOverride) ??
                (selectedPaper?.id === seedOverride ? selectedPaper : null) ??
                (await getPaper(seedOverride));
              webQuery = seedWebQuery(seedPaper);
            }
            if (!webQuery) return null;
            return await getWebRecommendations({
              q: webQuery,
              pipeline: pipelineId,
              topK: Math.min(topK, 25),
              peer_reviewed: true,
              open_access: false,
              sources: webSources,
              ...(pipelineId === "custom" ? { weights: customWeights } : {}),
              signal: blendController.signal,
            });
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null);

    try {
      const results = await getRecommendations({
        pipeline: pipelineId,
        ...(query ? { query } : {}),
        ...(seedOverride !== undefined
          ? { seedPaperId: seedOverride }
          : {}),
        topK,
        // The custom pipeline needs the dial allocation.
        ...(pipelineId === "custom"
          ? { weights: customWeights }
          : {}),
        ...(diversify ? { mmrLambda: MMR_LAMBDA } : {}),
      });

      const webHits = blendController ? await webHalf : null;

      // A newer search (e.g. another algorithm clicked meanwhile) wins.
      if (requestId !== recommendRequestRef.current) return;

      if (blendController) {
        const rows = blendRecommendations({
          local: results,
          web: webHits ?? [],
          topK,
        });
        setBlendRows(rows);
        setBlendNotice(webHits === null ? "Web results unavailable" : null);
        setSelectedWeb(null);
        setRecommendResults(
          rows.flatMap((row) => (row.origin === "local" ? [row.result] : [])),
        );
      } else {
        setBlendRows(null);
        setBlendNotice(null);
        setRecommendResults(results);
      }
      setRecommendSearched(true);

      publishStats({
        pipelineId,
        mode: query ? "keyword" : "seed",
        query: query || undefined,
        seedPaperId: seedOverride,
        topK,
        ...(diversify ? { mmrLambda: MMR_LAMBDA } : {}),
      });
    } catch (e) {
      blendController?.abort();
      if (requestId !== recommendRequestRef.current) return;

      setRecommendError(
        e instanceof Error
          ? e.message
          : "Recommendation search failed."
      );
    } finally {
      if (requestId === recommendRequestRef.current) {
        setRecommendLoading(false);
      }
    }
  }

  // Pressing another algorithm (or moving the dials, Top K or Diversify)
  // re-ranks the query already on screen with that algorithm.
  useEffect(() => {
    if (searchMode !== "recommend" || !recommendSearched) return;

    const last = lastRecommendRef.current;

    if (!last) return;

    const timer = window.setTimeout(
      () => void runRecommendSearch(last.query, last.seed),
      250,
    );

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, customWeights, topK, diversify, blendWeb, blendWeb ? webSources : null]);

  // A web row picked in Web mode must not linger in the Recommend inspector.
  useEffect(() => {
    if (searchMode === "recommend") setSelectedWeb(null);
  }, [searchMode]);

  // The same for web results: a new algorithm re-ranks the live hits.
  useEffect(() => {
    if (
      searchMode !== "web" ||
      !webSearched ||
      webSort !== "algorithm" ||
      !search.trim()
    ) {
      return;
    }

    const timer = window.setTimeout(() => void runWebSearch(), 250);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, customWeights]);

  async function runWebSearch() {
    const query = search.trim();

    if (!query) {
      setError("Enter search terms to search the web.");
      return;
    }

    setWebLoading(true);
    setError(null);

    webAbortRef.current?.abort();
    const controller = new AbortController();
    webAbortRef.current = controller;

    try {
      const results =
        webSort === "algorithm"
          ? await getWebRecommendations({
              q: query,
              pipeline: pipelineId,
              topK: 20,
              year_min: yearFilter(minYear),
              year_max: yearFilter(maxYear),
              peer_reviewed: peerReviewed,
              open_access: openAccessOnly,
              sources: webSources,
              ...(pipelineId === "custom" ? { weights: customWeights } : {}),
              signal: controller.signal,
            })
          : await searchWeb({
              q: query,
              year_min: yearFilter(minYear),
              year_max: yearFilter(maxYear),
              peer_reviewed: peerReviewed,
              open_access: openAccessOnly,
              sources: webSources,
              sort: webSort,
              limit: 20,
              signal: controller.signal,
            });

      if (controller.signal.aborted) return;

      setWebResults(results);
      setSelectedWeb(null);
      setWebSearched(true);
      setWebImportStatus({});
      setWebRowErrors({});
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;

      setError(
        e instanceof Error ? e.message : "The web search failed.",
      );
    } finally {
      if (!controller.signal.aborted) setWebLoading(false);
    }
  }

  async function importWebResult(result: WebSearchResult) {
    const key = webKey(result);

    if (importingKey || webImportStatus[key]) return;

    setImportingKey(key);
    setWebRowErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });

    try {
      await importPaperFromMetadata({
        title: result.title,
        author: result.author,
        abstract: result.abstract,
        publication_year: result.publication_year,
        doi: result.doi,
        // Subject/category stays unset: it is a curator's judgment
        // call (same as the validation module's contract).
        document_type: result.document_type ?? "Journal Article",
        citation_count: result.citations,
        pdf_url: result.pdf_url ?? undefined,
        source_filename: `web:${result.source}`,
      });

      notifyRecommendationIndexStale();
      setWebImportStatus((previous) => ({ ...previous, [key]: "saved" }));
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Couldn't import this paper.";

      if (message.toLowerCase().includes("duplicate")) {
        setWebImportStatus((previous) => ({ ...previous, [key]: "exists" }));
      } else {
        setWebRowErrors((previous) => ({ ...previous, [key]: message }));
      }
    } finally {
      setImportingKey(null);
    }
  }

  async function handleSave(paperId: number) {
    try {
      await saveToLibrary(paperId);
      setSavedIds((prev) => new Set(prev).add(paperId));
    } catch (e) {
      setError(e instanceof Error ? `Couldn't save paper: ${e.message}` : "Couldn't save paper.");
    }
  }

  async function handleUnsave(paperId: number) {
    try {
      await removeFromLibrary(paperId);
      setSavedIds((prev) => {
        const next = new Set(prev);
        next.delete(paperId);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? `Couldn't remove paper: ${e.message}` : "Couldn't remove paper.");
    }
  }

  function toggleSaved(paperId: number) {
    if (savedIds.has(paperId)) {
      void handleUnsave(paperId);
    } else {
      void handleSave(paperId);
    }
  }

  // Touch long-press behaves like a right-click on a row.
  const longPress = useLongPressFeed(openMenuAt);

  function openMenuAt(paperId: number, x: number, y: number) {
    const paper = rankedPapers.find((row) => row.id === paperId);

    if (!paper) {
      return;
    }

    const isSelected = selectedIds.has(paperId);
    const papersForMenu = isSelected
      ? rankedPapers.filter((row) => selectedIds.has(row.id))
      : [paper];

    if (!isSelected) {
      setSelectedIds(new Set([paperId]));
    }

    setLiteratureMenu({ x, y, papers: papersForMenu });
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleBatchSave() {
    for (const id of selectedIds) {
      if (!savedIds.has(id)) {
        await handleSave(id);
      }
    }
    clearSelection();
  }

  async function handleBatchDelete() {
    const targets = rankedPapers.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) {
      return;
    }

    askConfirm(
      "Delete papers",
      `Delete ${targets.length} paper${targets.length === 1 ? "" : "s"} permanently? This removes records, library entries, and stored files.`,
      async () => {
        for (const paper of targets) {
          await handleDelete(paper.id, paper.title);
        }
        clearSelection();
      },
    );
  }

  /* Sync = refresh metadata from Crossref (authors as given / middle /
     family, missing year / abstract), then rebuild the index. It runs on
     the server in the background; this follows it and reports. */
  function syncLine(job: SyncJob): string {
    if (job.phase === "indexing") return "Sync: rebuilding the recommendation index…";
    const total = job.total ?? 0;
    return total > 0
      ? `Sync: refreshing metadata ${job.done ?? 0}/${total} · ${job.changed ?? 0} updated`
      : "Sync: looking for papers to refresh…";
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      let job: SyncJob;

      try {
        job = await startSync();
      } catch (e) {
        // Already running (e.g. started before a page reload): follow it.
        if (!(e instanceof Error && /already running/i.test(e.message))) throw e;
        job = await getSyncStatus();
      }

      while (job.state === "running") {
        setActionMessage(syncLine(job));
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        job = await getSyncStatus();
      }

      if (job.state === "error") {
        throw new Error(job.error ?? "the sync stopped unexpectedly");
      }

      notifyRecommendationIndexStale();
      const filters = {
        search: search || undefined,
        subject,
        category,
        document_type: documentType,
        min_year: yearFilter(minYear),
        max_year: yearFilter(maxYear),
        sort_by: sortBy,
      };
      const fresh = await listPapers(filters);
      setPapers(fresh);

      const done = job.summary;
      const parts = Object.entries(done?.fields ?? {}).map(
        ([field, count]) => `${count} ${field.replace("_", " ")}`,
      );
      setActionMessage(
        done && done.changed > 0
          ? `Sync complete: ${done.changed} papers updated (${parts.join(", ")}).`
          : "Sync complete: metadata was already up to date.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? `Sync failed: ${e.message}` : "Sync failed.",
      );
    } finally {
      setSyncing(false);
    }
  }

  function handleSelectSeed(paperId: number) {
    navigate("/repository", { state: { mode: "seed", seedPaperId: paperId, pipeline: seedPipeline } });
  }

  /* Inline table edits (autosaved) refresh every view of the row. */
  function handlePaperUpdated(updated: Paper) {
    setPapers((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
    setRecommendResults((prev) =>
      prev.map((result) =>
        result.paper.id === updated.id
          ? { ...result, paper: updated }
          : result,
      ),
    );
    setSelectedPaper((current) =>
      current?.id === updated.id ? updated : current,
    );
  }

  async function handleDelete(paperId: number, title: string) {
    askConfirm(
      "Delete paper",
      `Delete "${title}" permanently? This removes the repository record, library entry, and stored file.`,
      async () => {
        try {
          setError(null);
          await deletePaper(paperId);
          // The pet burns the paper it just erased.
          triggerSlimeAnimation("burn");
          setPapers((prev) =>
            prev.filter((paper) => paper.id !== paperId),
          );
          if (selectedPaper?.id === paperId) {
            setSelectedPaper(null);
          }
        } catch (e) {
          setError(
            e instanceof Error
              ? `Couldn't delete "${title}": ${e.message}`
              : `Couldn't delete "${title}".`,
          );
        }
      },
    );
  }

  function selectPaper(paper: Paper) {
    /* picking a paper opens the inspector (without changing the saved choice) */
    setInspectorCollapsed(false);
    setSelectedPaper(paper);
    setViewerOpen(false);
    setDetailTab("details");
  }

  /** Open the viewer pop-up frame for the given PDF URL (or the stored PDF). */
  function openPdfPreview(url: string | null) {
    setPreviewUrl(url);
    setViewerOpen(true);
  }

  function hasPdf(paper: Paper | null): boolean {
    return paper?.stored_path?.toLowerCase().endsWith(".pdf") ?? false;
  }

  async function handleDeletePdf(paper: Paper) {
    askConfirm(
      "Delete PDF",
      `Delete the stored PDF of "${paper.title}"? The bibliographic record stays intact.`,
      async () => {
        try {
          const updated = await deletePaperPdf(paper.id);
          setPapers((prev) =>
            prev.map((p) => (p.id === updated.id ? updated : p)),
          );
          setSelectedPaper(updated);
        } catch (e) {
          setError(
            e instanceof Error
              ? `Couldn't delete the PDF: ${e.message}`
              : "Couldn't delete the PDF.",
          );
        }
      },
    );
  }

  const selected = selectedPaper;
  const webInspectorActive =
    searchMode === "web" ||
    (searchMode === "recommend" && selectedWeb !== null);
  const selectedSaved = selected ? savedIds.has(selected.id) : false;

  /** Web-result inspector tabs: Details (the record + Import) and
   *  Similar (library neighbours + OpenAlex related works). */
  function renderWebInspectorTab(tab: "details" | "similar") {
    const result = selectedWeb;
    if (!result) return null;
    if (tab === "similar") {
      return (
        <WebSimilarPanel
          result={result}
          pipeline={pipelineId}
          pipelineLabel={pipelineName(activePipelineConfig)}
          weights={pipelineId === "custom" ? customWeights : undefined}
          topK={topK}
          onSelectPaper={(paper) => {
            /* Web mode has no local selection pane: hop to the
               repository scope (web results stay loaded). */
            if (searchMode === "web") setSearchMode("repository");
            else setSelectedWeb(null);
            setPopupOpen(false);
            selectPaper(paper);
          }}
        />
      );
    }
    return (
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-mono text-xs font-bold uppercase tracking-[0.1em] text-ink">
                    {result.source}
                  </span>
                  <span className="text-muted">{result.publication_year ?? "—"}</span>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{result.document_type ?? "Work"}</span>
                  {result.is_oa === true && (
                    <span className="rounded border-[2px] border-gray-900 bg-accent px-1.5 py-0.5 text-xs font-bold uppercase tracking-[0.1em] text-onAccent">
                      Open access
                    </span>
                  )}
                </div>

                <h2 className="text-base font-bold leading-6 text-ink">
                  {result.title}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  {result.author ?? "Unknown author"}
                  {result.venue ? ` · ${result.venue}` : ""}
                  {result.citations != null && result.citations > 0
                    ? ` · cited ${result.citations}`
                    : ""}
                </p>

                {result.abstract && (
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-muted">
                    {result.abstract}
                  </p>
                )}

                {result.doi && (
                  <p className="mt-3 break-all text-xs text-muted">
                    <span className="font-bold text-ink">DOI:</span>{" "}
                    {result.doi}
                  </p>
                )}

                {result.landing_url && (
                  <a
                    href={result.landing_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 block break-all text-xs font-bold text-ink underline hover:decoration-2"
                  >
                    Open landing page ↗
                  </a>
                )}

                {/* Actions */}
                <div className="mt-5 flex flex-wrap gap-2 border-t-[3px] border-gray-900 pt-4">
                  {(() => {
                    const key = webKey(result);
                    const status = webImportStatus[key];

                    if (status === "saved") {
                      return (
                        <span className="inline-flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accent px-3 py-2 text-sm font-bold text-onAccent">
                          <Check className="h-3.5 w-3.5" />
                          Saved to repository
                        </span>
                      );
                    }

                    if (status === "exists") {
                      return (
                        <span className="inline-flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-white px-3 py-2 text-sm font-bold text-ink">
                          <Check className="h-3.5 w-3.5" />
                          Already in repository
                        </span>
                      );
                    }

                    return (
                      <Button
                        variant="primary"
                        type="button"
                        onClick={() => void importWebResult(result)}
                        disabled={importingKey !== null}
                      >
                        {importingKey === key
                          ? "Importing…"
                          : "Import into repository"}
                      </Button>
                    );
                  })()}

                  {webRowErrors[webKey(result)] && (
                    <span className="text-xs font-bold text-ink">
                      {webRowErrors[webKey(result)]}
                    </span>
                  )}
                </div>
              </div>
    );
  }

  /** One implementation of each inspector tab body, rendered inline
   *  (compact) in the right pane and full-size in the pop-up. */
  function renderInspectorTab(tab: InspectorTab, inPopup: boolean) {
    if (!selected) return null;
    const customW = pipelineId === "custom" ? customWeights : undefined;
    if (tab === "similar") {
      return inPopup ? (
        <ConnectionsWorkbench
          paperId={selected.id}
          pipeline={pipelineId}
          pipelineLabel={pipelineName(activePipelineConfig)}
          weights={customW}
          controls={proUnlocked}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConnectionsPane
            paperId={selected.id}
            pipeline={pipelineId}
            pipelineLabel={pipelineName(activePipelineConfig)}
            weights={customW}
            controls={proUnlocked}
            onExpand={() => {
              setDetailTab("similar");
              setPopupOpen(true);
            }}
          />
        </div>
      );
    }
    if (tab === "notes") {
      return (
        <PaperNotesBody
          paperId={selected.id}
          value={notes[selected.id] ?? ""}
          onChange={saveNotes}
        />
      );
    }
    if (tab === "pdf") {
      return (
        <PaperPdfBody
          paper={selected}
          onPreview={openPdfPreview}
          onDeletePdf={() => handleDeletePdf(selected)}
          onAttached={(updated) => {
            setPapers((prev) =>
              prev.map((p) => (p.id === updated.id ? updated : p)),
            );
            setSelectedPaper(updated);
          }}
        />
      );
    }
    return (
      <PaperDetailsBody
        paper={selected}
        isSelectingSeed={isSelectingSeed}
        saved={selectedSaved}
        onUseSeed={() => handleSelectSeed(selected.id)}
        onSave={() => handleSave(selected.id)}
        onView={() => openPdfPreview(null)}
        onDelete={() => handleDelete(selected.id, selected.title)}
      />
    );
  }

  return (
    <div className="cat-repo mx-auto w-full max-w-[1560px]">
      <HuntItem item={HUNT_ITEMS.find((item) => item.id === "hunt-orb")!} />
      <PageHeader
        eyebrow="Repository"
        title="Repository"
        icon={<Database className="h-4 w-4" />}
        description={
          loading
            ? "Loading papers…"
            : searchMode === "web"
              ? `Web search · legitimate sources (OpenAlex, Crossref, arXiv, DOAJ) · ${
                  webSearched
                    ? `${webResults.length} result${webResults.length === 1 ? "" : "s"}`
                    : "peer-reviewed by default"
                }`
              : searchMode === "recommend"
                ? `Ranked recommendations · ${pipelineName(activePipelineConfig)}.`
                : `${papers.length} papers. Pick one to open its record.`
        }
        action={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!presenting && (<>
            {nerdOn && (
            <button
              type="button"
              data-nerd=""
              aria-pressed={statsOpen}
              onClick={toggleStats}
              title="Toggle the live Stats for Nerds pane on the right"
              aria-label="Stats for Nerds"
              className={`nerd-glitch-in inline-flex h-9 items-center justify-center rounded border-[3px] border-gray-900 px-3 text-sm font-semibold transition-colors ${
                statsOpen
                  ? "bg-accent text-onAccent"
                  : "bg-white text-ink hover:bg-accentSoft"
              }`}
            >
              <ResponsiveLabel icon={Sigma}>Stats for Nerds</ResponsiveLabel>
            </button>
            )}
            <LayoutOptions />
            </>)}
            <Button type="button" onClick={() => navigate("/upload")}>
              Upload paper
            </Button>
          </div>
        }
      />

      {isSelectingSeed && (
        <div className="status-warning mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>Select a paper to use as the seed document.</span>
          <button type="button" onClick={() => navigate("/repository", { replace: true })} className="text-sm font-bold text-ink underline">
            Cancel
          </button>
        </div>
      )}

      {/* Algorithm console — the always-visible pipeline controls */}
      <div className="mt-4">
        <AlgorithmConsole
          recommendMode={searchMode === "recommend"}
          webMode={searchMode === "web"}
          topK={topK}
          onTopKChange={setTopK}
          diversify={diversify}
          onDiversifyChange={setDiversify}
        />
      </div>

      <div
        className="mt-4 flex min-h-0 flex-col gap-3 lg:h-[calc(100dvh-20rem)] lg:flex-row lg:min-h-[480px]"
        style={
          {
            "--pane-left": `${leftPaneW}px`,
            "--pane-right": `${rightPaneW}px`,
          } as React.CSSProperties
        }
      >

        {/* ====================================================
            LEFT PANE — filters
            ==================================================== */}

        {prefs.sidebar && (
        <aside
          className={`cat-panel shrink-0 overflow-y-auto rounded border-[3px] border-gray-900 bg-white lg:block lg:w-[var(--pane-left)] ${
            filtersOpenNarrow ? "" : "hidden"
          }`}
          data-tips="repo-filters"
        >
          <div className="cat-head flex items-center gap-1.5 border-b-[3px] border-gray-900 bg-canvas px-3 py-2">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted" />
            <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
              Filter console
            </p>
          </div>

          <div className="p-4">

          <div className="space-y-3">
{/* Search scope: repository browse, ranked recommendations,
                or the open web */}
            <div>
              <span className="filter-label">Search in</span>
              <div className="flex gap-1 rounded border-[3px] border-gray-900 bg-canvas p-1">
                <button
                  type="button"
                  onClick={() => setSearchMode("repository")}
                  aria-pressed={searchMode === "repository"}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded border-[2px] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                    searchMode === "repository"
                      ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-3px_0_rgba(0,0,0,0.3)]"
                      : "border-transparent text-muted hover:text-accent"
                  }`}
                >
                  <Database className="h-3.5 w-3.5" />
                  Library
                </button>
                <button
                  type="button"
                  onClick={() => setSearchMode("recommend")}
                  aria-pressed={searchMode === "recommend"}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded border-[2px] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                    searchMode === "recommend"
                      ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-3px_0_rgba(0,0,0,0.3)]"
                      : "border-transparent text-muted hover:text-accent"
                  }`}
                >
                  <SearchIcon className="h-3.5 w-3.5" />
                  Recommend
                </button>
                <button
                  type="button"
                  onClick={() => setSearchMode("web")}
                  aria-pressed={searchMode === "web"}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded border-[2px] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                    searchMode === "web"
                      ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-3px_0_rgba(0,0,0,0.3)]"
                      : "border-transparent text-muted hover:text-accent"
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />
                  Web
                </button>
              </div>
            </div>

            <div>
              <label className="filter-label" htmlFor="repo-search">
                {searchMode === "web"
                  ? "Topic, method, or title"
                  : searchMode === "recommend"
                    ? "Query the corpus"
                    : "Search"}
              </label>
              <TextInput
                id="repo-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (searchMode === "web") {
                      void runWebSearch();
                    } else if (searchMode === "recommend") {
                      void runRecommendSearch();
                    }
                  }
                }}
                placeholder={
                  searchMode === "recommend"
                    ? "e.g. transfer learning for recommender systems"
                    : searchMode === "web"
                      ? "e.g. gamified learning analytics"
                      : "Filter by title, author, or keyword…"
                }
              />

              {searchMode === "recommend" && (
                <div className="mt-2">
                  <Button
                    type="button"
                    onClick={() => void runRecommendSearch()}
                    disabled={!search.trim() || recommendLoading}
                    fullWidth
                  >
                    {recommendLoading
                      ? "Ranking…"
                      : "Rank corpus"}
                  </Button>
                  <p className="mt-1.5 text-xs leading-5 text-muted">
                    Top-K and Diversify live in the Algorithm bar above.
                  </p>
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={blendWeb}
                      onChange={(e) => setBlendWeb(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>
                      Blend in web results
                      <span className="block text-xs leading-4 text-muted">
                        Also fetches live hits for the same query and ranks
                        them with the corpus in one list. Off by default.
                      </span>
                    </span>
                  </label>
                  {blendWeb && (
                    <div className="mt-2">
                      <label className="filter-label" htmlFor="blend-sources">
                        Web sources
                      </label>
                      <select
                        id="blend-sources"
                        value={webSources}
                        onChange={(e) => setWebSources(e.target.value)}
                        className="min-h-10 w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink"
                      >
                        <option value="openalex,crossref,arxiv">All (OpenAlex + Crossref + arXiv)</option>
                        <option value="openalex,crossref">OpenAlex + Crossref</option>
                        <option value="openalex,arxiv">OpenAlex + arXiv</option>
                        <option value="crossref,arxiv">Crossref + arXiv</option>
                        <option value="openalex">OpenAlex only</option>
                        <option value="crossref">Crossref only</option>
                        <option value="arxiv">arXiv only</option>
                        <option value="openalex,crossref,doaj">OpenAlex + Crossref + DOAJ</option>
                        <option value="openalex,crossref,arxiv,doaj">All four (+ arXiv, DOAJ)</option>
                        <option value="doaj">DOAJ only</option>
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>

            {searchMode === "web" && (
              <>
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  onClick={() => void runWebSearch()}
                  disabled={webLoading || !search.trim()}
                >
                  {webLoading ? "Searching…" : "Search web"}
                </Button>

                <div className="space-y-2.5 border-t-[2px] border-gray-200 pt-3">
                  <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={peerReviewed}
                      onChange={(e) => setPeerReviewed(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>
                      Peer-reviewed only
                      <span className="block text-xs leading-4 text-muted">
                        Journals, conferences, book chapters, no
                        preprints, datasets, or retracted work. Selecting arXiv as a source
                        includes preprints by design; DOAJ adds open-access journal articles.
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={openAccessOnly}
                      onChange={(e) => setOpenAccessOnly(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>
                      Open access only
                      <span className="block text-xs leading-4 text-muted">
                        Free full text available
                        {openAccessOnly ? " · searches OpenAlex" : ""}.
                      </span>
                    </span>
                  </label>

                  <div>
                    <label className="filter-label" htmlFor="web-sources">
                      Sources
                    </label>
                    <select
                      id="web-sources"
                      value={webSources}
                      onChange={(e) => setWebSources(e.target.value)}
                      className="min-h-10 w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink"
                    >
                      <option value="openalex,crossref,arxiv">
                        All (OpenAlex + Crossref + arXiv)
                      </option>
                      <option value="openalex,crossref">
                        OpenAlex + Crossref
                      </option>
                      <option value="openalex,arxiv">
                        OpenAlex + arXiv
                      </option>
                      <option value="crossref,arxiv">
                        Crossref + arXiv
                      </option>
                      <option value="openalex">OpenAlex only</option>
                      <option value="crossref">Crossref only</option>
                      <option value="arxiv">arXiv only</option>
                      <option value="openalex,crossref,doaj">
                        OpenAlex + Crossref + DOAJ
                      </option>
                      <option value="openalex,crossref,arxiv,doaj">
                        All four (+ arXiv, DOAJ)
                      </option>
                      <option value="doaj">DOAJ only</option>
                    </select>
                  </div>

                  <div>
                    <label className="filter-label" htmlFor="web-sort">
                      Sort
                    </label>
                    <select
                      id="web-sort"
                      value={webSort}
                      onChange={(e) =>
                        setWebSort(
                          e.target.value as
                            | "algorithm"
                            | "relevance"
                            | "citations"
                            | "year",
                        )
                      }
                      className="min-h-10 w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink"
                    >
                      <option value="algorithm">
                        Algorithm · {pipelineName(activePipelineConfig)}
                      </option>
                      <option value="relevance">Source relevance</option>
                      <option value="citations">Most cited</option>
                      <option value="year">Newest</option>
                    </select>
                  </div>
                </div>
              </>
            )}

{searchMode === "repository" && (
              <>
                {/* My Library system views — collapsible */}
                <div className="border-b-[2px] border-gray-200 pb-3">
                  <button
                    type="button"
                    onClick={() => setFoldersOpen((value) => !value)}
                    aria-expanded={foldersOpen}
                    className="mb-2 flex w-full items-center justify-between gap-2 font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted hover:text-ink"
                  >
                    My Library
                    <span className="text-ink">{foldersOpen ? "▾" : "▸"}</span>
                  </button>

                  {foldersOpen && (
                    <div className="space-y-1">
                      {(
                        [
                          ["all", "All Documents"],
                          ["recent", "Recently Added"],
                          ["favorites", "Favorites"],
                          ["unsorted", "Unsorted"],
                        ] as const
                      ).map(([id, label]) => {
                        const count =
                          id === "favorites"
                            ? papers.filter((p) => savedIds.has(p.id))
                                .length
                            : id === "unsorted"
                              ? papers.filter((p) => !p.subject_category)
                                  .length
                              : papers.length;

                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setSystemView(id)}
                            aria-pressed={systemView === id}
                            className={`flex w-full items-center justify-between gap-2 rounded border-[2px] border-gray-900 px-2.5 py-1.5 text-left text-sm font-semibold transition-colors pixel-ease ${
                              systemView === id
                                ? "bg-accent text-onAccent"
                                : "bg-surface text-ink hover:bg-accentSoft"
                            }`}
                          >
                            <span>{label}</span>
                            <span
                              className={`font-mono text-xs font-bold ${
                                systemView === id
                                  ? "text-onAccent/80"
                                  : "text-muted"
                              }`}
                            >
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Filter by authors — collapsible, scrollable, at least
                    five researchers visible */}
                {authorList.length > 0 && (
                  <div className="border-b-[2px] border-gray-200 pb-3">
                    <button
                      type="button"
                      onClick={() => setAuthorsOpen((value) => !value)}
                      aria-expanded={authorsOpen}
                      className="mb-2 flex w-full items-center justify-between gap-2 font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted hover:text-ink"
                    >
                      Filter by authors
                      <span className="text-ink">
                        {authorsOpen ? "▾" : "▸"}
                      </span>
                    </button>

                    {authorsOpen && (
                      <div className="min-h-[11.25rem] max-h-52 space-y-1 overflow-y-auto pr-1">
                        <button
                          type="button"
                          onClick={() => setAuthorFilter(null)}
                          aria-pressed={authorFilter === null}
                          className={`flex w-full items-center justify-between gap-2 rounded border-[2px] border-gray-900 px-2.5 py-1.5 text-left text-sm font-semibold transition-colors pixel-ease ${
                            authorFilter === null
                              ? "bg-accent text-onAccent"
                              : "bg-surface text-ink hover:bg-accentSoft"
                          }`}
                        >
                          <span>All authors</span>
                          <span
                            className={`font-mono text-xs font-bold ${
                              authorFilter === null
                                ? "text-onAccent/80"
                                : "text-muted"
                            }`}
                          >
                            {papers.length}
                          </span>
                        </button>

                        {authorList.slice(0, 20).map(({ name, count }) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setAuthorFilter(name)}
                            aria-pressed={authorFilter === name}
                            className={`flex w-full items-center justify-between gap-2 rounded border-[2px] border-gray-900 px-2.5 py-1 text-left text-xs font-semibold transition-colors pixel-ease ${
                              authorFilter === name
                                ? "bg-accent text-onAccent"
                                : "bg-surface text-ink hover:bg-accentSoft"
                            }`}
                          >
                            <span className="truncate">{name}</span>
                            <span
                              className={`shrink-0 font-mono text-xs font-bold ${
                                authorFilter === name
                                  ? "text-onAccent/80"
                                  : "text-muted"
                              }`}
                            >
                              {count}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              <FilterSelect label="Subject" value={subject} options={subjects} onChange={setSubject} />
              <FilterSelect label="Category" value={category} options={categories} onChange={setCategory} />
              <FilterSelect label="Document type" value={documentType} options={documentTypes} onChange={setDocumentType} />
              </>
            )}

            <div>
              <span className="filter-label">Year range</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={minYear === 0 ? "" : minYear}
                  onChange={(e) => handleMinYearChange(e.target.value)}
                  aria-label="Minimum publication year"
                  placeholder="From"
                  className="min-h-10 w-24 rounded border-[3px] border-gray-900 bg-field px-2 py-2 text-center text-sm font-medium text-ink placeholder:text-muted focus:outline-none"
                />
                <span className="text-muted">–</span>
                <input
                  type="number"
                  value={maxYear === 0 ? "" : maxYear}
                  onChange={(e) => handleMaxYearChange(e.target.value)}
                  aria-label="Maximum publication year"
                  placeholder="To"
                  className="min-h-10 w-24 rounded border-[3px] border-gray-900 bg-field px-2 py-2 text-center text-sm font-medium text-ink placeholder:text-muted focus:outline-none"
                />
              </div>
            </div>

            {searchMode === "repository" && (
              <div>
                <label className="filter-label" htmlFor="repo-sort">Sort</label>
                <select
                  id="repo-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="min-h-10 w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink"
                >
                  <option value="date_added">Date added</option>
                  <option value="title">Title</option>
                  <option value="publication_year">Publication year</option>
                  <option value="relevance">Relevance</option>
                  <option value="similarity">
                    Similarity ({pipelineName(activePipelineConfig)})
                  </option>
                </select>

{similarityMode && (
              <p className="mt-1.5 text-xs leading-5 text-muted">
                {!selectedPaper
                  ? "Select a paper in the list to rank by similarity."
                  : `Ranked by ${pipelineName(activePipelineConfig)} against the selected paper.`}
              </p>
            )}
          </div>
        )}
          </div>

          <p className="mt-4 border-t-[2px] border-gray-200 pt-3 text-xs text-muted">
            {searchMode === "web"
              ? "Web searches run when you press Search web."
              : "Filters apply as you change them."}
          </p>
          </div>
        </aside>
        )}

        {prefs.sidebar && (
        <PaneHandle
          label="Resize filters panel"
          onResize={resizeLeft}
        />
        )}

        {/* ====================================================
            MIDDLE PANE — paper list
            ==================================================== */}

        <section
          className="cat-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border-[3px] border-gray-900 bg-white"
          aria-label="Paper results"
          data-tips="repo-results"
        >
          {/* One header: what this is, how many, and the actions. */}
          <div className="cat-head flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b-[3px] border-gray-900 bg-canvas px-4 py-2.5">
            <span className="flex min-w-0 items-center gap-1.5">
              {searchMode === "web" ? (
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted" />
              ) : searchMode === "recommend" ? (
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
              ) : (
                <Table className="h-3.5 w-3.5 shrink-0 text-muted" />
              )}
              <p className="cat-plate font-mono text-xs font-bold uppercase tracking-[0.15em] text-ink">
                {searchMode === "web"
                  ? "Web results"
                  : searchMode === "recommend"
                    ? "Ranked results"
                    : "Papers"}
              </p>
              <p className="truncate font-mono text-xs text-muted">
                ·{" "}
                {searchMode === "web"
                  ? webLoading
                    ? "…"
                    : `${webResults.length} result${webResults.length === 1 ? "" : "s"}${
                        webSort === "algorithm" && webSearched
                          ? ` ranked via ${pipelineName(activePipelineConfig)}`
                          : ""
                      }`
                  : searchMode === "recommend"
                    ? recommendLoading
                      ? "ranking…"
                      : recommendSearched
                        ? `${blendRows ? blendRows.length : recommendResults.length} ranked via ${pipelineName(activePipelineConfig)}`
                        : ""
                    : similarityMode
                      ? similarityLoading
                        ? `ranking via ${pipelineName(activePipelineConfig)}…`
                        : `${rankedPapers.length} ranked via ${pipelineName(activePipelineConfig)}`
                      : loading
                        ? "…"
                        : `${rankedPapers.length} result${rankedPapers.length === 1 ? "" : "s"}`}
              </p>
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {prefs.sidebar && (
                <button
                  type="button"
                  aria-expanded={filtersOpenNarrow}
                  onClick={() => setFiltersOpenNarrow((open) => !open)}
                  className="rounded border-[2px] border-gray-900 bg-surface px-2.5 py-1 text-sm font-semibold text-ink transition-colors pixel-ease hover:bg-accentSoft lg:hidden"
                >
                  Filters {filtersOpenNarrow ? "▴" : "▾"}
                </button>
              )}
              {searchMode === "repository" && (
                <>
                  <button
                    type="button"
                    onClick={() => navigate("/upload")}
                    className="rounded border-[2px] border-gray-900 bg-surface px-2.5 py-1 text-sm font-semibold text-ink hover:bg-accentSoft transition-colors pixel-ease"
                  >
                    + Add
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSync()}
                    disabled={syncing}
                    className="rounded border-[2px] border-gray-900 bg-surface px-2.5 py-1 text-sm font-semibold text-ink hover:bg-accentSoft transition-colors pixel-ease disabled:opacity-50"
                  >
                    {syncing ? "Syncing…" : "⟳ Sync"}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/faq")}
                    className="rounded border-[2px] border-gray-900 bg-white px-2.5 py-1 text-sm font-semibold text-ink hover:bg-accentSoft transition-colors pixel-ease"
                  >
                    ? Help
                  </button>
                </>
              )}
            </div>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            {error && <div className="status-error m-4">{error}</div>}

            {searchMode === "web" ? (
              /* --------------------------------------------------
                  WEB RESULTS — legitimate sources, with provenance
                  and a per-row import into the repository.
                  -------------------------------------------------- */
              webLoading ? (
                <div className="p-8 text-center">
                  <p className="animate-blink text-sm font-bold text-muted">
                    {webSort === "algorithm"
                      ? `Searching the web and ranking with ${pipelineName(activePipelineConfig)}…`
                      : "Searching OpenAlex & Crossref…"}
                  </p>
                </div>
              ) : !webSearched ? (
                <div className="p-6">
                  <EmptyState
                    title="Search the open scholarly web."
                    description="Peer-reviewed journal articles, conference papers, and book chapters from OpenAlex and Crossref. Import any hit straight into your repository."
                  />
                </div>
              ) : webResults.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="No results."
                    description="Try broader terms, widen the year range, or turn off a filter."
                  />
                </div>
              ) : (
                webResults.map((result, index) => {
                  const key = webKey(result);
                  const status = webImportStatus[key];
                  const active = selectedWeb !== null && webKey(selectedWeb) === key;

                  return (
                    <StaggerIn key={key} index={index} className="border-b border-gray-200 last:border-b-0">
                      <article
                        className={`paper-row cursor-pointer p-4 transition-colors pixel-ease ${
                          active ? "bg-accentSoft" : "hover:bg-canvas"
                        }`}
                        onClick={() => {
                          setInspectorCollapsed(false);
                          setSelectedWeb(result);
                        }}
                      >
                        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-mono text-xs font-bold uppercase tracking-[0.1em] text-ink">
                            {result.source}
                          </span>
                          {result.score != null && (
                            <span
                              className="rounded border-[2px] border-gray-900 bg-accent px-1.5 py-0.5 font-mono text-xs font-bold text-onAccent"
                              title={
                                result.components
                                  ? `TF-IDF ${result.components.tfidf.toFixed(2)} · S-BERT ${result.components.sbert.toFixed(2)} · Metadata ${result.components.metadata.toFixed(2)}`
                                  : undefined
                              }
                            >
                              #{result.rank} · {result.score.toFixed(3)}
                            </span>
                          )}
                          <span className="text-muted">{result.publication_year ?? "—"}</span>
                          <span className="text-muted">·</span>
                          <span className="text-muted">{result.document_type ?? "Work"}</span>
                          {result.is_oa === true && (
                            <span className="rounded border-[2px] border-gray-900 bg-accent px-1.5 py-0.5 text-xs font-bold uppercase tracking-[0.1em] text-onAccent">
                              Open access
                            </span>
                          )}
                          {result.citations != null && result.citations > 0 && (
                            <span className="text-muted">· cited {result.citations}</span>
                          )}
                        </div>

                        <p className="text-sm font-bold leading-5 text-ink">
                          {result.landing_url ? (
                            <a
                              href={result.landing_url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              <MathText text={result.title} />
                            </a>
                          ) : (
                            <MathText text={result.title} />
                          )}
                        </p>

                        <p className="mt-1 text-xs text-muted">
                          {result.author ?? "Unknown author"}
                          {result.venue ? ` · ${result.venue}` : ""}
                        </p>

                        {result.abstract && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted">
                            {result.abstract}
                          </p>
                        )}

                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {status === "saved" ? (
                            <span className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-accent px-2 py-1 text-xs font-bold text-onAccent">
                              <Check className="h-2.5 w-2.5" />
                              Saved to repository
                            </span>
                          ) : status === "exists" ? (
                            <span className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-white px-2 py-1 text-xs font-bold text-ink">
                              <Check className="h-2.5 w-2.5" />
                              Already in repository
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void importWebResult(result)}
                              disabled={importingKey !== null}
                              className="rounded border-[3px] border-gray-900 bg-accent px-3 py-1 text-xs font-bold text-onAccent transition-colors pixel-ease hover:bg-accentSoft disabled:opacity-50"
                            >
                              {importingKey === key ? "Importing…" : "Import"}
                            </button>
                          )}

                          {webRowErrors[key] && (
                            <span className="text-xs font-bold text-ink">
                              {webRowErrors[key]}
                            </span>
                          )}
                        </div>
                      </article>
                    </StaggerIn>
                  );
                })
              )
            ) : searchMode === "recommend" ? (
              /* ------------------------------------------------
                 RANKED RESULTS — the merged Search scope: the
                 active pipeline's scores with a per-row signal
                 bar; star/PDF/selection like the library rows.
                 ------------------------------------------------ */
              recommendLoading ? (
                <div className="p-8 text-center">
                  <p className="animate-blink text-sm font-bold text-muted">
                    Ranking with {pipelineName(activePipelineConfig)}…
                  </p>
                </div>
              ) : recommendError ? (
                <div className="p-6">
                  <p className="status-error">{recommendError}</p>
                </div>
              ) : !recommendSearched ? (
                <div className="p-6">
                  <EmptyState
                    title="Rank the corpus against a query."
                    description="Enter a query in the filter console, pick a pipeline, and press Rank corpus. Results land here with their score and signal breakdown."
                  />
                </div>
              ) : (blendRows ?? recommendResults).length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="No matches."
                    description="Try another query, a different pipeline, or a larger top K."
                  />
                </div>
              ) : (
                <>
                {blendNotice && (
                  <p className="status-warning m-3 text-xs" role="status">
                    {blendNotice}. Showing repository results only.
                  </p>
                )}
                <table className={`w-full text-left text-xs ${compactList ? "" : "min-w-[720px]"}`}>
                  <thead>
                    <tr className="font-pixelify border-b-[3px] border-gray-900 text-xs uppercase tracking-wide text-muted">
                      <th className="w-10 px-3 py-2.5 text-right">#</th>
                      <th className="w-12 px-1 py-2.5 text-center" aria-label="PDF" />
                      <th className="w-12 px-1 py-2.5 text-center" aria-label="Favorite" />
                      <th className="px-2 py-2.5">Title</th>
                      <th className={`px-2 py-2.5 ${compactList ? "hidden" : ""}`}>Authors</th>
                      <th className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>Year</th>
                      <th className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>Type</th>
                      <th className="px-2 py-2.5 text-right">Score</th>
                    </tr>
                  </thead>

                  <tbody>
                    {(blendRows ?? recommendResults.map((result): BlendRow => ({ origin: "local", result, blendScore: 0 }))).map((row, index) => {
                      if (row.origin === "web") {
                        const web = row.web;
                        const key = webKey(web);
                        const status = webImportStatus[key];
                        const webActive = selectedWeb !== null && webKey(selectedWeb) === key;
                        const comps = web.components;
                        const webSegments = [
                          { color: "bg-tfidf", value: comps?.tfidf ?? 0 },
                          { color: "bg-sbert", value: comps?.sbert ?? 0 },
                          { color: "bg-meta", value: comps?.metadata ?? 0 },
                        ];
                        const webTotal = webSegments.reduce((sum, s) => sum + s.value, 0) || 1;
                        const webLabel = "Live web result, not in the repository yet";

                        return (
                          <tr
                            key={`web:${key}`}
                            onClick={() => {
                              setInspectorCollapsed(false);
                              setSelectedWeb(web);
                            }}
                            className={`cat-row cursor-pointer border-b border-gray-200 last:border-b-0 transition-colors pixel-ease ${
                              webActive ? "bg-accentSoft/60" : "hover:bg-canvas"
                            }`}
                          >
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-muted">
                              {index + 1}
                            </td>
                            <td className="px-1 py-2.5 text-center" colSpan={2}>
                              <span
                                title={webLabel}
                                aria-label={webLabel}
                                className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-white px-1 py-0.5 font-mono text-xs font-bold leading-none text-ink"
                              >
                                <ResponsiveLabel icon={Globe} collapseBelow="xl" iconClassName="h-3 w-3 shrink-0">
                                  WEB
                                </ResponsiveLabel>
                              </span>
                            </td>
                            <td className={`px-2 py-2.5 ${compactList ? "w-full max-w-0" : "max-w-[280px]"}`}>
                              <span className="block font-pixelify font-bold text-ink">
                                <MathText text={web.title} />
                              </span>
                              <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                                {web.source}
                                {web.venue ? ` · ${web.venue}` : ""}
                                {web.publication_year ? ` · ${web.publication_year}` : ""}
                              </span>
                              <span
                                className="mt-1 flex flex-wrap items-center gap-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {status === "saved" ? (
                                  <span className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-accent px-2 py-0.5 text-xs font-bold text-onAccent">
                                    <Check className="h-2.5 w-2.5" />
                                    Saved to repository
                                  </span>
                                ) : status === "exists" ? (
                                  <span className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-white px-2 py-0.5 text-xs font-bold text-ink">
                                    <Check className="h-2.5 w-2.5" />
                                    Already in repository
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => void importWebResult(web)}
                                    disabled={importingKey !== null}
                                    className="rounded border-[2px] border-gray-900 bg-accent px-2 py-0.5 text-xs font-bold text-onAccent transition-colors pixel-ease hover:bg-accentSoft disabled:opacity-50"
                                  >
                                    {importingKey === key ? "Importing…" : "Import"}
                                  </button>
                                )}
                                {webRowErrors[key] && (
                                  <span className="text-xs font-bold text-ink">{webRowErrors[key]}</span>
                                )}
                              </span>
                            </td>
                            <td className={`max-w-[180px] px-2 py-2.5 ${compactList ? "hidden" : ""}`}>
                              <span className="block truncate font-pixelify text-muted">{web.author ?? "—"}</span>
                            </td>
                            <td className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>
                              <span className="font-pixelify text-ink">{web.publication_year ?? "—"}</span>
                            </td>
                            <td className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>
                              <span className="font-pixelify text-muted">{web.document_type ?? "Work"}</span>
                            </td>
                            <td className="px-2 py-2.5 text-right">
                              <div className={`ml-auto flex flex-col items-end ${compactList ? "w-14" : "w-24"}`}>
                                <span className="font-mono font-bold text-ink">
                                  {Number(row.score).toFixed(4)}
                                </span>
                                <span className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full border-[1px] border-gray-900">
                                  {webSegments.map((segment, i) =>
                                    segment.value > 0 ? (
                                      <span
                                        key={i}
                                        className={segment.color}
                                        style={{ width: `${(segment.value / webTotal) * 100}%` }}
                                      />
                                    ) : null,
                                  )}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      const result = row.result;
                      const paper = result.paper;
                      const active = selected?.id === paper.id;
                      const isSaved = savedIds.has(paper.id);
                      const components = result.components;
                      const segments = [
                        { color: "bg-tfidf", value: components?.tfidf ?? 0 },
                        { color: "bg-sbert", value: components?.sbert ?? 0 },
                        { color: "bg-meta", value: components?.metadata ?? 0 },
                      ];
                      const signalTotal =
                        segments.reduce((sum, s) => sum + s.value, 0) || 1;

                      return (
                        <tr
                          key={paper.id}
                          onClick={() => {
                            setSelectedWeb(null);
                            selectPaper(paper);
                          }}
                          className={`cat-row cursor-pointer border-b border-gray-200 last:border-b-0 transition-colors pixel-ease ${
                            active
                              ? "bg-accentSoft/60"
                              : "hover:bg-canvas"
                          }`}
                        >
                          <td className="px-3 py-2.5 text-right font-mono font-bold text-muted">
                            {index + 1}
                          </td>
                          <td className="px-1 py-2.5 text-center">
                            {hasPdf(paper) && (
                              <span
                                className="inline-flex items-center rounded border-[2px] border-gray-900 bg-accent px-1 py-0.5 font-mono text-xs font-bold leading-none text-onAccent"
                                title="PDF attached"
                              >
                                PDF
                              </span>
                            )}
                          </td>
                          <td className="px-1 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => toggleSaved(paper.id)}
                              aria-label={isSaved ? "Remove from favorites" : "Add to favorites"}
                              className={`transition-colors pixel-ease ${
                                isSaved ? "text-accent" : "text-muted hover:text-ink"
                              }`}
                            >
                              <Star className="h-4 w-4" />
                            </button>
                          </td>
                          <td className={`px-2 py-2.5 ${compactList ? "w-full max-w-0" : "max-w-[280px]"}`}>
                            <EditableCell
                              paperId={paper.id}
                              field="title"
                              value={paper.title ?? ""}
                              onSaved={handlePaperUpdated}
                              render={(text) => <MathText text={text} />}
                              className="w-full"
                              renderClassName="block font-pixelify font-bold text-ink"
                            />
                          </td>
                          <td className={`max-w-[180px] px-2 py-2.5 ${compactList ? "hidden" : ""}`}>
                            <EditableCell
                              paperId={paper.id}
                              field="author"
                              value={paper.author ?? ""}
                              onSaved={handlePaperUpdated}
                              className="w-full"
                              renderClassName="font-pixelify text-muted"
                            />
                          </td>
                          <td className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>
                            <EditableCell
                              paperId={paper.id}
                              field="publication_year"
                              isYear
                              value={paper.publication_year}
                              onSaved={handlePaperUpdated}
                              className="ml-auto"
                              renderClassName="font-pixelify text-ink"
                            />
                          </td>
                          <td className={`px-2 py-2.5 text-right ${compactList ? "hidden" : ""}`}>
                            <EditableCell
                              paperId={paper.id}
                              field="document_type"
                              value={paper.document_type ?? ""}
                              onSaved={handlePaperUpdated}
                              className="ml-auto"
                              renderClassName="font-pixelify text-muted"
                            />
                          </td>
                          <td className="px-2 py-2.5 text-right">
                            <div className={`ml-auto flex flex-col items-end ${compactList ? "w-14" : "w-24"}`}>
                              <span className="font-mono font-bold text-ink">
                                {Number(result.score).toFixed(4)}
                              </span>
                              <span className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full border-[1px] border-gray-900">
                                {segments.map((segment, i) =>
                                  segment.value > 0 ? (
                                    <span
                                      key={i}
                                      className={segment.color}
                                      style={{
                                        width: `${(segment.value / signalTotal) * 100}%`,
                                      }}
                                    />
                                  ) : null,
                                )}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </>
              )
            ) : loading ? (
              <div className="p-8 text-center">
                <p className="animate-blink text-sm font-bold text-muted">Loading repository…</p>
              </div>
            ) : rankedPapers.length === 0 ? (
              <div className="p-6">
                <EmptyState title="No papers match these filters." description="Try broadening the search, switching the library view, or changing one of the filters." figure={<PetFigure size={80} />} />
              </div>
            ) : (
              /* ------------------------------------------------
                 TABULAR REFERENCE LIST — sortable columns,
                 favorites, PDF indicators, multi-select.
                 ------------------------------------------------ */
              <div className="overflow-x-clip">
              <table className={`w-full text-left text-xs ${compactList ? "" : "min-w-[640px]"}`}>
                <thead className="sticky top-0 z-10 bg-white shadow-[0_3px_0_rgb(var(--gray-900))]">
                  <tr className="font-pixelify text-xs uppercase tracking-wide text-muted">
                    <th className="w-8 px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all on page"
                        checked={
                          pagedPapers.length > 0 &&
                          pagedPapers.every((p) => selectedIds.has(p.id))
                        }
                        onChange={(e) => {
                          const next = new Set(selectedIds);
                          for (const p of pagedPapers) {
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                          }
                          setSelectedIds(next);
                        }}
                        className="h-3.5 w-3.5"
                      />
                    </th>
                    {!compactList && (
                      <th className="w-10 px-1 py-2.5 text-center" aria-label="PDF" />
                    )}
                    <th className="w-10 px-1 py-2.5 text-center" aria-label="Favorite" />
                    {compactList ? (
                      <th className="px-2 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold uppercase tracking-wide text-ink">
                            Title
                          </span>
                          <label className="ml-auto flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-muted">
                            Sort
                            <select
                              value={sortColumn}
                              onChange={(event) =>
                                setSortColumn(event.target.value as typeof sortColumn)
                              }
                              className="rounded border-[2px] border-gray-900 bg-field px-1 py-0.5 text-xs normal-case text-ink"
                            >
                              <option value="date">Added</option>
                              <option value="title">Title</option>
                              <option value="author">Author</option>
                              <option value="year">Year</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                            aria-label={sortDir === "asc" ? "Ascending" : "Descending"}
                            className="rounded border-[2px] border-gray-900 bg-surface px-1.5 py-0.5 font-mono text-xs font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
                          >
                            {sortDir === "asc" ? "↑" : "↓"}
                          </button>
                        </div>
                      </th>
                    ) : (
                    (
                      [
                        ["title", "Title"],
                        ["author", "Authors"],
                        ["year", "Year"],
                        ["date", "Added"],
                      ] as const
                    ).map(([key, label]) => (
                      <th key={key} className="whitespace-nowrap px-2 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggleSort(key)}
                          className={`inline-flex items-center gap-1 font-mono text-sm font-semibold uppercase tracking-wide transition-colors pixel-ease ${
                            sortColumn === key ? "text-ink" : "text-muted hover:text-ink"
                          }`}
                        >
                          {label}
                          {sortColumn === key
                            ? sortDir === "asc"
                              ? "↑"
                              : "↓"
                            : ""}
                        </button>
                      </th>
                    ))
                    )}
                    {!compactList && (
                    <th className="px-2 py-2.5 text-right font-mono text-xs uppercase tracking-wide">
                      Type
                    </th>
                    )}
                    {similarityMode && (
                      <th className="px-2 py-2.5 text-right font-mono text-xs uppercase tracking-wide">
                        Score
                      </th>
                    )}
                  </tr>
                </thead>

                <tbody>
                  {pagedPapers.map((paper) => {
                    const { subject: paperSubject, category: paperCategory } = categoryOf(paper);
                    const active = selected?.id === paper.id;
                    const sim = similarity?.get(paper.id);
                    const isSaved = savedIds.has(paper.id);
                    const isSelected = selectedIds.has(paper.id);

                    return (
                      <tr
                        key={paper.id}
                        style={{ "--spine": spineColor(paperSubject) ?? "transparent" } as React.CSSProperties}
                        onClick={() => selectPaper(paper)}
                        onPointerDown={(event) => {
                          if (event.pointerType !== "mouse") {
                            longPress.start(
                              paper.id,
                              event.clientX,
                              event.clientY
                            );
                          }
                        }}
                        onPointerMove={(event) =>
                          longPress.move(event.clientX, event.clientY)
                        }
                        onPointerUp={longPress.cancel}
                        onPointerCancel={longPress.cancel}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          longPress.cancel();
                          openMenuAt(
                            paper.id,
                            event.clientX,
                            event.clientY
                          );
                        }}
                        className={`cat-row cursor-pointer border-b border-gray-200 last:border-b-0 transition-colors pixel-ease ${
                          isSelected ? "bg-accentSoft" : active ? "bg-accentSoft/60" : "hover:bg-canvas"
                        }`}
                      >
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${paper.title}`}
                            checked={isSelected}
                            onChange={() => toggleSelected(paper.id)}
                            className="h-3.5 w-3.5"
                          />
                        </td>
                        {!compactList && (
                        <td className="px-1 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                          {hasPdf(paper) && (
                            <span
                              className="inline-flex items-center rounded border-[2px] border-gray-900 bg-accent px-1 py-0.5 font-mono text-xs font-bold leading-none text-onAccent"
                              title="PDF attached"
                            >
                              PDF
                            </span>
                          )}
                        </td>
                        )}
                        <td className="px-1 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => toggleSaved(paper.id)}
                            aria-label={isSaved ? "Remove from favorites" : "Add to favorites"}
                            className={`transition-colors pixel-ease ${
                              isSaved ? "text-accent" : "text-muted hover:text-ink"
                            }`}
                          >
                            <Star className="h-4 w-4" />
                          </button>
                        </td>
                        {compactList ? (
                        <td className="w-full min-w-0 max-w-0 px-2 py-2.5">
                          <span className="cat-acc" aria-hidden="true">{accession(paper.id)}</span>
                          <EditableCell
                            paperId={paper.id}
                            field="title"
                            value={paper.title ?? ""}
                            onSaved={handlePaperUpdated}
                            render={(text) => <MathText text={text} />}
                            className="min-w-0 max-w-full"
                            renderClassName="font-pixelify font-bold text-ink !whitespace-normal [overflow-wrap:anywhere]"
                          />
                          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                            <EditableCell
                              paperId={paper.id}
                              field="author"
                              value={paper.author ?? ""}
                              onSaved={handlePaperUpdated}
                              className="min-w-0 max-w-full"
                              renderClassName="font-pixelify text-muted"
                            />
                            {paper.author && paper.publication_year != null && (
                              <span aria-hidden="true">·</span>
                            )}
                            <EditableCell
                              paperId={paper.id}
                              field="publication_year"
                              isYear
                              value={paper.publication_year}
                              onSaved={handlePaperUpdated}
                              renderClassName="font-pixelify text-muted"
                            />
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {hasPdf(paper) && (
                              <span
                                className="inline-flex items-center rounded border-[2px] border-gray-900 bg-accent px-1 py-0.5 font-mono text-[10px] font-bold leading-none text-onAccent"
                                title="PDF attached"
                              >
                                PDF
                              </span>
                            )}
                            {paperSubject && (
                              <span className="rounded border-[2px] border-gray-900 bg-gray-900 px-1 py-0.5 text-[10px] font-bold text-white">
                                {paperSubject}
                              </span>
                            )}
                            {paperCategory && (
                              <span className="truncate text-[11px] text-muted">{paperCategory}</span>
                            )}
                            {paper.document_type && (
                              <span className="text-[11px] text-muted">
                                {paperSubject || paperCategory ? "· " : ""}
                                {paper.document_type}
                              </span>
                            )}
                          </div>
                          {paper.snippet && (
                            <span
                              className="mt-0.5 block truncate text-xs italic text-muted"
                              title={paper.snippet}
                            >
                              <Highlight text={paper.snippet} terms={search.trim().split(/\s+/)} />
                            </span>
                          )}
                          {typeof paper.duplicate_count === "number" && paper.duplicate_count > 0 && (
                            <span
                              className="mt-0.5 inline-flex items-center rounded border-[2px] border-gray-900 bg-canvas px-1 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-muted"
                              title="Near-duplicate records hidden from this result list"
                            >
                              +{paper.duplicate_count} duplicate{paper.duplicate_count === 1 ? "" : "s"}
                            </span>
                          )}
                        </td>
                        ) : (
                        <td className="w-[46%] max-w-0 px-2 py-2.5">
                          <span className="cat-acc" aria-hidden="true">{accession(paper.id)}</span>
                          <div className="flex min-w-0 items-center gap-1.5">
                            {paperSubject && (
                              <span className="shrink-0 rounded border-[2px] border-gray-900 bg-gray-900 px-1 py-0.5 text-xs font-bold text-white">
                                {paperSubject}
                              </span>
                            )}
                            <EditableCell
                              paperId={paper.id}
                              field="title"
                              value={paper.title ?? ""}
                              onSaved={handlePaperUpdated}
                              render={(text) => <MathText text={text} />}
                              className="min-w-0 flex-1"
                              renderClassName="font-pixelify font-bold text-ink"
                            />
                          </div>
                          {paperCategory && (
                            <span className="mt-0.5 block truncate text-xs text-muted">
                              {paperCategory}
                            </span>
                          )}
                          {paper.snippet && (
                            <span
                              className="mt-0.5 block truncate text-xs italic text-muted"
                              title={paper.snippet}
                            >
                              <Highlight
                                text={paper.snippet}
                                terms={search.trim().split(/\s+/)}
                              />
                            </span>
                          )}
                          {typeof paper.duplicate_count === "number" &&
                            paper.duplicate_count > 0 && (
                              <span
                                className="mt-0.5 inline-flex items-center rounded border-[2px] border-gray-900 bg-canvas px-1 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-muted"
                                title="Near-duplicate records hidden from this result list"
                              >
                                +{paper.duplicate_count} duplicate
                                {paper.duplicate_count === 1 ? "" : "s"}
                              </span>
                            )}
                        </td>
                        )}
                        {!compactList && (
                        <>
                        <td className="max-w-[200px] px-2 py-2.5 text-muted">
                          <EditableCell
                            paperId={paper.id}
                            field="author"
                            value={paper.author ?? ""}
                            onSaved={handlePaperUpdated}
                            className="w-full"
                            renderClassName="font-pixelify text-muted"
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-mono text-muted">
                          <EditableCell
                            paperId={paper.id}
                            field="publication_year"
                            isYear
                            value={paper.publication_year}
                            onSaved={handlePaperUpdated}
                            renderClassName="font-pixelify text-muted"
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-mono text-muted">
                          {new Date(paper.created_at).toLocaleDateString()}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 text-right text-muted">
                          <EditableCell
                            paperId={paper.id}
                            field="document_type"
                            value={paper.document_type ?? ""}
                            onSaved={handlePaperUpdated}
                            className="ml-auto"
                            renderClassName="font-pixelify text-muted"
                          />
                        </td>
                        </>
                        )}
                        {similarityMode && (
                          <td className="whitespace-nowrap px-2 py-2.5 text-right font-mono text-muted">
                            {sim ? `#${sim.rank} · ${sim.score.toFixed(4)}` : "—"}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}

            {/* Context-menu action status */}
            {searchMode === "repository" && actionMessage && (
              <div
                role="status"
                className="border-t-[3px] border-gray-900 bg-white px-4 py-2 font-mono text-xs text-muted"
              >
                {actionMessage}
              </div>
            )}

            {/* Batch action bar */}
            {searchMode === "repository" && selectedIds.size > 0 && (
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-t-[3px] border-gray-900 bg-canvas px-4 py-2">
                <span className="font-mono text-xs font-bold text-ink">
                  {selectedIds.size} selected
                </span>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleBatchSave()}
                  >
                    Save to library
                  </Button>
                  <button
                    type="button"
                    onClick={() => void handleBatchDelete()}
                    className="inline-flex h-9 items-center justify-center rounded border-[3px] border-gray-900 bg-surface px-3 text-sm font-semibold text-ink hover:bg-accent hover:text-onAccent transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="inline-flex h-9 items-center justify-center rounded border-[3px] border-gray-900 bg-surface px-3 text-sm font-semibold text-ink hover:bg-accentSoft transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

          {searchMode === "repository" && (
            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              total={rankedPapers.length}
              pageSize={PAPERS_PAGE_SIZE}
              className="shrink-0 border-t-[3px] border-gray-900"
            />
          )}
        </section>

        {/* ====================================================
            RIGHT PANE — paper details
            ==================================================== */}

        {prefs.details && (inspectorCollapsed ? (
        /* Collapsed inspector: a slim rail, one click to reopen. */
        <aside className="w-full shrink-0 overflow-hidden rounded border-[3px] border-gray-900 bg-white lg:w-12 lg:self-stretch">
          <button
            type="button"
            onClick={() => {
              setInspectorCollapsed(false);
              try {
                window.localStorage.setItem("paperrec_repo_inspector", "0");
              } catch {
                // Best-effort.
              }
            }}
            title="Show the details inspector"
            aria-label="Show inspector"
            className="flex h-9 w-full items-center justify-center gap-2 bg-canvas font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted transition-colors pixel-ease hover:bg-accentSoft hover:text-ink lg:h-full lg:min-h-[240px] lg:text-lg"
          >
            <span aria-hidden="true">«</span>
            <span className="hidden sm:inline lg:hidden">Inspector</span>
          </button>
        </aside>
      ) : (
        <>
        <PaneHandle
          label="Resize details panel"
          direction="right"
          onResize={resizeRight}
        />

        {statsOpen && (
        <aside className="cat-panel cat-card w-full shrink-0 overflow-hidden rounded border-[3px] border-gray-900 bg-white lg:w-[var(--pane-right)]">
          <div className="cat-head sticky top-0 z-10 flex items-center justify-between border-b-[3px] border-gray-900 bg-canvas px-3 py-1.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
              Inspector
            </span>
            <button
              type="button"
              onClick={toggleInspector}
              aria-label="Hide the inspector"
              title="Hide the inspector"
              className="rounded border-[2px] border-gray-900 bg-surface px-2 py-0.5 font-mono text-xs font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              »
            </button>
          </div>
          <RepoStatsPane
            papers={
              searchMode === "recommend"
                ? recommendResults.map((result) => result.paper)
                : rankedPapers
            }
            query={search}
          />
        </aside>
        )}

        {!statsOpen && (
        <aside className="cat-panel cat-card w-full shrink-0 overflow-y-auto rounded border-[3px] border-gray-900 bg-white lg:w-[var(--pane-right)]">
          <div className="cat-head sticky top-0 z-10 flex items-center justify-between border-b-[3px] border-gray-900 bg-canvas px-3 py-1.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
              Inspector
            </span>
            <button
              type="button"
              onClick={toggleInspector}
              aria-label="Hide the inspector"
              title="Hide the inspector"
              className="rounded border-[2px] border-gray-900 bg-surface px-2 py-0.5 font-mono text-xs font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              »
            </button>
          </div>
          {searchMode === "web" || (searchMode === "recommend" && selectedWeb !== null) ? (
            /* ------------------------------------------------
               WEB RESULT DETAILS
               ------------------------------------------------ */
            !selectedWeb ? (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="font-mono text-sm font-bold tracking-[0.2em] text-ink">
                  NO WEB RESULT SELECTED
                </p>
                <p className="max-w-xs text-sm leading-6 text-muted">
                  Click a web result to see its record here. Then
                  import it into the repository.
                </p>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex shrink-0 gap-0.5 border-b-[3px] border-gray-900 bg-canvas p-2">
                  {WEB_INSPECTOR_TABS.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setWebTab(id as "details" | "similar")}
                      aria-pressed={webTab === id}
                      className={`flex-1 rounded border-[3px] border-gray-900 px-2 py-1.5 text-sm font-semibold transition-colors pixel-ease ${
                        webTab === id
                          ? "bg-accent text-onAccent"
                          : "bg-surface text-ink hover:bg-accentSoft"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setPopupOpen(true)}
                    title="Open in pop-up"
                    aria-label="Open in pop-up"
                    className="inspector-popout-btn"
                    >
                      <Maximize2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                {renderWebInspectorTab(webTab)}
              </div>
            )
          ) : !selected ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="font-mono text-sm font-bold tracking-[0.2em] text-ink">
                NO PAPER SELECTED
              </p>
              <p className="max-w-xs text-sm leading-6 text-muted">
                Click a paper in the list to see its full record,
                abstract, and actions here.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {/* Detail / Notes / PDF / Similar tabs */}
              <div className="flex shrink-0 gap-0.5 border-b-[3px] border-gray-900 bg-canvas p-2">
                {(["details", "notes", "pdf", "similar"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setDetailTab(tab)}
                    aria-pressed={detailTab === tab}
                    className={`flex-1 rounded border-[3px] border-gray-900 px-2 py-1.5 text-sm font-semibold transition-colors pixel-ease ${
                      detailTab === tab
                        ? "bg-accent text-onAccent"
                        : "bg-surface text-ink hover:bg-accentSoft"
                    }`}
                  >
                    {tab === "details"
                      ? "Details"
                      : tab === "notes"
                        ? "Notes"
                        : tab === "pdf"
                          ? "PDF"
                          : "Similar"}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPopupOpen(true)}
                  title="Open in pop-up"
                  aria-label="Open in pop-up"
                  className="inspector-popout-btn"
                  >
                    <Maximize2 className="h-4 w-4" aria-hidden="true" />
                  </button>
              </div>

              {renderInspectorTab(detailTab, false)}
            </div>
          )}
        </aside>
        )}
        </>
      ))}
      </div>

      {/* Status bar — the reference-manager touch: scope, filters,
          and the live count at a glance. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border-[3px] border-gray-900 bg-white px-4 py-2 font-mono text-xs text-muted">
        <span>
          {searchMode === "web"
            ? `${webSearched ? webResults.length : 0} web result${
                webResults.length === 1 ? "" : "s"
              }`
            : searchMode === "recommend"
              ? `${recommendSearched ? (blendRows ?? recommendResults).length : 0} ranked result${
                  (blendRows ?? recommendResults).length === 1 ? "" : "s"
                }`
              : `Showing ${rankedPapers.length} of ${papers.length} document${
                  papers.length === 1 ? "" : "s"
                }`}
        </span>
        <span className="text-ink">
          {searchMode === "web"
            ? "scope: web"
            : searchMode === "recommend"
              ? `scope: ${pipelineName(activePipelineConfig)}`
              : `scope: ${systemView === "all" ? "all" : systemView === "favorites" ? "favorites" : systemView === "unsorted" ? "unsorted" : "recently added"}`}
        </span>
        {authorFilter && <span>author: {authorFilter}</span>}
        {search.trim() && <span>search: {search.trim()}</span>}
        {searchMode === "recommend" && (
          <span>
            top_k: {topK}
            {diversify ? " · diversify: on" : ""}
            {blendRows ? " · web: blended" : ""}
          </span>
        )}
        <span className="text-ink">double-click cells to edit · autosaves</span>
      </div>

      {literatureMenu && (
        <LiteratureMenu
          papers={literatureMenu.papers}
          x={literatureMenu.x}
          y={literatureMenu.y}
          onClose={() => setLiteratureMenu(null)}
          onOpenFile={(paper) => {
            selectPaper(paper);
            openPdfPreview(null);
          }}
          onChanged={(message) => {
            setActionMessage(message);
            setReloadToken((token) => token + 1);
          }}
        />
      )}

      <InspectorPopup
        open={popupOpen && (webInspectorActive ? !!selectedWeb : !!selected)}
        title={
          webInspectorActive
            ? selectedWeb?.title || "Web result"
            : selected?.title || "Paper"
        }
        tab={webInspectorActive ? webTab : detailTab}
        tabs={webInspectorActive ? WEB_INSPECTOR_TABS : INSPECTOR_TABS}
        onTabChange={(tab) =>
          webInspectorActive
            ? setWebTab(tab === "similar" ? "similar" : "details")
            : setDetailTab(tab)
        }
        onClose={() => setPopupOpen(false)}
        renderTab={(tab) =>
          webInspectorActive
            ? renderWebInspectorTab(tab === "similar" ? "similar" : "details")
            : renderInspectorTab(tab, true)
        }
        onOpenSearch={
          webInspectorActive
            ? undefined
            : () => {
                if (!selected) return;
                setPopupOpen(false);
                navigate("/recommendations", {
                  state: { graphPaperId: selected.id, searchTab: "connections" },
                });
              }
        }
      />

      <RetroDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        size="md"
        elevated
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.onYes;
          setConfirm(null);
          if (action) {
            void action();
          }
        }}
      >
        {confirm?.body}
      </RetroDialog>

      <PaperViewerModal
        paper={selectedPaper}
        open={viewerOpen && !!selectedPaper}
        onClose={() => {
          setViewerOpen(false);
          setPreviewUrl(null);
        }}
        previewUrl={previewUrl}
        canEdit
        onPaperUpdated={(updated) => {
          setPapers((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          setSelectedPaper(updated);
        }}
      />

    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <div>
      <label className="filter-label">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-h-10 w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 text-sm font-medium text-ink">
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </div>
  );
}

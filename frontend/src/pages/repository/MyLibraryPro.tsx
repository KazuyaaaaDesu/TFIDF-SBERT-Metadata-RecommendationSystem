/**
 * MY LIBRARY COLLECTION — the single layout for My Library.
 *
 * Basic and PRO share the same page: four tabs (Library, Dashboard,
 * Graph, Chat). In basic form the last three are locked — they
 * unlock together once any garden tree reaches its Young stage.
 * The Library tab is the shared core: searchable, selectable,
 * draggable-to-pet, paginated, with per-row chips and actions.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, LayoutGrid, List, Lock, Trash2 } from "lucide-react";
import "./library.css";
import ResponsiveLabel from "../../components/ResponsiveLabel";

import {
  getRepositoryStats,
  removeFromLibrary,
  researchChat,
  researchChatSuggestions,
  type FactCheckReport,
  type LibraryEntry,
  type Paper,
  type ResearchChatResponse,
  type ResearchChatScope,
  type ResearchChatSource,
} from "../../api";
import ChatMarkdown from "../../components/ChatMarkdown";
import ConnectedPapersGraph from "../../components/ConnectedPapersGraph";
import FactCheckPanel from "../../components/FactCheckPanel";
import MathText from "../../components/MathText";
import PetFigure from "../../components/PetFigure";
import Highlight from "../../components/Highlight";
import PixelBurst from "../../components/retro/PixelBurst";
import RetroDialog from "../../components/retro/RetroDialog";
import ContextMenu, { type MenuEntry } from "../../components/ContextMenu";
import LibraryFolderTree, { type FolderChoice } from "../../components/LibraryFolderTree";
import { useLibraryFolders } from "../../state/libraryFolders";
import { flatPaths, folderPath, papersInFolder } from "../../utils/folderTree";
import PaperDragGhost from "../../components/PaperDragGhost";
import { beginPaperDrag } from "../../utils/paperDrag";
import { Button, EmptyState } from "../../components/ui";
import { emitPetChat } from "../../utils/petChat";
import { contextTerm } from "../../utils/petMarkov";
import { readSettings } from "../../utils/preferences";
import { useSiteMode } from "../../state/siteMode";
import ProPackButton from "../../components/ProPack";
import { PRO_PACK_QUEST_NOTE } from "../../utils/proPack";

/* The pills shown before the conversation has anything to follow up on;
   after each answer they are replaced by model-written follow-ups. */
const DEFAULT_QUESTION_PILLS = [
  "How do the newest papers frame the problem?",
  "Where do these sources disagree?",
  "Which methods recur across the collection?",
];

/* ------------------------------------------------------------ */

const FOLDER_CHOICE_KEY = "paperrec_library_folder";
const FOLDER_SUB_KEY = "paperrec_library_folder_sub";

function readFolderChoice(): FolderChoice {
  try {
    const raw = window.localStorage.getItem(FOLDER_CHOICE_KEY);

    if (raw === "unfiled") return "unfiled";
    if (raw && /^\d+$/.test(raw)) return Number(raw);
  } catch {
    /* best-effort */
  }

  return "all";
}

function readIncludeSub(): boolean {
  try {
    return window.localStorage.getItem(FOLDER_SUB_KEY) === "1";
  } catch {
    return false;
  }
}

/* The pet's drag payload (see PixelPet.tsx): JSON {id, title?}. */
const PAPER_DROP_MIME = "application/x-research-paper";

/* A 1x1 transparent image, prepared once: it replaces the native drag image. */
let blankDragImage: HTMLImageElement | null = null;

function getBlankDragImage(): HTMLImageElement | null {
  if (blankDragImage) return blankDragImage;
  const img = new Image();
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  blankDragImage = img;
  return img;
}

function startPaperDrag(
  event: React.DragEvent<HTMLElement>,
  paper: Paper,
  ids: number[] = [paper.id],
) {
  // `id`/`title` is what the pet reads; `ids` lets a folder take the whole
  // selection when a selected paper is dragged.
  event.dataTransfer.setData(
    PAPER_DROP_MIME,
    JSON.stringify({ id: paper.id, title: paper.title, ids }),
  );
  event.dataTransfer.effectAllowed = "move";

  // Hide the browser's flat drag image: PaperDragGhost draws a document
  // that changes shape over a drop zone (see utils/paperDrag.ts).
  const blank = getBlankDragImage();
  if (blank) {
    event.dataTransfer.setDragImage(blank, 0, 0);
  }
  beginPaperDrag({ title: paper.title ?? "Untitled paper", count: ids.length, x: event.clientX, y: event.clientY });
}

/* The shared bordered-chip look across the page's controls. */
const CHIP_CLASS = "rounded border-[3px] border-gray-900 px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-colors pixel-ease";
const CHIP_ACTIVE = "bg-accent text-onAccent";
const CHIP_IDLE = "bg-white text-ink hover:bg-accentSoft";

/* ------------------------------------------------------------ */

type ProTab = "library" | "dashboard" | "graph" | "chat";

const PAGE_SIZES = [10, 25, 50];

const LOCKED_FEATURES: Record<Exclude<ProTab, "library">, string> = {
  dashboard:
    "KPI cards, five-year publication bins, subject and document-type breakdowns, most-cited and newest lists.",
  graph:
    "The similar-papers graph of any saved paper, with a neighbor-count slider.",
  chat:
    "The research chat that answers across your collection with sourced passages (still a placeholder).",
};

/** 5-year bins, oldest first, with counts. */
function yearBins(papers: Paper[]): { label: string; count: number }[] {
  const bins = new Map<number, number>();

  for (const paper of papers) {
    const year = paper.publication_year;
    if (!year) continue;
    const bin = Math.floor(year / 5) * 5;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }

  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bin, count]) => ({
      label: `${bin}–${bin + 4}`,
      count,
    }));
}

/* Spine colour: a stable tone (0-5) per subject. */
function toneOf(paper: Paper): number {
  const key = paper.subject_category?.split(":", 1)[0]?.trim() || "";
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 6;
}

function categoryOf(paper: Paper) {
  const parts = paper.subject_category?.split(":", 2).map((p) => p.trim());
  return { subject: parts?.[0] ?? "", category: parts?.[1] ?? "" };
}

/* ------------------------------------------------------------ */

interface MyLibraryProProps {
  entries: LibraryEntry[];
  /** False once any garden tree reaches its Young stage. */
  locked: boolean;
  onRemoved: (paperId: number) => void;
  onPaperUpdated: (paper: Paper) => void;
  viewer: {
    paper: Paper | null;
    open: boolean;
    openPaper: (paper: Paper) => void;
    close: () => void;
  };
}

export default function MyLibraryPro({
  entries,
  locked,
  onRemoved,
  onPaperUpdated,
  viewer,
}: MyLibraryProProps) {
  const presenting = useSiteMode().mode === "presentation";
  const navigate = useNavigate();
  const [tab, setTab] = useState<ProTab>("library");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "grid">("grid");
  const [pill, setPill] = useState<"all" | "pdf" | "recent" | "unsorted">(
    "all",
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  /* Folders (the sidebar), the folder being viewed and the menus on papers. */
  const folders = useLibraryFolders();
  const [folderChoice, setFolderChoice] = useState<FolderChoice>(readFolderChoice);
  const [includeSub, setIncludeSub] = useState(readIncludeSub);
  const [paperMenu, setPaperMenu] = useState<{ x: number; y: number; papers: Paper[]; title?: string } | null>(null);
  const [newFolderFor, setNewFolderFor] = useState<Paper[] | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<Paper[] | null>(null);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [stats, setStats] = useState<{
    total: number;
    subjects: number;
  } | null>(null);

  /* Graph tab state. */
  const [graphPaperId, setGraphPaperId] = useState<number | null>(null);
  const [graphTopK, setGraphTopK] = useState(10);
  const [graphFocus, setGraphFocus] = useState<Paper | null>(null);

  /* Chat tab state — grounded retrieval over collection / repo / web,
     persisted conversations with a collapsible history rail. */
  type ChatMessage = {
    role: "user" | "assistant";
    content: string;
    sources?: ResearchChatSource[];
    usedFallback?: boolean;
    scope?: ResearchChatScope;
    /** Follow-up questions for the pills, written after this answer. */
    suggestions?: string[];
    /** Each claim checked against the sources it cites. */
    factCheck?: FactCheckReport | null;
  };

  type ChatConversation = {
    id: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
  };

  const CHAT_HISTORY_KEY = "paperrec_library_chat_hist";
  const CHAT_SIDEBAR_KEY = "paperrec_library_chat_sidebar";
  const CHAT_FACTCHECK_KEY = "paperrec_library_chat_factcheck";
  const CHAT_HISTORY_LIMIT = 20;

  const [conversations, setConversations] = useState<ChatConversation[]>(
    () => {
      try {
        const raw = window.localStorage.getItem(CHAT_HISTORY_KEY);
        const parsed = raw ? (JSON.parse(raw) as ChatConversation[]) : [];
        return Array.isArray(parsed) ? parsed.slice(0, CHAT_HISTORY_LIMIT) : [];
      } catch {
        return [];
      }
    },
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [chatScope, setChatScope] = useState<ResearchChatScope>("library");
  const [chatBusy, setChatBusy] = useState(false);
  /* Check every answer's claims against the sources it cites (on by
     default; it costs one extra model call per answer). */
  const [factCheckOn, setFactCheckOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(CHAT_FACTCHECK_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [suggestBusy, setSuggestBusy] = useState(false);
  const suggestSeq = useRef(0);
  const [chatSidebarOpen, setChatSidebarOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(CHAT_SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHAT_HISTORY_KEY,
        JSON.stringify(conversations.slice(0, CHAT_HISTORY_LIMIT)),
      );
    } catch {
      // best-effort
    }
  }, [conversations]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHAT_FACTCHECK_KEY,
        factCheckOn ? "1" : "0",
      );
    } catch {
      // best-effort
    }
  }, [factCheckOn]);

  /* Jump to (and briefly flash) source n of one answer. */
  function goToSource(anchor: string, n: number) {
    const element = document.getElementById(`${anchor}-${n}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("ring-4", "ring-accent");
    window.setTimeout(
      () => element.classList.remove("ring-4", "ring-accent"),
      1400,
    );
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHAT_SIDEBAR_KEY,
        chatSidebarOpen ? "1" : "0",
      );
    } catch {
      // best-effort
    }
  }, [chatSidebarOpen]);

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeId) ??
    conversations[0] ??
    null;

  const askBoxLocked = locked;

  /* Auto-scroll the bounded thread to the newest message. */
  const threadRef = useRef<HTMLDivElement | null>(null);
  const lastMessageCount = activeConversation?.messages.length ?? 0;

  useEffect(() => {
    const element = threadRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastMessageCount]);

  function startNewChat() {
    if (activeConversation && activeConversation.messages.length === 0) {
      return;
    }

    const conversation: ChatConversation = {
      id: `chat-${Date.now()}`,
      title: "New chat",
      updatedAt: Date.now(),
      messages: [],
    };

    setConversations((prev) => [conversation, ...prev]);
    setActiveId(conversation.id);
  }

  function deleteConversation(id: string) {
    setConversations((prev) => {
      const next = prev.filter((conversation) => conversation.id !== id);
      if (id === activeId) {
        setActiveId(next[0]?.id ?? null);
      }
      return next;
    });
  }

  function deleteAllConversations() {
    setConfirmDeleteAll(true);
  }

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  /* Follow-up pills: written after the answer is already on screen, so
     they never delay it. Only the newest request clears the busy state,
     and a failure just leaves the previous pills in place. */
  async function loadSuggestions(
    conversationId: string,
    question: string,
    data: ResearchChatResponse,
  ) {
    const mine = ++suggestSeq.current;
    setSuggestBusy(true);

    try {
      const result = await researchChatSuggestions({
        question,
        answer: data.answer,
        sourceTitles: data.sources.map((source) => source.title),
      });

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.role === "assistant" &&
                  message.content === data.answer &&
                  !message.suggestions
                    ? { ...message, suggestions: result.suggestions }
                    : message,
                ),
              }
            : conversation,
        ),
      );
    } catch {
      /* keep whatever pills are showing */
    } finally {
      if (mine === suggestSeq.current) {
        setSuggestBusy(false);
      }
    }
  }

  async function sendChat(question?: string) {
    const text = (question ?? chatText).trim();
    if (!text || chatBusy) {
      return;
    }

    const history =
      activeConversation?.messages
        .slice(-6)
        .map((message) => ({
          role: message.role,
          content: message.content,
        })) ?? [];

    setChatBusy(true);
    setChatText("");

    /* The pet talks about the conversation: its topic is read from the
       newest question (older turns only when it names none). */
    const topic = contextTerm([
      ...(activeConversation?.messages ?? []),
      { role: "user", content: text },
    ]);
    const turn =
      (activeConversation?.messages.filter((m) => m.role === "user").length ??
        0) + 1;

    emitPetChat({ kind: "thinking", term: topic, turn });

    const ensureConversation = (): string => {
      if (activeConversation && activeConversation.id === activeId) {
        return activeConversation.id;
      }
      const conversation: ChatConversation = {
        id: `chat-${Date.now()}`,
        title: "New chat",
        updatedAt: Date.now(),
        messages: [],
      };
      setConversations((prev) => [conversation, ...prev]);
      setActiveId(conversation.id);
      return conversation.id;
    };

    const conversationId = ensureConversation();

    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title:
                conversation.title === "New chat"
                  ? text.slice(0, 60)
                  : conversation.title,
              updatedAt: Date.now(),
              messages: [
                ...conversation.messages,
                { role: "user", content: text },
              ],
            }
          : conversation,
      ),
    );

    try {
      /* Settings > citation style: read per request so a change in
         Settings applies to the very next answer. */
      const settings = readSettings();

      const data = await researchChat({
        message: text,
        pipeline: "sbert",
        topK: 6,
        citationStyle: settings.citationStyle,
        includeDoi: settings.citationIncludeDoi,
        scope: chatScope,
        paperIds:
          chatScope === "library"
            ? papers.map((paper) => paper.id)
            : undefined,
        history,
        factCheck: factCheckOn,
      });

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: Date.now(),
                messages: [
                  ...conversation.messages,
                  {
                    role: "assistant",
                    content: data.answer,
                    sources: data.sources,
                    usedFallback: data.used_fallback,
                    scope: chatScope,
                    factCheck: data.fact_check ?? null,
                  },
                ],
              }
            : conversation,
        ),
      );

      emitPetChat({
        kind: data.used_fallback ? "fallback" : "answered",
        term: topic,
        sources: data.sources.length,
        turn,
      });

      void loadSuggestions(conversationId, text, data);
    } catch (error) {
      emitPetChat({ kind: "error", turn });

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: Date.now(),
                messages: [
                  ...conversation.messages,
                  {
                    role: "assistant",
                    content:
                      error instanceof Error
                        ? error.message
                        : "Research chat failed.",
                  },
                ],
              }
            : conversation,
        ),
      );
    } finally {
      setChatBusy(false);
    }
  }

  /* Table-delete pixel explosion: fires at the button's position. */
  const [burst, setBurst] = useState<{
    x: number;
    y: number;
    key: number;
  } | null>(null);

  useEffect(() => {
    getRepositoryStats()
      .then((rows) =>
        setStats({ total: rows.total_papers, subjects: rows.category_count }),
      )
      .catch(() => setStats(null));
  }, []);

  const papers = useMemo(
    () => entries.map((entry) => entry.paper),
    [entries],
  );

  const q = query.trim().toLowerCase();

  const inChosenFolder = useMemo<Set<number> | null>(() => {
    if (folderChoice === "all") return null;

    if (folderChoice === "unfiled") {
      return new Set(
        papers.filter((paper) => (folders.memberships[String(paper.id)] ?? []).length === 0).map((p) => p.id),
      );
    }

    return papersInFolder(folders.folders, folders.memberships, folderChoice, includeSub);
  }, [folderChoice, includeSub, papers, folders.folders, folders.memberships]);

  const filtered = useMemo(() => {
    const withPill = papers.filter((paper) => {
      if (inChosenFolder && !inChosenFolder.has(paper.id)) return false;

      if (pill === "pdf") {
        return paper.stored_path?.toLowerCase().endsWith(".pdf");
      }
      if (pill === "unsorted") {
        // The same test the "Unsorted" shelf uses, so the chip and the shelf agree.
        return !categoryOf(paper).subject;
      }
      if (pill === "recent") {
        return (paper.publication_year ?? 0) >= 2023;
      }
      return true;
    });

    if (!q) {
      return withPill;
    }

    return withPill.filter(
      (paper) =>
        (paper.title ?? "")
          .toLowerCase()
          .includes(q) ||
        (paper.author ?? "").toLowerCase().includes(q),
    );
  }, [papers, pill, q, inChosenFolder]);

  const deskEntries = useMemo(
    () =>
      [...entries]
        .sort((a, b) => (b.saved_at ?? "").localeCompare(a.saved_at ?? ""))
        .slice(0, 4),
    [entries],
  );

  // An empty folder is empty; a folder with papers that the filters hide is not.
  const folderIsEmpty = folderChoice !== "all" && inChosenFolder !== null && inChosenFolder.size === 0;

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Deleting, filtering or filing can leave the current page past the end:
  // always draw a page that exists.
  const safePage = Math.min(Math.max(1, page), pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const paged = filtered.slice(pageStart, pageStart + pageSize);

  /* Shelves: the current page grouped by subject. */
  const shelves = useMemo(() => {
    const map = new Map<string, Paper[]>();
    for (const paper of paged) {
      const key = categoryOf(paper).subject || "Unsorted";
      map.set(key, [...(map.get(key) ?? []), paper]);
    }
    return [...map.entries()];
  }, [paged]);


  // Selected papers that are no longer in the library (removed here, in
  // another tab or by the pet) must not linger in the selection.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;

      const present = new Set(papers.map((paper) => paper.id));
      const kept = new Set([...current].filter((id) => present.has(id)));

      return kept.size === current.size ? current : kept;
    });
  }, [papers]);

  // Keep the stored page number valid too (the pager reads safePage).
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  /* ---------------- folders: choosing, filing, menus ---------------- */

  useEffect(() => {
    try {
      window.localStorage.setItem(FOLDER_CHOICE_KEY, String(folderChoice));
      window.localStorage.setItem(FOLDER_SUB_KEY, includeSub ? "1" : "0");
    } catch {
      /* best-effort */
    }
  }, [folderChoice, includeSub]);

  // A folder that was deleted (here or elsewhere) falls back to All papers.
  useEffect(() => {
    if (
      folders.loaded &&
      typeof folderChoice === "number" &&
      !folders.folders.some((folder) => folder.id === folderChoice)
    ) {
      setFolderChoice("all");
    }
  }, [folders.loaded, folders.folders, folderChoice]);

  function chooseFolder(choice: FolderChoice) {
    setFolderChoice(choice);
    setPage(1);
    setFolderNote(null);
  }

  function say(message: string) {
    setFolderNote(message);
    window.setTimeout(() => setFolderNote((current) => (current === message ? null : current)), 4000);
  }

  async function filePapers(folderId: number, ids: number[]) {
    const name = folders.folders.find((folder) => folder.id === folderId)?.name ?? "the folder";

    try {
      const result = await folders.addPapers(folderId, ids);

      say(
        result.changed > 0
          ? `Added ${result.changed} paper${result.changed === 1 ? "" : "s"} to “${name}”.`
          : `Already in “${name}”.`,
      );
    } catch (cause) {
      say(cause instanceof Error ? cause.message : "Could not add to the folder.");
    }
  }

  async function unfilePapers(folderId: number, ids: number[]) {
    const name = folders.folders.find((folder) => folder.id === folderId)?.name ?? "the folder";

    try {
      const result = await folders.removePapers(folderId, ids);

      say(`Took ${result.changed} paper${result.changed === 1 ? "" : "s"} out of “${name}”.`);
    } catch (cause) {
      say(cause instanceof Error ? cause.message : "Could not remove from the folder.");
    }
  }

  async function createFolderWith(name: string, targets: Paper[]) {
    try {
      const made = await folders.createFolder(name, typeof folderChoice === "number" ? folderChoice : null);

      await folders.addPapers(made.id, targets.map((paper) => paper.id));
      setNewFolderFor(null);
      say(`Made “${made.name}” with ${targets.length} paper${targets.length === 1 ? "" : "s"}.`);
    } catch (cause) {
      setNewFolderError(cause instanceof Error ? cause.message : "Could not create the folder.");
    }
  }

  /** The papers a menu acts on: the whole selection if the clicked paper is in it. */
  function menuTargets(paper: Paper): Paper[] {
    return selectedIds.has(paper.id) && selectedIds.size > 1
      ? papers.filter((candidate) => selectedIds.has(candidate.id))
      : [paper];
  }

  function paperMenuEntries(targets: Paper[]): MenuEntry[] {
    const many = targets.length > 1;
    const ids = targets.map((paper) => paper.id);
    const paths = flatPaths(folders.folders);
    const entries: MenuEntry[] = [];

    if (!many) {
      entries.push({ id: "open", label: "Open", onSelect: () => viewer.openPaper(targets[0]) });
      entries.push({ id: "sep0", separator: true });
    }

    entries.push({ id: "fh", heading: many ? `Folders for ${targets.length} papers` : "Folders" });

    for (const row of paths.slice(0, 40)) {
      const inAll = ids.every((id) => folders.foldersOf(id).includes(row.id));

      entries.push({
        id: `f-${row.id}`,
        label: row.path,
        checked: inAll,
        onSelect: () => void (inAll ? unfilePapers(row.id, ids) : filePapers(row.id, ids)),
      });
    }

    entries.push({
      id: "new",
      label: many ? "New folder with these papers…" : "New folder with this paper…",
      onSelect: () => {
        setNewFolderError(null);
        setNewFolderName("");
        setNewFolderFor(targets);
      },
    });

    if (typeof folderChoice === "number" && ids.some((id) => folders.foldersOf(id).includes(folderChoice))) {
      entries.push({
        id: "unfile",
        label: `Remove from “${folders.folders.find((f) => f.id === folderChoice)?.name ?? "this folder"}”`,
        onSelect: () => void unfilePapers(folderChoice, ids),
      });
    }

    entries.push({ id: "sep1", separator: true });
    entries.push({
      id: "remove",
      label: many ? `Remove ${targets.length} papers from library…` : "Remove from library…",
      danger: true,
      onSelect: () => setRemoveFor(targets),
    });

    return entries;
  }

  function openPaperMenu(event: React.MouseEvent, paper: Paper) {
    event.preventDefault();
    const targets = menuTargets(paper);

    setPaperMenu({
      x: event.clientX,
      y: event.clientY,
      papers: targets,
      title: targets.length > 1 ? `${targets.length} papers` : undefined,
    });
  }

  function toggleSelected(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function burstAt(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const key = Date.now();
    setBurst({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      key,
    });
    window.setTimeout(
      () =>
        setBurst((current) => (current?.key === key ? null : current)),
      650,
    );
  }

  /** A click on a card or row opens the paper, except on its own controls. */
  function openFromCard(event: React.MouseEvent, paper: Paper) {
    if ((event.target as HTMLElement).closest("button, input, a, label, select, textarea")) {
      return;
    }

    // Ending a drag on the pet is not a click on the paper.
    if (window.getSelection()?.toString()) return;

    viewer.openPaper(paper);
  }

  const removing = useRef<Set<number>>(new Set());

  async function handleRemove(paper: Paper, event?: MouseEvent<HTMLButtonElement>) {
    // A double-click (or a menu action racing the button) must not remove twice.
    if (removing.current.has(paper.id)) return;
    removing.current.add(paper.id);

    if (event) {
      burstAt(event);
    }

    try {
      await removeFromLibrary(paper.id);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(paper.id);
        return next;
      });
      onRemoved(paper.id);
      void folders.refresh();
    } catch (cause) {
      say(
        cause instanceof Error
          ? `Could not remove “${paper.title}”: ${cause.message}`
          : `Could not remove “${paper.title}”.`,
      );
    } finally {
      removing.current.delete(paper.id);
    }
  }

  /* Dashboard aggregates. */
  const bins = useMemo(() => yearBins(papers), [papers]);
  const maxBin = Math.max(1, ...bins.map((b) => b.count));
  const validCount = papers.filter(
    (paper) => paper.is_valid_for_recommendation,
  ).length;
  const subjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of papers) {
      const { subject } = categoryOf(paper);
      const key = subject || "Uncategorized";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [papers]);
  const maxSubject = Math.max(1, ...subjectCounts.map(([, c]) => c));
  const docTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of papers) {
      const key = paper.document_type || "Other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [papers]);
  const mostCited = useMemo(
    () =>
      [...papers]
        .filter((p) => (p.citation_count ?? 0) > 0)
        .sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0))
        .slice(0, 5),
    [papers],
  );
  const mostRecent = useMemo(
    () =>
      [...papers]
        .filter((p) => Boolean(p.publication_year))
        .sort(
          (a, b) => (b.publication_year ?? 0) - (a.publication_year ?? 0),
        )
        .slice(0, 5),
    [papers],
  );

  useEffect(() => {
    if (graphPaperId === null) {
      setGraphFocus(null);
      return;
    }
    const paper = papers.find((p) => p.id === graphPaperId) ?? null;
    setGraphFocus(paper);
  }, [graphPaperId, papers]);

  const kpis = [
    {
      label: "Saved papers",
      value: String(papers.length),
      sub: "this collection",
    },
    {
      label: "Repository",
      value: stats ? String(stats.total) : "…",
      sub: stats ? `${stats.subjects} subjects` : "loading…",
    },
    {
      label: "Valid for ranking",
      value: String(validCount),
      sub: "title, abstract, keywords, year",
    },
    {
      label: "Document types",
      value: String(docTypeCounts.length),
      sub: docTypeCounts
        .slice(0, 2)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · "),
    },
  ];

  const tabMeta: { id: ProTab; label: string; locked: boolean }[] = [
    { id: "library", label: "Library", locked: false },
    { id: "dashboard", label: "Dashboard", locked: locked },
    { id: "graph", label: "Graph", locked: locked },
    { id: "chat", label: "Chat", locked: locked },
  ];

  const selectedCount = selectedIds.size;

  return (
    <div className="flex flex-col gap-3">
      {/* View tabs */}
      <div
        role="tablist"
        aria-label="Collection views"
        className="flex flex-wrap items-center gap-1 border-b-[3px] border-gray-900 pb-1"
      >
        {tabMeta.map((item) => {
          const active = tab === item.id;

          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={`${CHIP_CLASS} ${
                active
                  ? CHIP_ACTIVE
                  : item.locked
                    ? "text-muted hover:text-ink"
                    : CHIP_IDLE
              }`}
            >
              {item.locked && <Lock className="mr-1.5 inline h-3 w-3" />}
              {item.label}
            </button>
          );
        })}

        <span className="ml-auto pb-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
          MY LIBRARY {locked ? "" : "· PRO"}
        </span>
      </div>

      {/* ================= LIBRARY ================= */}
      {tab === "library" && (
        <div className="lib-layout">
        <LibraryFolderTree
          api={folders}
          total={papers.length}
          active={folderChoice}
          onChoose={chooseFolder}
          includeSubfolders={includeSub}
          onIncludeSubfolders={(value) => {
            setIncludeSub(value);
            setPage(1);
          }}
          onFilePapers={(folderId, ids) => void filePapers(folderId, ids)}
          onSelectFolder={(folderId) =>
            setSelectedIds(papersInFolder(folders.folders, folders.memberships, folderId, includeSub))
          }
        />
        <div className="lib-page flex min-w-0 flex-col gap-6">
          {/* On my desk: the most recently saved papers */}
          {deskEntries.length > 0 && (
            <section className="lib-desk" aria-label="On my desk">
              <div className="lib-desk-head">
                <h2 className="lib-desk-title font-pixelify">On my desk</h2>
                <span className="lib-desk-sub">Your latest saves</span>
              </div>
              <div className="lib-desk-row">
                {deskEntries.map((entry) => (
                  <button
                    key={entry.paper.id}
                    type="button"
                    data-lib-tone={toneOf(entry.paper)}
                    onClick={() => viewer.openPaper(entry.paper)}
                    draggable
                    onDragStart={(event) =>
                      startPaperDrag(event, entry.paper, selectedIds.has(entry.paper.id) ? [...selectedIds] : [entry.paper.id])
                    }
                    className="lib-desk-item"
                  >
                    <h4>
                      <MathText text={entry.paper.title} />
                    </h4>
                    <small>
                      {entry.paper.author ?? "Unknown author"}
                      {entry.paper.publication_year
                        ? ` · ${entry.paper.publication_year}`
                        : ""}
                    </small>
                  </button>
                ))}
              </div>
              <div className="lib-desk-edge" />
            </section>
          )}

          {/* Ask box — routes to the Chat tab when PRO is unlocked */}
          <div className="font-pixelify lib-panel p-4">
            <div className="flex items-center gap-2">
              {locked && (
                <span
                  title={
                    presenting
                      ? "Research chat is part of the PRO version"
                      : "Research chat unlocks with PRO — grow any garden tree past its Young stage"
                  }
                  aria-label="Locked — available in PRO mode"
                  className="shrink-0 text-muted"
                >
                  <Lock className="h-4 w-4" />
                </span>
              )}
              <input
                type="text"
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !locked) {
                    setTab("chat");
                    window.setTimeout(() => {
                      void sendChat();
                    }, 0);
                  }
                }}
                placeholder={
                  locked
                    ? "Ask a question about these papers (research chat arrives later)"
                    : "Ask a question about these papers…"
                }
                disabled={locked || chatBusy}
                className="ui-input disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <p className="mt-2 text-xs leading-5 text-muted">
              {locked
                ? presenting
                  ? "The research chat is part of the PRO version."
                  : "The research chat is locked in your current mode — it unlocks with PRO. Selection, search, dashboard, and the graph are live."
                : "Enter a question and press Enter: the Chat tab answers it against your collection, the repository, or the web, citing the sources it used."}
            </p>
          </div>

          {/* Which folder is open, and the last folder action */}
          {(folderChoice !== "all" || folderNote) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink" aria-live="polite">
              {folderChoice !== "all" && (
                <span className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-muted">
                  Viewing:{" "}
                  <span className="text-ink">
                    {folderChoice === "unfiled" ? "Unfiled papers" : folderPath(folders.folders, folderChoice)}
                  </span>
                  {" · "}
                  {filtered.length} paper{filtered.length === 1 ? "" : "s"}
                </span>
              )}
              {folderNote && <span className="text-xs text-muted">{folderNote}</span>}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3 lib-panel p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["pdf", "With PDF"],
                  ["recent", "Recent (2023+)"],
                  ["unsorted", "Unsorted"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={pill === id}
                  onClick={() => {
                    setPill(id);
                    setPage(1);
                  }}
                  className={`${CHIP_CLASS} ${
                    pill === id ? CHIP_ACTIVE : CHIP_IDLE
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search the collection…"
                aria-label="Search the collection"
                className="ui-input min-h-10 w-56 px-3 py-2 text-sm"
              />

              <div className="flex lib-panel p-0.5">
                <button
                  type="button"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                  title="List view"
                  className={`rounded px-2.5 py-1.5 transition-colors pixel-ease ${
                    view === "list"
                      ? "bg-accent text-onAccent"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <List className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                  title="Grid view"
                  className={`rounded px-2.5 py-1.5 transition-colors pixel-ease ${
                    view === "grid"
                      ? "bg-accent text-onAccent"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Selection bar */}
          {selectedCount > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-accentSoft px-4 py-2">
              <span className="font-mono text-xs font-bold text-ink">
                {selectedCount} selected
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const targets = papers.filter((paper) => selectedIds.has(paper.id));

                    setPaperMenu({ x: rect.left, y: rect.bottom + 4, papers: targets, title: `${targets.length} selected` });
                  }}
                >
                  Folders…
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          {/* Papers */}
          {filtered.length === 0 ? (
            <div className="lib-panel p-6">
              <EmptyState
                title={folderIsEmpty ? "Nothing in this folder." : "No papers match."}
                description={
                  folderIsEmpty
                    ? "Drag papers onto the folder, or right-click a paper and choose a folder."
                    : "Try a different filter or search term."
                }
                figure={<PetFigure size={72} />}
              />
            </div>
          ) : view === "grid" ? (
            <div>
              {shelves.map(([subject, shelfPapers]) => (
                <section key={subject} className="lib-shelf">
                  <div className="lib-shelf-label">
                    <h3 className="font-pixelify">{subject}</h3>
                    <span>
                      {shelfPapers.length} on this shelf
                    </span>
                  </div>
                  <div className="lib-shelf-row">
                    {shelfPapers.map((paper) => (
                      <article
                        key={paper.id}
                        draggable
                        data-lib-tone={toneOf(paper)}
                        data-selected={selectedIds.has(paper.id)}
                        onDragStart={(event) => startPaperDrag(event, paper, selectedIds.has(paper.id) ? [...selectedIds] : [paper.id])}
                        onClick={(event) => openFromCard(event, paper)}
                        onContextMenu={(event) => openPaperMenu(event, paper)}
                        className="lib-cover cursor-grab active:cursor-grabbing"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${paper.title}`}
                            checked={selectedIds.has(paper.id)}
                            onChange={() => toggleSelected(paper.id)}
                            className="mt-1 h-4 w-4 accent-[#1f5f8b]"
                          />
                          <span className="lib-cover-year">
                            {paper.publication_year ?? "—"}
                          </span>
                        </div>
                        <h3 className="mt-2 font-pixelify text-sm font-bold leading-5 text-ink">
                          <MathText text={paper.title} />
                        </h3>
                        <p className="mt-1 text-xs text-muted">
                          {paper.author ?? "Unknown author"}
                        </p>
                        {paper.abstract && (
                          <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">
                            <Highlight
                              text={paper.abstract}
                              terms={q ? [q] : []}
                            />
                          </p>
                        )}
                        <PaperChips paper={paper} />

                        <div className="mt-auto flex items-center gap-2 pt-3">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => viewer.openPaper(paper)}
                          >
                            View
                          </Button>
                          <button
                            type="button"
                            aria-label="Remove paper from collection"
                            onClick={(event) => void handleRemove(paper, event)}
                            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-surface text-muted transition-colors hover:bg-accent hover:text-onAccent"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div className="lib-shelf-plank" aria-hidden="true" />
                </section>
              ))}
            </div>
          ) : (
            <div className="lib-list">
              {paged.map((paper) => (
                <div
                  key={paper.id}
                  draggable
                  onDragStart={(event) => startPaperDrag(event, paper, selectedIds.has(paper.id) ? [...selectedIds] : [paper.id])}
                  onClick={(event) => openFromCard(event, paper)}
                  onContextMenu={(event) => openPaperMenu(event, paper)}
                  data-lib-tone={toneOf(paper)}
                  className={`lib-row cursor-grab active:cursor-grabbing ${
                    selectedIds.has(paper.id) ? "!bg-accentSoft/60" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${paper.title}`}
                    checked={selectedIds.has(paper.id)}
                    onChange={() => toggleSelected(paper.id)}
                    className="mt-1 h-4 w-4 accent-[#1f5f8b]"
                  />

                  <div className="min-w-0 flex-1">
                    <h3 className="font-pixelify text-sm font-bold leading-5 text-ink">
                      <MathText text={paper.title} />
                    </h3>
                    <p className="mt-1 text-xs text-muted">
                      {paper.author ?? "Unknown author"}
                      {paper.publication_year
                        ? ` · ${paper.publication_year}`
                        : ""}
                    </p>
                    <PaperChips paper={paper} />
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => viewer.openPaper(paper)}
                    >
                      View
                    </Button>
                    <button
                      type="button"
                      aria-label="Remove paper from collection"
                      onClick={(event) => void handleRemove(paper, event)}
                      className="inline-flex h-9 w-9 items-center justify-center lib-panel text-muted transition-colors hover:bg-accent hover:text-onAccent"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Drag-to-pet hint */}
          <p className="text-xs leading-5 text-muted">
            Tip: drag a saved paper onto the pixel pet to remove it
            from your library (the table's × deletes it in place).
          </p>

          {/* Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-3 lib-panel px-4 py-2">
            <span className="font-mono text-xs text-muted">
              {filtered.length === 0
                ? "0 papers"
                : `${pageStart + 1}–${Math.min(
                    pageStart + pageSize,
                    filtered.length,
                  )} of ${filtered.length}`}
            </span>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                aria-label="Previous page"
                title="Previous page"
                variant="secondary"
                disabled={safePage <= 1}
                onClick={() => setPage(Math.max(1, safePage - 1))}
              >
                <ResponsiveLabel icon={ChevronLeft}>Prev</ResponsiveLabel>
              </Button>
              <span className="font-mono text-xs text-muted">
                {safePage} / {pageCount}
              </span>
              <Button
                type="button"
                aria-label="Next page"
                title="Next page"
                variant="secondary"
                disabled={safePage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, safePage + 1))}
              >
                <ResponsiveLabel icon={ChevronRight}>Next</ResponsiveLabel>
              </Button>

              <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">
                per page
                <select
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                  className="min-h-8 rounded border-[3px] border-gray-900 bg-field px-1 text-xs text-ink"
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* ================= DASHBOARD ================= */}
      {tab === "dashboard" &&
        (locked ? (
          <LockedTab
            title="Dashboard"
            description={LOCKED_FEATURES.dashboard}
            onOpenGarden={() => navigate("/lab")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {kpis.map((kpi) => (
                <div
                  key={kpi.label}
                  className="rounded border-[3px] border-gray-900 bg-white p-4"
                >
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
                    {kpi.label}
                  </p>
                  <p className="font-pixelify mt-1 text-3xl font-bold text-ink">
                    {kpi.value}
                  </p>
                  <p className="mt-1 text-xs text-muted">{kpi.sub}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-4">
              {/* Papers by publication year */}
              <div className="min-w-[320px] flex-1 rounded border-[3px] border-gray-900 bg-white p-4">
                <h3 className="font-pixelify text-base font-bold text-ink">
                  Papers by publication year
                </h3>
                <p className="text-xs text-muted">Five-year bins</p>

                <div className="mt-4 flex h-40 items-end gap-2 border-b-[2px] border-gray-900">
                  {bins.length === 0 ? (
                    <p className="pb-2 text-xs text-muted">
                      No dated papers yet.
                    </p>
                  ) : (
                    bins.map((bin) => (
                      <div
                        key={bin.label}
                        className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                      >
                        <span className="font-mono text-[10px] font-bold text-ink">
                          {bin.count}
                        </span>
                        <div
                          className="w-full max-w-[56px] rounded-t border-[2px] border-b-0 border-gray-900 bg-accent"
                          style={{ height: `${(bin.count / maxBin) * 100}%` }}
                        />
                      </div>
                    ))
                  )}
                </div>
                <div className="flex gap-2 pt-1">
                  {bins.map((bin) => (
                    <span
                      key={bin.label}
                      className="min-w-0 flex-1 truncate text-center font-mono text-[10px] text-muted"
                    >
                      {bin.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Subjects */}
              <div className="min-w-[280px] flex-1 rounded border-[3px] border-gray-900 bg-white p-4">
                <h3 className="font-pixelify text-base font-bold text-ink">
                  Subjects
                </h3>
                <p className="text-xs text-muted">
                  Where the collection clusters
                </p>

                <div className="mt-4 flex flex-col gap-2.5">
                  {subjectCounts.length === 0 ? (
                    <p className="text-xs text-muted">
                      No classified papers yet.
                    </p>
                  ) : (
                    subjectCounts.slice(0, 6).map(([name, count]) => (
                      <div
                        key={name}
                        className="grid grid-cols-[minmax(90px,1.2fr)_2fr_28px] items-center gap-2 text-xs"
                      >
                        <span className="truncate text-muted">{name}</span>
                        <div className="h-2.5 overflow-hidden rounded-full border-[1px] border-gray-900 bg-canvas">
                          <div
                            className="h-full bg-accent"
                            style={{
                              width: `${(count / maxSubject) * 100}%`,
                            }}
                          />
                        </div>
                        <strong className="text-right font-mono text-ink">
                          {count}
                        </strong>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              {/* Most cited */}
              <div className="min-w-[280px] flex-1 rounded border-[3px] border-gray-900 bg-white p-4">
                <h3 className="font-pixelify text-base font-bold text-ink">
                  Most cited
                </h3>
                <div className="mt-2">
                  {mostCited.length === 0 ? (
                    <p className="text-xs text-muted">
                      Citation counts are filled by metadata enrichment.
                    </p>
                  ) : (
                    mostCited.map((paper) => (
                      <div
                        key={paper.id}
                        className="flex items-baseline gap-3 border-t border-gray-200 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1">
                          <MathText text={paper.title} />
                        </span>
                        <strong className="font-mono text-ink">
                          {paper.citation_count ?? 0}
                        </strong>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Most recent */}
              <div className="min-w-[280px] flex-1 rounded border-[3px] border-gray-900 bg-white p-4">
                <h3 className="font-pixelify text-base font-bold text-ink">
                  Newest in the collection
                </h3>
                <div className="mt-2">
                  {mostRecent.length === 0 ? (
                    <p className="text-xs text-muted">No dated papers yet.</p>
                  ) : (
                    mostRecent.map((paper) => (
                      <div
                        key={paper.id}
                        className="flex items-baseline gap-3 border-t border-gray-200 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1">
                          <MathText text={paper.title} />
                        </span>
                        <strong className="font-mono text-ink">
                          {paper.publication_year ?? "—"}
                        </strong>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Document types */}
              <div className="min-w-[240px] flex-1 rounded border-[3px] border-gray-900 bg-white p-4">
                <h3 className="font-pixelify text-base font-bold text-ink">
                  Document types
                </h3>
                <div className="mt-4 flex flex-col gap-2.5">
                  {docTypeCounts.map(([name, count]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate text-muted">{name}</span>
                      <strong className="font-mono text-ink">{count}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}

      {/* ================= GRAPH ================= */}
      {tab === "graph" &&
        (locked ? (
          <LockedTab
            title="Graph"
            description={LOCKED_FEATURES.graph}
            onOpenGarden={() => navigate("/lab")}
          />
        ) : (
          <div className="flex gap-3">
            {/* Papers menu — the loaded collection, pick to recompute */}
            <aside className="w-full shrink-0 overflow-hidden rounded border-[3px] border-gray-900 bg-white sm:w-64">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-canvas px-3 py-2">
                <p className="font-pixelify text-xs font-bold uppercase tracking-[0.15em] text-muted">
                  Papers
                </p>
                <span className="font-mono text-[10px] font-bold text-muted">
                  {papers.length}
                </span>
              </div>

              <div className="max-h-[560px] space-y-1 overflow-y-auto p-2">
                {papers.length === 0 ? (
                  <p className="px-2 py-3 text-xs leading-5 text-muted">
                    Save papers first, then pick one to explore its
                    neighborhood.
                  </p>
                ) : (
                  papers.map((paper) => {
                    const active = graphPaperId === paper.id;

                    return (
                      <button
                        key={paper.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setGraphPaperId(paper.id)}
                        className={`flex w-full flex-col gap-0.5 rounded border-[2px] px-2 py-1.5 text-left transition-colors pixel-ease ${
                          active
                            ? "border-gray-900 bg-accent text-onAccent"
                            : "border-gray-900 bg-surface text-ink hover:bg-accentSoft"
                        }`}
                      >
                        <span className="line-clamp-2 font-pixelify text-xs font-bold leading-4">
                          {paper.title}
                        </span>
                        <span
                          className={`font-mono text-[10px] ${
                            active ? "text-onAccent/70" : "text-muted"
                          }`}
                        >
                          {paper.publication_year ?? "—"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Graph column */}
            <div className="font-pixelify flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 rounded border-[3px] border-gray-900 bg-white px-4 py-3">
                <label className="flex items-center gap-2 text-[13px] font-bold text-ink">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-muted">
                    Neighbors
                  </span>
                  <input
                    type="range"
                    min={3}
                    max={25}
                    value={graphTopK}
                    onChange={(event) =>
                      setGraphTopK(Number(event.target.value))
                    }
                    className="w-36 accent-[#1f5f8b]"
                  />
                  <span className="w-8 font-mono text-sm font-bold text-ink">
                    {graphTopK}
                  </span>
                </label>
              </div>

            {graphFocus ? (
              <div className="overflow-hidden rounded border-[3px] border-gray-900 bg-white">
                <ConnectedPapersGraph
                  paperId={graphFocus.id}
                  pipeline="tfidf_sbert_metadata"
                  topK={graphTopK}
                  widened
                  controls
                  sidePanel
                  onAskAbout={(paperId, title) => {
                    setTab("chat");
                    void sendChat(
                      `Tell me about "${title}" (paper #${paperId})`,
                    );
                  }}
                  onOpenInLibrary={() => setTab("library")}
                />
              </div>
            ) : (
              <div className="rounded border-[3px] border-gray-900 bg-white p-6">
                <EmptyState
                  title="Pick a paper to explore."
                  description="The graph draws the selected paper's closest neighbors from the repository's similarity network."
                  figure={<PetFigure size={72} />}
                />
              </div>
            )}
            </div>
          </div>
        ))}

      {/* ================= CHAT ================= */}
      {tab === "chat" &&
        (locked ? (
          <LockedTab
            title="Chat"
            description={LOCKED_FEATURES.chat}
            onOpenGarden={() => navigate("/lab")}
          />
        ) : (
          <div className="font-pixelify flex gap-3">
            {/* History rail — collapsible */}
            <aside
              className={`shrink-0 overflow-hidden rounded border-[3px] border-gray-900 bg-white ${
                chatSidebarOpen ? "w-full sm:w-64" : "w-12"
              }`}
            >
              {chatSidebarOpen ? (
                <div className="flex h-full flex-col">
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b-[3px] border-gray-900 bg-canvas px-3 py-2">
                    <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
                      History
                    </p>
                    <button
                      type="button"
                      onClick={() => setChatSidebarOpen(false)}
                      title="Collapse chat history"
                      aria-label="Collapse chat history"
                      className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-mono text-xs font-bold text-ink hover:bg-accentSoft"
                    >
                      «
                    </button>
                  </div>

                  <div className="flex shrink-0 items-center justify-between gap-2 border-b-[2px] border-gray-200 px-3 py-1.5">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
                      {conversations.length} chat
                      {conversations.length === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={deleteAllConversations}
                      disabled={conversations.length === 0}
                      title="Delete the whole chat history"
                      aria-label="Delete the whole chat history"
                      className="inline-flex items-center gap-1 rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 text-[10px] font-bold text-muted transition-colors hover:bg-accent hover:text-onAccent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete all
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                    {conversations.length === 0 ? (
                      <p className="px-2 py-3 text-xs leading-5 text-muted">
                        No chats yet. Ask a question and the conversation
                        is kept here.
                      </p>
                    ) : (
                      conversations.map((conversation) => {
                        const active = conversation.id === activeConversation?.id;

                        return (
                          <div
                            key={conversation.id}
                            className={`flex items-center gap-1 rounded border-[2px] ${
                              active
                                ? "border-gray-900 bg-accent text-onAccent"
                                : "border-gray-900 bg-surface text-ink hover:bg-accentSoft"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setActiveId(conversation.id)}
                              className="min-w-0 flex-1 py-1.5 pl-2 pr-1 text-left"
                            >
                              <span className="block truncate text-xs font-bold">
                                {conversation.title}
                              </span>
                              <span
                                className={`block font-mono text-[10px] ${
                                  active ? "text-onAccent/70" : "text-muted"
                                }`}
                              >
                                {new Date(
                                  conversation.updatedAt,
                                ).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                                {" · "}
                                {conversation.messages.filter(
                                  (message) => message.role === "user",
                                ).length}{" "}
                                question
                                {conversation.messages.filter(
                                  (message) => message.role === "user",
                                ).length === 1
                                  ? ""
                                  : "s"}
                              </span>
                            </button>

                            <button
                              type="button"
                              aria-label={`Delete chat: ${conversation.title}`}
                              onClick={() =>
                                deleteConversation(conversation.id)
                              }
                              className={`mr-1 rounded border-[2px] px-1 py-0.5 transition-colors ${
                                active
                                  ? "border-white/40 bg-white/20 text-onAccent hover:bg-white/30"
                                  : "border-gray-900 bg-white text-muted hover:bg-accent hover:text-onAccent"
                              }`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setChatSidebarOpen(true)}
                  title="Show chat history"
                  aria-label="Show chat history"
                  className="flex h-full min-h-[320px] w-full flex-col items-center justify-center gap-2 bg-canvas font-mono text-lg font-bold text-muted hover:bg-accentSoft hover:text-ink"
                >
                  <span>»</span>
                  <span className="rotate-90 whitespace-nowrap text-[10px] uppercase tracking-[0.2em]">
                    History
                  </span>
                </button>
              )}
            </aside>

            {/* Thread column */}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {/* Scope selector */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded border-[3px] border-gray-900 bg-white px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-muted">
                    Chatting with
                  </span>
                  {(
                    [
                      ["library", "Collection"],
                      ["repo", "Repository"],
                      ["web", "Web"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={chatScope === id}
                      onClick={() => setChatScope(id)}
                      className={`${CHIP_CLASS} ${
                        chatScope === id ? CHIP_ACTIVE : CHIP_IDLE
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <label
                    className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs font-bold text-muted"
                    title="After each answer, check every claim against the sources it cites"
                  >
                    <input
                      type="checkbox"
                      checked={factCheckOn}
                      onChange={(event) => setFactCheckOn(event.target.checked)}
                      className="h-3.5 w-3.5 accent-gray-900"
                    />
                    Fact-check answers
                  </label>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={startNewChat}
                >
                  New chat
                </Button>
              </div>

              {/* Bounded, scrollable thread */}
              <div
                ref={threadRef}
                className="h-[540px] overflow-y-auto rounded border-[3px] border-gray-900 bg-white p-5"
              >
                {!activeConversation ||
                activeConversation.messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
                    <PetFigure size={64} />
                    <p className="font-pixelify text-lg font-bold text-ink">
                      Ask across your research
                    </p>
                    <p className="max-w-md text-sm leading-6 text-muted">
                      Answers are grounded in retrieved sources — your
                      collection, the whole repository, or the open web —
                      and cited with bracket numbers like{" "}
                      <span className="font-mono font-bold text-ink">[1]</span>.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    {activeConversation.messages.map((message, index) =>
                      message.role === "user" ? (
                        <div
                          key={index}
                          className="self-end max-w-[min(640px,92%)] whitespace-pre-wrap rounded-xl rounded-br-sm border-[3px] border-gray-900 bg-accent px-4 py-3 text-sm leading-6 text-onAccent [overflow-wrap:anywhere]"
                        >
                          {message.content}
                        </div>
                      ) : (
                        <div
                          key={index}
                          className="flex min-w-0 max-w-full flex-col gap-3"
                        >
                          {message.scope && (
                            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                              Searched {message.scope} ·{" "}
                              {message.sources?.length ?? 0} source
                              {message.sources?.length === 1 ? "" : "s"}{" "}
                              used
                            </p>
                          )}

<div className="min-w-0 self-start max-w-[min(720px,100%)] rounded-xl rounded-bl-sm border-[3px] border-gray-900 bg-white px-4 py-3 text-sm leading-6 text-ink">
                            <ChatMarkdown
                              content={message.content}
                              onCite={(n) =>
                                goToSource(
                                  `src-${activeConversation?.id}-${index}`,
                                  n,
                                )
                              }
                            />
                          </div>

                          {message.factCheck && (
                            <FactCheckPanel
                              report={message.factCheck}
                              onCite={(n) =>
                                goToSource(
                                  `src-${activeConversation?.id}-${index}`,
                                  n,
                                )
                              }
                            />
                          )}

                          {message.usedFallback && (
                            <p className="text-xs text-muted">
                              The hosted language model was unavailable,
                              so this is the extractive fallback: it
                              quotes the most relevant sentence from
                              each source directly.
                            </p>
                          )}

                          {message.sources &&
                            message.sources.length > 0 && (
                              <div className="rounded border-[2px] border-gray-900 bg-canvas">
                                <p className="border-b-[2px] border-gray-900 bg-white px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
                                  Sources
                                </p>
                                {message.sources.map(
                                  (source, sourceIndex) => (
                                    <ChatSourceRow
                                      key={sourceIndex}
                                      anchorId={`src-${activeConversation?.id}-${index}-${sourceIndex + 1}`}
                                      source={source}
                                      index={sourceIndex + 1}
                                      papers={papers}
                                      viewer={viewer}
                                    />
                                  ),
                                )}
                              </div>
                            )}
                        </div>
                      ),
                    )}

                    {chatBusy && (
                      <p className="animate-blink font-mono text-xs text-muted">
                        Retrieving sources and composing…
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Suggested questions */}
              <div
                className="flex flex-wrap gap-2"
                aria-busy={suggestBusy}
              >
                {suggestBusy
                  ? [0, 1, 2].map((slot) => (
                      <span
                        key={slot}
                        aria-hidden="true"
                        className="h-8 w-52 animate-pulse rounded-full border-[3px] border-gray-900 bg-canvas"
                      />
                    ))
                  : (
                      [...(activeConversation?.messages ?? [])]
                        .reverse()
                        .find(
                          (message) =>
                            message.role === "assistant" &&
                            message.suggestions &&
                            message.suggestions.length > 0,
                        )?.suggestions ?? DEFAULT_QUESTION_PILLS
                    ).map((question) => (
                      <button
                        key={question}
                        type="button"
                        disabled={chatBusy}
                        onClick={() => void sendChat(question)}
                        className="rounded-full border-[3px] border-gray-900 bg-white px-3 py-1.5 text-left text-xs font-semibold text-ink transition-colors hover:bg-accentSoft disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {question}
                      </button>
                    ))}
              </div>

              {/* Ask box */}
              <div className="rounded border-[3px] border-gray-900 bg-white p-4">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={chatText}
                    onChange={(event) => setChatText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void sendChat();
                      }
                    }}
                    placeholder="Ask about the literature…"
                    disabled={chatBusy}
                    className="ui-input disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <Button
                    type="button"
                    disabled={chatBusy || !chatText.trim()}
                    onClick={() => void sendChat()}
                  >
                    Ask
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))}

      {burst && <PixelBurst key={burst.key} x={burst.x} y={burst.y} />}

      <PaperDragGhost />

      {paperMenu && (
        <ContextMenu
          x={paperMenu.x}
          y={paperMenu.y}
          title={paperMenu.title ?? paperMenu.papers[0]?.title}
          ariaLabel="Paper actions"
          entries={paperMenuEntries(paperMenu.papers)}
          onClose={() => setPaperMenu(null)}
        />
      )}

      <RetroDialog
        open={newFolderFor !== null}
        title="New folder"
        confirmLabel="Create folder"
        onCancel={() => setNewFolderFor(null)}
        onConfirm={() => {
          if (newFolderFor) void createFolderWith(newFolderName, newFolderFor);
        }}
      >
        <label className="block text-sm font-bold text-ink" htmlFor="lib-new-folder-name">
          Folder name
        </label>
        <input
          id="lib-new-folder-name"
          autoFocus
          value={newFolderName}
          maxLength={80}
          onChange={(event) => setNewFolderName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newFolderFor) void createFolderWith(newFolderName, newFolderFor);
          }}
          placeholder="e.g. Thesis, chapter 2"
          className="ui-input mt-1"
        />
        <p className="mt-2 text-xs text-muted">
          {newFolderFor?.length === 1 ? "This paper" : `These ${newFolderFor?.length ?? 0} papers`} will go in it
          {typeof folderChoice === "number" ? `, inside “${folderPath(folders.folders, folderChoice)}”` : ""}.
        </p>
        {newFolderError && (
          <p role="alert" className="mt-2 rounded border-2 border-gray-900 bg-accentSoft px-2 py-1 text-xs text-ink">
            {newFolderError}
          </p>
        )}
      </RetroDialog>

      <RetroDialog
        open={removeFor !== null}
        title="Remove from library"
        confirmLabel="Remove"
        onCancel={() => setRemoveFor(null)}
        onConfirm={() => {
          const targets = removeFor ?? [];

          setRemoveFor(null);
          void (async () => {
            for (const paper of targets) await handleRemove(paper);
          })();
        }}
      >
        <p className="text-sm leading-6 text-ink">
          Remove{" "}
          {removeFor && removeFor.length === 1 ? <strong>{removeFor[0].title}</strong> : `${removeFor?.length ?? 0} papers`}{" "}
          from your library? They are also taken out of every folder. The papers stay in the repository.
        </p>
      </RetroDialog>

      <RetroDialog
        open={confirmDeleteAll}
        title="Delete chat history"
        size="sm"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onCancel={() => setConfirmDeleteAll(false)}
        onConfirm={() => {
          setConfirmDeleteAll(false);
          setConversations([]);
          setActiveId(null);
        }}
      >
        Delete the whole chat history? This cannot be undone.
      </RetroDialog>
    </div>
  );
}

/* ------------------------------------------------------------ */

/* ------------------------------------------------------------ */

function ChatSourceRow({
  anchorId,
  source,
  index,
  papers,
  viewer,
}: {
  /** DOM id the answer's [n] markers and the fact-check scroll to. */
  anchorId: string;
  source: ResearchChatSource;
  index: number;
  papers: Paper[];
  viewer: MyLibraryProProps["viewer"];
}) {
  const paper =
    source.kind === "repo"
      ? papers.find((entry) => entry.id === source.paper_id) ?? null
      : null;

  const title = (
    <span className="font-bold text-ink">
      <MathText text={source.title} />
    </span>
  );

  return (
    <div
      id={anchorId}
      className="flex scroll-mt-4 flex-col gap-1.5 border-t border-gray-200 px-3 py-2.5 text-xs transition-shadow first:border-t-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border-[2px] border-gray-900 bg-white font-mono text-[10px] font-bold text-ink">
          {index}
        </span>

        <span className="min-w-0 flex-1">
          {source.kind === "web" && source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {title}
            </a>
          ) : (
            title
          )}
        </span>

        <span className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
          {source.kind === "repo" ? "repo" : "web"}
        </span>
      </div>

      <p className="text-muted">
        {source.author ?? "Unknown author"}
        {source.year ? ` · ${source.year}` : ""}
      </p>

      {source.abstract && (
        <p className="line-clamp-3 leading-5 text-muted [overflow-wrap:anywhere]">
          <MathText text={source.abstract} />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {source.kind === "repo" && paper && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => viewer.openPaper(paper)}
          >
            Open in library
          </Button>
        )}

        {source.doi && (
          <a
            href={`https://doi.org/${source.doi}`}
            target="_blank"
            rel="noreferrer"
            className="rounded border-[2px] border-gray-900 bg-white px-2 py-1 font-mono text-[11px] font-bold text-ink transition-colors hover:bg-accentSoft"
          >
            DOI
          </a>
        )}

        {source.kind === "web" && source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="rounded border-[2px] border-gray-900 bg-white px-2 py-1 text-[11px] font-bold text-ink transition-colors hover:bg-accentSoft"
          >
            Open source ↗
          </a>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ */

function LockedTab({
  title,
  description,
  onOpenGarden,
}: {
  title: string;
  description: string;
  onOpenGarden: () => void;
}) {
  const shipped = useSiteMode().mode === "presentation";

  return (
    <div className="flex flex-col items-start gap-4 rounded border-[3px] border-gray-900 bg-white p-6">
      <p className="font-pixelify inline-flex items-center gap-2 text-xl font-bold text-ink">
        <Lock className="h-5 w-5 text-muted" />
        {title} — PRO only
      </p>
      <p className="max-w-xl text-sm leading-6 text-muted">{description}</p>

      {shipped ? (
        <p className="max-w-xl text-xs leading-5 text-muted">
          This tab is part of the PRO version.
        </p>
      ) : (
        <>
          <p className="max-w-xl text-xs leading-5 text-muted">
            Unlock every PRO tab by growing any tree in the Lab's garden
            past its Young stage — Seed → Seedling → Sapling → Young (Young
            oak 1500 fertilizer, Young maple 1450, birch 1580, elm 1600,
            redwood 1350, beanstalk 1300, rose supervine 1480).
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={onOpenGarden}>
              Open the Lab's garden
            </Button>
            <ProPackButton variant="button" />
          </div>
          <p className="max-w-xl text-xs leading-5 text-muted">
            Or skip the wait with the demo Pro Pack. {PRO_PACK_QUEST_NOTE}
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ */

function PaperChips({ paper }: { paper: Paper }) {
  const { subject } = categoryOf(paper);
  const chips: { label: string; title?: string; dark?: boolean }[] = [];

  chips.push({
    label: `cited ${paper.citation_count ?? 0}`,
    title: "Citation count (from metadata enrichment)",
  });

  if (subject) {
    chips.push({ label: subject, dark: true, title: "Subject category" });
  }

  if (paper.document_type) {
    chips.push({ label: paper.document_type, title: "Document type" });
  }

  if (!paper.is_valid_for_recommendation) {
    chips.push({ label: "missing fields", title: "Not valid for ranking" });
  }

  return (
    <span className="mt-2 inline-flex flex-wrap items-center gap-1">
      {chips.map((chip) => (
        <span
          key={chip.label}
          title={chip.title}
          className={`rounded-full border-[2px] border-gray-900 px-2 py-0.5 text-[11px] font-bold ${
            chip.dark ? "bg-gray-900 text-white" : "bg-surface text-muted"
          }`}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}
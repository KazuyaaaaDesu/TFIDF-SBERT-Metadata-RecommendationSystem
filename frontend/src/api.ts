import type { CitationStyle } from "./utils/preferences";

const API_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/** One author as the parts a citation style is built from. */
export interface AuthorPart {
  given: string;
  middle: string;
  family: string;
  suffix: string;
}

export interface Paper {
  id: number;
  title: string;
  author: string | null;
  /** The same people as `author`, in order, split into name parts. */
  authors?: AuthorPart[];
  abstract: string | null;
  keywords: string | null;
  publication_year: number | null;
  doi: string | null;
  subject_category: string | null;
  document_type: string | null;
  citation_count: number | null;
  is_valid_for_recommendation: boolean;
  missing_fields: string | null;
  source_filename: string | null;
  extraction_method: string | null;
  stored_path: string | null;
  created_at: string;
  /** Present only for BM25-ranked repository searches. */
  snippet?: string | null;
  /** Near-duplicate records hidden from a relevance result list. */
  duplicate_count?: number;
}

export interface LibraryEntry {
  paper: Paper;
  saved_at: string;
}

/** The weighted contributions behind a recommendation score. */
export interface SearchResultComponents {
  tfidf: number;
  sbert: number;
  metadata: number;
}

export interface SearchResult {
  paper: Paper;
  score: number;
  /**
   * Weighted per-component contributions behind `score`; the three
   * values sum to `score` (within rounding). Absent/null for
   * responses that do not compute a breakdown.
   */
  components?: SearchResultComponents | null;
}

export interface PdfCandidate {
  url: string;
  source: string; // "unpaywall" | "semantic_scholar" | "arxiv"
  title: string | null;
  confidence: number;
  landing_page_url: string | null;
  license: string | null;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail;

    // FastAPI sends validation problems as a list of {msg, loc}.
    const message = Array.isArray(detail)
      ? detail
          .map((item: { msg?: string }) => item?.msg)
          .filter(Boolean)
          .join("; ")
      : detail;

    throw new Error(
      message || `Request failed (${res.status})`
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

export interface PaperFilters {
  search?: string;
  subject?: string;
  category?: string;
  document_type?: string;
  min_year?: number;
  max_year?: number;
  sort_by?: string;
  limit?: number;
}

export function listPapers(
  filters: PaperFilters = {}
): Promise<Paper[]> {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  });

  return fetch(
    `${API_URL}/api/papers?${params.toString()}`
  ).then(handle<Paper[]>);
}

// ============================================================
// CATALOG (backend-owned taxonomy, auto-grows with new papers)

export interface RepositoryStats {
  total_papers: number;
  by_subject: Record<string, number>;
  category_count: number;
}

export function getRepositoryStats(): Promise<RepositoryStats> {
  return fetch(`${API_URL}/api/papers/stats`).then(handle<RepositoryStats>);
}

export interface Catalog {
  subjects: string[];
  categories: string[];
  document_types: string[];
  /**
   * Categories that co-occur with each subject in the imported
   * references, keyed by subject. Drives the Upload form's
   * auto-suggested category list for the selected subject.
   */
  subject_categories: Record<string, string[]>;
}

export function getCatalog(): Promise<Catalog> {
  return fetch(`${API_URL}/api/catalog`).then(
    handle<Catalog>
  );
}

export function getPaper(id: number): Promise<Paper> {
  return fetch(`${API_URL}/api/papers/${id}`).then(
    handle<Paper>
  );
}

// ============================================================
// BACKGROUND ENRICHMENT STATUS
//
// After a save, the backend fills in missing metadata and attaches
// found PDFs on a background queue. Poll this to know when to
// refresh the paper.
// ============================================================

// ============================================================
// RESEARCH CHAT (repository / collection / web grounded)
// ============================================================

export type ResearchChatScope = "repo" | "library" | "web";

export interface ResearchChatSource {
  kind: "repo" | "web";
  paper_id: number | null;
  title: string;
  author: string | null;
  year: number | null;
  score: number;
  abstract: string | null;
  doi: string | null;
  url: string | null;
  document_type: string | null;
}

export interface ResearchChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

/** How one claim in an answer stands against the sources it cites. */
export type ClaimVerdict =
  | "supported"
  | "partial"
  | "unsupported"
  | "contradicted"
  | "uncited"
  | "invalid_citation"
  | "unverifiable";

export interface ClaimCheck {
  id: number;
  text: string;
  /** Source numbers cited by the claim, as in the answer's [n] markers. */
  cites: number[];
  verdict: ClaimVerdict;
  confidence: number;
  evidence: { source: number; quote: string; verified: boolean } | null;
  notes: string[];
}

export interface FactCheckReport {
  method: "lexical" | "semantic" | "model";
  claims: ClaimCheck[];
  summary: {
    total: number;
    supported: number;
    partial: number;
    unsupported: number;
    contradicted: number;
    uncited: number;
    invalid_citation: number;
    unverifiable: number;
    support_rate: number | null;
  };
}

export interface ResearchChatResponse {
  answer: string;
  sources: ResearchChatSource[];
  used_fallback: boolean;
  /** Claim-by-claim check against the cited sources; null if none. */
  fact_check?: FactCheckReport | null;
}

/** Ask the research assistant; retrieval is grounded in the
 *  repository, a saved collection, or the open web. */
export function researchChat(params: {
  message: string;
  pipeline?: "tfidf" | "sbert";
  topK?: number;
  scope?: ResearchChatScope;
  paperIds?: number[];
  history?: ResearchChatHistoryItem[];
  /** Settings > citation style: the answer's in-text citations and
   *  reference list follow it. Omitted = bracket numbers. */
  citationStyle?: CitationStyle;
  includeDoi?: boolean;
  /** Check each claim against the sources it cites (default on). */
  factCheck?: boolean;
}): Promise<ResearchChatResponse> {
  return fetch(`${API_URL}/api/research-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: params.message,
      pipeline: params.pipeline ?? "sbert",
      top_k: params.topK ?? 6,
      scope: params.scope ?? "repo",
      paper_ids: params.paperIds ?? [],
      history: params.history ?? [],
      citation_style: params.citationStyle ?? null,
      include_doi: params.includeDoi ?? true,
      fact_check: params.factCheck ?? true,
    }),
  }).then(handle<ResearchChatResponse>);
}

export interface ResearchChatSuggestions {
  suggestions: string[];
  /** True when the model was unavailable and templates were used. */
  used_fallback: boolean;
}

/** Follow-up questions for the chat's suggestion pills, from the
 *  latest question, its answer and the sources it used. */
export function researchChatSuggestions(params: {
  question: string;
  answer: string;
  sourceTitles?: string[];
  count?: number;
}): Promise<ResearchChatSuggestions> {
  return fetch(`${API_URL}/api/research-chat/suggestions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question: params.question,
      answer: params.answer,
      source_titles: params.sourceTitles ?? [],
      count: params.count ?? 3,
    }),
  }).then(handle<ResearchChatSuggestions>);
}

export type EnrichmentStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed";

export function getEnrichmentStatus(
  paperId: number
): Promise<{ paper_id: number; status: EnrichmentStatus }> {
  return fetch(
    `${API_URL}/api/papers/${paperId}/enrichment-status`
  ).then(handle<{ paper_id: number; status: EnrichmentStatus }>);
}

export function getPaperPdfUrl(paperId: number): string {
  return `${API_URL}/api/papers/${paperId}/pdf`;
}

export function updatePaper(
  id: number,
  updates: Partial<Paper>
): Promise<Paper> {
  return fetch(`${API_URL}/api/papers/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  }).then(handle<Paper>);
}

/** What the Upload form reviews: the fields saved with a paper. */
export interface ReviewedFields {
  title: string;
  abstract: string;
  keywords: string;
  publication_year: number | null;
  author: string | null;
  doi: string | null;
  subject_category: string | null;
  document_type: string | null;
  citation_count: number | null;
}

/**
 * Import a file. The reviewed fields travel with it, so the paper is
 * saved once, already corrected (no second request that can fail and
 * leave a half-edited record). A form post cannot tell "left out" from
 * "left blank", so emptied fields are listed in `cleared`.
 */
export function uploadPaper(
  file: File,
  fields?: ReviewedFields
): Promise<Paper> {
  const formData = new FormData();
  formData.append("file", file);

  if (fields) {
    const cleared: string[] = [];

    for (const [name, value] of Object.entries(fields)) {
      if (value === null || value === "") {
        cleared.push(name);
      } else {
        formData.append(name, String(value));
      }
    }

    if (cleared.length > 0) {
      formData.append("cleared", cleared.join(","));
    }
  }

  return fetch(`${API_URL}/api/papers/upload`, {
    method: "POST",
    body: formData,
  }).then(handle<Paper>);
}

/** Read a file's metadata without saving anything. */
export function previewPaperFile(file: File): Promise<PaperPreviewData> {
  const formData = new FormData();
  formData.append("file", file);

  return fetch(`${API_URL}/api/papers/preview`, {
    method: "POST",
    body: formData,
  }).then(handle<PaperPreviewData>);
}

// ============================================================
// ADD BY IDENTIFIER (DOI / arXiv / link)
// ============================================================

/** The preview payload shared by file and identifier lookups. */
export interface PaperPreviewData {
  title: string;
  author: string | null;
  abstract: string | null;
  keywords: string | null;
  publication_year: number | null;
  doi: string | null;
  subject_category: string | null;
  document_type: string | null;
  citation_count: number | null;
  is_valid_for_recommendation: boolean;
  missing_fields: string | null;
  source_filename: string | null;
  extraction_method: string | null;
  /** The stored paper this one would be rejected as a copy of. */
  duplicate_of?: { id: number; title: string | null } | null;
  pdf_candidates?: Array<{
    url: string;
    source: string;
    title: string | null;
    confidence: number;
    landing_page_url: string | null;
    license: string | null;
  }>;
}

/**
 * Resolve a pasted DOI, arXiv id, or link to either -- nothing is
 * persisted; the result is a preview for review before saving.
 */
export function previewIdentifier(
  identifier: string
): Promise<PaperPreviewData> {
  return fetch(`${API_URL}/api/papers/preview-identifier`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ identifier }),
  }).then(handle<PaperPreviewData>);
}

// ============================================================
// GOOGLE SCHOLAR EXPORT LINKS (BibTeX / EndNote / RefMan)
// ============================================================

export interface ScholarCitation {
  format: "bib" | "enw" | "ris";
  text: string;
  url: string;
}

/**
 * Fetch a Google Scholar export link server-side (the browser
 * cannot fetch scholar.google.com directly). Nothing is persisted:
 * `format` + `text` feed the normal preview → review → save flow.
 */
export function fetchScholarCitation(
  url: string
): Promise<ScholarCitation> {
  return fetch(`${API_URL}/api/papers/scholar-fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  }).then(handle<ScholarCitation>);
}

export interface LinkContent {
  format: "bib" | "enw" | "ris" | "doi";
  text: string;
  url: string;
}

/**
 * Fetch any dropped http(s) link server-side. Citation text comes
 * back as bib/ris/enw; a page with only a DOI comes back as "doi".
 */
export function fetchLinkContent(url: string): Promise<LinkContent> {
  return fetch(`${API_URL}/api/papers/fetch-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then(handle<LinkContent>);
}

export interface MetadataImportInput {
  title: string;
  author?: string | null;
  abstract?: string | null;
  keywords?: string | null;
  publication_year?: number | null;
  doi?: string | null;
  subject_category?: string | null;
  document_type?: string | null;
  citation_count?: number | null;
  source_filename?: string | null;
  pdf_url?: string | null;
}

/**
 * Create a paper directly from reviewed metadata (no source file) --
 * the save step of the identifier flow.
 */
export function importPaperFromMetadata(
  input: MetadataImportInput
): Promise<Paper> {
  return fetch(`${API_URL}/api/papers/import-metadata`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  }).then(handle<Paper>);
}

// ============================================================
// WEB SEARCH (OpenAlex + Crossref)
// ============================================================

export interface WebSearchResult {
  title: string;
  author: string | null;
  abstract: string | null;
  publication_year: number | null;
  doi: string | null;
  venue: string | null;
  /** Which legitimate API answered: "openalex" | "crossref" | "arxiv" | "doaj". */
  source: string;
  citations: number | null;
  /** null = unknown (Crossref has no reliable OA flag). */
  is_oa: boolean | null;
  landing_url: string | null;
  document_type: string | null;
  /** Direct full-text link (arXiv results carry one). */
  pdf_url?: string | null;
  /** Set when the hit was ranked by a recommendation pipeline. */
  rank?: number;
  /** The pipeline's final score for this hit (0..1). */
  score?: number;
  /** The component scores behind `score`. */
  components?: { tfidf: number; sbert: number; metadata: number };
}

export interface WebSearchParams {
  q: string;
  year_min?: number | null;
  year_max?: number | null;
  peer_reviewed?: boolean;
  open_access?: boolean;
  /** Comma-joined: "openalex,crossref" (also "arxiv", "doaj"). */
  sources?: string;
  sort?: "relevance" | "citations" | "year";
  limit?: number;
  /** Aborts the request when a newer search supersedes this one. */
  signal?: AbortSignal;
}

/**
 * Legitimate web search across OpenAlex + Crossref. Peer-reviewed
 * types only unless peer_reviewed is explicitly turned off.
 */
export function searchWeb(
  params: WebSearchParams
): Promise<WebSearchResult[]> {
  const query = new URLSearchParams({ q: params.q });

  if (params.year_min != null) query.set("year_min", String(params.year_min));
  if (params.year_max != null) query.set("year_max", String(params.year_max));
  query.set("peer_reviewed", String(params.peer_reviewed ?? true));
  query.set("open_access", String(params.open_access ?? false));
  if (params.sources) query.set("sources", params.sources);
  query.set("sort", params.sort ?? "relevance");
  if (params.limit) query.set("limit", String(params.limit));

  return fetch(`${API_URL}/api/search-web?${query.toString()}`, {
    signal: params.signal,
  }).then(handle<WebSearchResult[]>);
}

export interface WebRecommendationParams {
  q: string;
  pipeline: string;
  topK?: number;
  year_min?: number | null;
  year_max?: number | null;
  peer_reviewed?: boolean;
  open_access?: boolean;
  sources?: string;
  /** Dial allocation for pipeline="custom" (0..100 per signal). */
  weights?: DialWeights;
  signal?: AbortSignal;
}

/**
 * Recommend from the open web: live OpenAlex / Crossref / arXiv hits
 * ranked by ONE pipeline (or the custom dials), each row carrying its
 * rank, score and component scores.
 */
export function getWebRecommendations(
  params: WebRecommendationParams
): Promise<WebSearchResult[]> {
  const query = new URLSearchParams({
    q: params.q,
    pipeline: params.pipeline,
  });

  if (params.topK !== undefined) query.set("top_k", String(params.topK));
  if (params.year_min != null) query.set("year_min", String(params.year_min));
  if (params.year_max != null) query.set("year_max", String(params.year_max));
  query.set("peer_reviewed", String(params.peer_reviewed ?? true));
  query.set("open_access", String(params.open_access ?? false));
  if (params.sources) query.set("sources", params.sources);

  if (params.weights) {
    query.set("w_tfidf", String(params.weights.tfidf));
    query.set("w_sbert", String(params.weights.sbert));
    query.set("w_metadata", String(params.weights.metadata));
  }

  return fetch(
    `${API_URL}/api/recommendations/web?${query.toString()}`,
    { signal: params.signal }
  ).then(handle<WebSearchResult[]>);
}

export function getLibrary(): Promise<LibraryEntry[]> {
  return fetch(`${API_URL}/api/library`).then(
    handle<LibraryEntry[]>
  );
}

/** Lets the nav badge refresh whenever the library changes. */
function notifyLibraryChanged() {
  window.dispatchEvent(new Event("library-changed"));
}

export function saveToLibrary(
  paperId: number
): Promise<{ status: string }> {
  return fetch(`${API_URL}/api/library/${paperId}`, {
    method: "POST",
  })
    .then(handle<{ status: string }>)
    .then((result) => {
      notifyLibraryChanged();
      return result;
    });
}

export interface AssignKeywordsResult {
  checked: number;
  updated: number;
  paper_ids: number[];
}

/**
 * Automatic keyword assigner: fills in YAKE keywords for every
 * library paper that has none. Called by the My Library page on
 * load; local and best-effort.
 */
export function assignLibraryKeywords(): Promise<AssignKeywordsResult> {
  return fetch(`${API_URL}/api/library/assign-keywords`, {
    method: "POST",
  }).then(handle<AssignKeywordsResult>);
}

export function removeFromLibrary(
  paperId: number
): Promise<void> {
  return fetch(`${API_URL}/api/library/${paperId}`, {
    method: "DELETE",
  })
    .then(handle<void>)
    .then((result) => {
      notifyLibraryChanged();
      return result;
    });
}

export function deletePaper(
  paperId: number
): Promise<void> {
  return fetch(`${API_URL}/api/papers/${paperId}`, {
    method: "DELETE",
  }).then(handle<void>);
}

/** Removes only the stored PDF; the paper record stays intact. */
export function deletePaperPdf(paperId: number): Promise<Paper> {
  return fetch(`${API_URL}/api/papers/${paperId}/pdf`, {
    method: "DELETE",
  }).then(handle<Paper>);
}

export interface DialWeights {
  tfidf: number;
  sbert: number;
  metadata: number;
}

export interface RecommendationParams {
  pipeline: string;
  query?: string;
  seedPaperId?: number;
  topK?: number;
  /** Optional 1-based page over the bounded top-K result list. */
  page?: number;
  /** Optional page size; the API keeps the response as SearchResult[]. */
  pageSize?: number;
  /** Optional MMR diversification (0 = max diversity, 1 = off). */
  mmrLambda?: number;
  /** Candidate pool the MMR reranker considers (1..100). */
  mmrPool?: number;
  /** Dial allocation for pipeline="custom" (0..100 per signal). */
  weights?: DialWeights;
}

export function getRecommendations(
  params: RecommendationParams,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const search = new URLSearchParams();

  search.set("pipeline", params.pipeline);

  if (params.query) {
    search.set("query", params.query);
  }

  if (params.seedPaperId !== undefined) {
    search.set(
      "seed_paper_id",
      String(params.seedPaperId)
    );
  }

  if (params.topK !== undefined) {
    search.set(
      "top_k",
      String(params.topK)
    );
  }

  if (params.page !== undefined) {
    search.set("page", String(params.page));
  }

  if (params.pageSize !== undefined) {
    search.set("page_size", String(params.pageSize));
  }

  if (params.mmrLambda !== undefined) {
    search.set("mmr_lambda", String(params.mmrLambda));
  }

  if (params.mmrPool !== undefined) {
    search.set("mmr_pool", String(params.mmrPool));
  }

  if (params.weights) {
    search.set("w_tfidf", String(params.weights.tfidf));
    search.set("w_sbert", String(params.weights.sbert));
    search.set("w_metadata", String(params.weights.metadata));
  }

  return fetch(
    `${API_URL}/api/recommendations?${search.toString()}`,
    signal ? { signal } : undefined
  ).then(handle<SearchResult[]>);
}

// ============================================================
// RECOMMENDATION EXECUTION TRACE
// ============================================================

export interface TraceEvent {
  event: string;
  message: string;
  data: Record<string, unknown>;
}

export interface RecommendationTrace {
  events: TraceEvent[];
  results: SearchResult[];
}

export function getRecommendationTrace(
  params: RecommendationParams
): Promise<RecommendationTrace> {
  return fetch(`${API_URL}/api/recommendations/trace`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pipeline: params.pipeline,
      query: params.query ?? null,
      seed_paper_id:
        params.seedPaperId ?? null,
      top_k: params.topK ?? 10,
      ...(params.weights
        ? {
            w_tfidf: params.weights.tfidf,
            w_sbert: params.weights.sbert,
            w_metadata: params.weights.metadata,
          }
        : {}),
      mmr_lambda: params.mmrLambda ?? null,
      mmr_pool: params.mmrPool ?? 50,
    }),
  }).then(handle<RecommendationTrace>);
}

// ============================================================
// PIPELINE COMPARISON ("PIPELINE BATTLE")
// ============================================================

export interface CompareRankedPaper {
  paper_id: number;
  title: string | null;
  year: number | null;
  score: number;
  /** Weighted TF-IDF / S-BERT / metadata contributions behind the score. */
  components?: Record<string, number> | null;
}

export type SignalName = "tfidf" | "sbert" | "metadata";

export interface DifferencePaper {
  paper_id: number;
  title: string | null;
  year: number | null;
  in: string[];
  out: string[];
  ranks: Record<string, number>;
  spread: number;
  mean_rank: number;
  /** Strongest signal behind this paper in each pipeline that returned it. */
  drivers: Record<string, SignalName>;
}

export interface BattleDifferences {
  n_pipelines: number;
  union: number;
  shared_by_all: number;
  contested_count: number;
  contested: DifferencePaper[];
  unanimous: DifferencePaper[];
  pipelines: {
    id: string;
    unique_count: number;
    unique: DifferencePaper[];
    signal_mix: Record<SignalName, number> | null;
    dominant: SignalName | null;
  }[];
}

export interface ComparePipelineBattle {
  id: string;
  results: CompareRankedPaper[];
}

export interface CompareConsensusEntry {
  paper_id: number;
  title: string | null;
  year: number | null;
  votes: number;
  avg_rank: number | null;
  best_rank: number | null;
}

export interface ComparePairwiseAgreement {
  a: string;
  b: string;
  overlap: number;
  mean_rank_gap: number | null;
}

export interface CompareWinner {
  pipeline_id: string;
  metric: "independence_weighted_consensus";
  value: number;
  avg_consensus_rank: number | null;
  /** Lead over the runner-up's consensus share (0..1); null with one pipeline. */
  margin?: number | null;
  runner_up?: string | null;
  /** margin >= min_margin. A leader inside the margin is "too close to call". */
  decisive?: boolean | null;
  /** Every pipeline within `min_margin` of the leader (leader included). */
  contenders?: string[];
  shares?: Record<string, number>;
  min_margin?: number;
}

/** One pipeline's quality scores in a judged battle. */
export interface JudgeScore {
  ndcg: number;
  hits: number;
  hit: number;
  precision: number;
  mrr: number;
  recall: number;
  relevant_ids: number[];
  returned: number;
}

export type JudgeBasis = "references" | "human";

export interface BattleJudgement {
  basis: JudgeBasis;
  k: number;
  n_relevant: number;
  relevance: Record<string, number>;
  scores: Record<string, JudgeScore>;
  ranking: string[];
  leaders: string[];
  leader: string | null;
  margin: number;
  /** nDCG lead of at least 0.1: still one sample, not a finding. */
  separated: boolean;
  nothing_relevant_found: boolean;
}

export interface CompareResponse {
  query: string | null;
  seed_paper_id: number | null;
  top_k: number;
  pipelines: ComparePipelineBattle[];
  consensus: CompareConsensusEntry[];
  pairwise: ComparePairwiseAgreement[];
  winner: CompareWinner | null;
  /** Id of the recorded battle (needed to judge it); null when not recorded. */
  battle_id?: number | null;
  /** Seed-paper battles are scored against the paper's own references. */
  judgement?: BattleJudgement | null;
  /** Where the pipelines disagreed and which signals drove each list. */
  differences?: BattleDifferences | null;
}

export type CompareStreamEvent =
  | { event: "start"; pipelines: string[] }
  | { event: "pipeline"; id: string; seconds: number; results: CompareRankedPaper[] }
  | { event: "done"; response: CompareResponse }
  | { event: "error"; detail: string };

/**
 * The same battle as `comparePipelines`, reported as each pipeline
 * finishes. Resolves with the final response; `onEvent` sees every step.
 */
export async function comparePipelinesStream(
  params: Parameters<typeof comparePipelines>[0],
  onEvent: (event: CompareStreamEvent) => void,
  signal?: AbortSignal,
): Promise<CompareResponse> {
  const res = await fetch(`${API_URL}/api/recommendations/compare/stream`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(compareBody(params)),
  });

  if (!res.ok || !res.body) {
    return handle<CompareResponse>(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: CompareResponse | null = null;

  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as CompareStreamEvent;

    if (event.event === "error") throw new Error(event.detail);
    if (event.event === "done") final = event.response;
    onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";
    lines.forEach(consume);
  }

  consume(buffer);

  if (!final) throw new Error("The battle ended before it finished.");

  return final;
}

export function comparePipelines(params: {
  query?: string;
  seedPaperId?: number;
  topK?: number;
  customWeights?: { tfidf: number; sbert: number; metadata: number };
  /** Lab experiment: diversify every pipeline's list (0..1). */
  mmrLambda?: number;
  mmrPool?: number;
  recordBattle?: boolean;
  /**
   * Research tag stored with the run, e.g. "campaign-ml-text-5".
   * Left off by default: a casual battle has nothing to be named,
   * and a campaign run cannot be identified later without one.
   */
  runLabel?: string;
  /** Which of the campaign's subject classes this run belongs to. */
  subjectClass?: string;
}): Promise<CompareResponse> {
  return fetch(`${API_URL}/api/recommendations/compare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(compareBody(params)),
  }).then(handle<CompareResponse>);
}

function compareBody(params: Parameters<typeof comparePipelines>[0]) {
  return {
    query: params.query ?? null,
    seed_paper_id: params.seedPaperId ?? null,
    top_k: params.topK ?? 10,
    custom_weights: params.customWeights ?? null,
    mmr_lambda: params.mmrLambda ?? null,
    mmr_pool: params.mmrPool ?? 50,
    record_battle: params.recordBattle ?? true,
    run_label: params.runLabel ?? null,
    subject_class: params.subjectClass ?? null,
  };
}

// ============================================================
// WEB PIPELINE BATTLE — battle the pipelines over live
// OpenAlex/Crossref/arXiv hits instead of the repository.

export function webComparePipelines(params: {
  q: string;
  topK?: number;
  sources?: string;
  sort?: string;
  peerReviewed?: boolean;
  openAccess?: boolean;
  customWeights?: { tfidf: number; sbert: number; metadata: number };
  signal?: AbortSignal;
}): Promise<CompareResponse> {
  return fetch(`${API_URL}/api/recommendations/web-compare`, {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: params.q,
      top_k: params.topK ?? 5,
      sources: params.sources ?? "openalex,crossref,arxiv",
      sort: params.sort ?? "relevance",
      peer_reviewed: params.peerReviewed ?? true,
      open_access: params.openAccess ?? false,
      custom_weights: params.customWeights ?? null,
    }),
  }).then(handle<CompareResponse>);
}

// ============================================================
// BATTLE HISTORY

export interface BattleRun {
  id: number;
  query: string | null;
  seed_paper_id: number | null;
  top_k: number;
  winner_pipeline_id: string;
  winner_metric: string;
  winner_value: number | null;
  avg_consensus_rank: number | null;
  created_at: string;
  /**
   * Research log. Null on every run recorded before these columns
   * existed, which is exactly what makes them the marker for "this
   * run is not part of a tagged campaign".
   */
  run_label?: string | null;
  subject_class?: string | null;
  query_kind?: string | null;
  corpus_size?: number | null;
  corpus_version?: string | null;
  /** Lead over the runner-up; null on runs recorded before margins existed. */
  margin?: number | null;
  decisive?: boolean | null;
  judged_basis?: JudgeBasis | null;
  judged_leader?: string | null;
}

export interface BattleVerdictCounts {
  decisive: number;
  too_close: number;
  /** Current metric but no margin recorded (and none recoverable). */
  unknown: number;
  /** Recorded under the retired vote-count metric. */
  legacy: number;
  judged: number;
}

export interface BattleHistoryResponse {
  runs: BattleRun[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  /** Decisive wins only. */
  tally: { pipeline_id: string; wins: number }[];
  verdicts?: BattleVerdictCounts;
}

export function getBattleHistory(
  page = 1,
  pageSize = 20,
): Promise<BattleHistoryResponse> {
  const search = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  return fetch(`${API_URL}/api/evaluation/battles?${search}`).then(
    handle<BattleHistoryResponse>,
  );
}

// ============================================================
// BATTLE EXPORT / ARCHIVE / RESET
//
// The campaign's tally is only defensible if the history can be
// exported and cleared on the morning collection starts, so these
// are first-class API calls rather than something done by hand in
// the database file.
// ============================================================

export type BattleExportFormat = "csv" | "jsonl";

export interface BattleExportPayload {
  /** Server-side filename, from Content-Disposition. */
  filename: string;
  /** The whole export as text. */
  text: string;
}

/**
 * Fetch the run history as a download.
 *
 * CSV is the flattened, spreadsheet-friendly shape; JSONL carries each
 * run's full comparison response (consensus, pairwise agreement) so
 * nothing computed is lost. Returns the text rather than saving it so
 * the caller can name the file it offers to the browser.
 */
export async function exportBattleHistory(
  format: BattleExportFormat,
): Promise<BattleExportPayload> {
  const response = await fetch(
    `${API_URL}/api/evaluation/battles/export?format=${format}`,
  );

  // handle() parses JSON for the error detail and then throws, so a
  // failure here still surfaces the server's own message.
  if (!response.ok) {
    return handle<never>(response);
  }

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);

  return {
    filename: match?.[1] ?? `battle_runs.${format}`,
    text: await response.text(),
  };
}

export interface BattleArchiveResult {
  status: string;
  /** Rows written to the archive file. */
  archived: number;
  /** Rows removed from the table afterwards. */
  deleted: number;
  filename: string;
  /** Repo-relative, e.g. "storage/exports/battle_runs-....jsonl". */
  path: string;
}

/** Write the history to storage/exports/ and clear the table. */
export function archiveBattleHistory(): Promise<BattleArchiveResult> {
  return fetch(`${API_URL}/api/evaluation/battles/archive`, {
    method: "POST",
  }).then(handle<BattleArchiveResult>);
}

export interface BattleDeleteResult {
  status: string;
  deleted: number;
}

/**
 * Clear the history for good, keeping no copy. The confirm flag is
 * mandatory server-side: this is the one route in the app that
 * destroys data nothing else holds.
 */
export function deleteBattleHistory(): Promise<BattleDeleteResult> {
  return fetch(
    `${API_URL}/api/evaluation/battles?confirm=true`,
    { method: "DELETE" },
  ).then(handle<BattleDeleteResult>);
}

/** One pipeline's win share inside one group of runs. */
export interface BattleWinShare {
  pipeline_id: string;
  wins: number;
  /** Runs in the group -- the denominator of `win_share`. */
  battles: number;
  win_share: number;
}

export interface BattleStatsGroup {
  /** "text" / "seed", or a subject class. */
  [key: string]: string | number | BattleWinShare[];
}

export interface BattleStats {
  total_runs: number;
  /** Runs carrying a run_label. */
  labelled_runs: number;
  /** Runs carrying a subject_class. */
  classified_runs: number;
  /** Splits thinner than this are omitted, not reported. */
  min_battles_per_split: number;
  overall: BattleWinShare[];
  by_query_kind: BattleStatsGroup[];
  by_subject_class: BattleStatsGroup[];
  omitted: {
    query_kind: { label: string; battles: number; reason: string }[];
    subject_class: { label: string; battles: number; reason: string }[];
  };
}

/** Win shares overall, and split by query kind and subject class. */
export function getBattleStats(): Promise<BattleStats> {
  return fetch(`${API_URL}/api/evaluation/battles/stats`).then(
    handle<BattleStats>,
  );
}

// ============================================================
// FIND PDF ONLINE
// ============================================================

export function findPdfOnline(
  paperId: number
): Promise<PdfCandidate[]> {
  return fetch(
    `${API_URL}/api/papers/${paperId}/find-pdf`
  ).then(handle<PdfCandidate[]>);
}

export function attachPdf(
  paperId: number,
  url: string
): Promise<Paper> {
  return fetch(
    `${API_URL}/api/papers/${paperId}/attach-pdf`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    }
  ).then(handle<Paper>);
}

// ============================================================
// RECOMMENDATION INDEX STATUS
// ============================================================

export interface RecommendationIndexStatus {
  stale: boolean;
}

export function getRecommendationIndexStatus(): Promise<RecommendationIndexStatus> {
  return fetch(
    `${API_URL}/api/recommendations/status`
  ).then(
    handle<RecommendationIndexStatus>
  );
}

export function rebuildRecommendationIndex(): Promise<{
  success: boolean;
  message: string;
}> {
  return fetch(
    `${API_URL}/api/recommendations/rebuild`,
    {
      method: "POST",
    }
  ).then(
    handle<{
      success: boolean;
      message: string;
    }>
  );
}

// ============================================================
// RECOMMENDATION INDEX STALE NOTIFICATION
// ============================================================

// Dispatches a browser event so AppLayout's listener
// can flip the "recommendation index needs updating"
// banner immediately, without waiting for a page reload
// or the next status poll.
export function notifyRecommendationIndexStale(): void {
  window.dispatchEvent(
    new Event("recommendation-index-stale")
  );
}

// ============================================================
// SIMILAR PAPERS GRAPH
// ============================================================

export interface SimilarGraphNode {
  id: number;
  title: string;
  author: string | null;
  publication_year: number | null;
  abstract: string | null;
  doi: string | null;
  citation_count: number | null;
  similarity: number;
  relationship: "current" | "similar";
  /** Shortest weighted path from the origin (start_id) to this node. */
  path: number[];
  /** Weighted length of that path (hop cost = 1 - edge weight). */
  path_length: number;
}

/** A shared group: author or topic present on >= 2 graph papers. */
export interface SimilarGraphCommonGroup {
  name: string;
  /** Paper ids that share this name. */
  mentions: number[];
  edges_count: number;
}

export interface SimilarPapersGraph {
  paper_id: number;
  pipeline: string;
  /** The origin paper every path starts from. */
  start_id: number;
  nodes: SimilarGraphNode[];
  /** Weighted triples: [source, target, weight] (0..1). */
  edges: [number, number, number][];
  /** Weighted distance from the origin, keyed by paper id
   *  (string keys -- this is a JSON object). */
  path_lengths: Record<string, number>;
  common_authors: SimilarGraphCommonGroup[];
  common_topics: SimilarGraphCommonGroup[];
  /** Seminal works most cited by the graph papers (cached OpenAlex). */
  prior_works: ClusterWork[];
  /** Works citing the most graph papers (surveys / follow-ups). */
  derivative_works: ClusterWork[];
}

export function getSimilarPapersGraph(
  paperId: number,
  pipeline = "tfidf_sbert_metadata",
  topK = 10,
  weights?: DialWeights
): Promise<SimilarPapersGraph> {
  const search = new URLSearchParams();

  search.set("pipeline", pipeline);
  search.set("top_k", String(topK));

  if (weights) {
    search.set("w_tfidf", String(weights.tfidf));
    search.set("w_sbert", String(weights.sbert));
    search.set("w_metadata", String(weights.metadata));
  }

  return fetch(
    `${API_URL}/api/papers/${paperId}/similar-graph?${search.toString()}`
  ).then(handle<SimilarPapersGraph>);
}

// ============================================================
// LIBRARY MODE & SITE EDITOR
// ============================================================

export type SiteFeatureState = "shown" | "locked" | "hidden";

export type AnnouncementLevel = "info" | "important" | "event";

export interface LibraryFeatures {
  features: Record<string, SiteFeatureState>;
}

export interface Announcement {
  id: number;
  title: string;
  body: string;
  level: AnnouncementLevel;
  active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  level?: AnnouncementLevel;
  active?: boolean;
  position?: number;
}

export interface AdminSession {
  token: string;
  username: string;
  expires_at: number;
}

function adminHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/** Feature states for Library Mode (public — the nav reads it). */
export function getLibraryFeatures(): Promise<LibraryFeatures> {
  return fetch(`${API_URL}/api/site/library-features`).then(
    handle<LibraryFeatures>
  );
}

/** Active announcements for the Library Home page (public). */
export function getAnnouncements(): Promise<Announcement[]> {
  return fetch(`${API_URL}/api/library/announcements`).then(
    handle<Announcement[]>
  );
}

export function adminLogin(
  username: string,
  password: string
): Promise<AdminSession> {
  return fetch(`${API_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then(handle<AdminSession>);
}

export function adminMe(token: string): Promise<{ username: string }> {
  return fetch(`${API_URL}/api/admin/me`, {
    headers: adminHeaders(token),
  }).then(handle<{ username: string }>);
}

export function adminChangePassword(
  token: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  return fetch(`${API_URL}/api/admin/password`, {
    method: "POST",
    headers: adminHeaders(token),
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  }).then(handle<{ ok: boolean }>);
}

export function adminListAnnouncements(
  token: string
): Promise<Announcement[]> {
  return fetch(`${API_URL}/api/admin/announcements`, {
    headers: adminHeaders(token),
  }).then(handle<Announcement[]>);
}

export function adminCreateAnnouncement(
  token: string,
  input: AnnouncementInput
): Promise<Announcement> {
  return fetch(`${API_URL}/api/admin/announcements`, {
    method: "POST",
    headers: adminHeaders(token),
    body: JSON.stringify(input),
  }).then(handle<Announcement>);
}

export function adminUpdateAnnouncement(
  token: string,
  id: number,
  input: Partial<AnnouncementInput>
): Promise<Announcement> {
  return fetch(`${API_URL}/api/admin/announcements/${id}`, {
    method: "PUT",
    headers: adminHeaders(token),
    body: JSON.stringify(input),
  }).then(handle<Announcement>);
}

export function adminDeleteAnnouncement(
  token: string,
  id: number
): Promise<{ ok: boolean; deleted: number }> {
  return fetch(`${API_URL}/api/admin/announcements/${id}`, {
    method: "DELETE",
    headers: adminHeaders(token),
  }).then(handle<{ ok: boolean; deleted: number }>);
}

export function adminGetLibraryFeatures(
  token: string
): Promise<LibraryFeatures> {
  return fetch(`${API_URL}/api/admin/library-features`, {
    headers: adminHeaders(token),
  }).then(handle<LibraryFeatures>);
}

export function adminSetLibraryFeatures(
  token: string,
  features: Record<string, SiteFeatureState>
): Promise<LibraryFeatures> {
  return fetch(`${API_URL}/api/admin/library-features`, {
    method: "PUT",
    headers: adminHeaders(token),
    body: JSON.stringify({ features }),
  }).then(handle<LibraryFeatures>);
}

// ============================================================
// CONNECTIONS — PRIOR / DERIVATIVE WORKS (local + web)
// ============================================================

/** One external work clustered across the local graph. */
export interface ClusterWork {
  work_id: string;
  label: string;
  doi: string | null;
  is_local: boolean;
  matched_paper_id: number | null;
  /** Local graph paper ids that reference (prior) or are cited by
   *  (derivative) this work. */
  graph_paper_ids: number[];
  count: number;
}

/** One OpenAlex work in the web neighborhood. */
export interface WebWork {
  work_id: string;
  title: string | null;
  doi: string | null;
  publication_year: number | null;
  cited_by_count: number | null;
  author: string | null;
  /**
   * Which providers returned this work. OpenAlex leads the list; a row
   * two graphs agree on names both, and the UI says so. Ids are
   * namespaced so a unioned row stays addressable: "W123" (OpenAlex),
   * "s2:<paperId>" (Semantic Scholar), "doi:<doi>" / "cr:<title>"
   * (Crossref).
   */
  sources?: string[];
}

export interface WebConnections {
  ok: boolean;
  paper_id: number;
  doi: string | null;
  work_id: string | null;
  prior_works: WebWork[];
  derivative_works: WebWork[];
  /**
   * Inter-work connection structure: [source, target, weight, kind].
   * Kinds: "ref" (center → prior), "cit" (citer → center),
   * "cites" (citer → prior), "coref" (shared references between
   * priors), "cocite" (shared references between citers).
   * The center is the literal "center".
   */
  edges?: [string, string, number, string][];
  /** Providers that answered, in merge order. */
  sources?: string[];
  /** Rows each extra provider contributed, before dedupe. */
  source_counts?: Record<string, { prior: number; derivative: number }>;
  /**
   * Why a provider contributed nothing. "no_record" is coverage (this
   * paper is not in that index); "unavailable" is a provider that was
   * down or rate-limited, which is a different and more actionable
   * thing to see next to the count.
   */
  sources_skipped?: Record<string, "no_record" | "unavailable">;
}

export function getWebConnections(
  paperId: number
): Promise<WebConnections> {
  return fetch(
    `${API_URL}/api/papers/${paperId}/web-connections`
  ).then(handle<WebConnections>);
}

/** Related works for a web result that is not in the library. */
export interface WebResultConnections
  extends Omit<WebConnections, "paper_id"> {
  /** false when no provider could match the result (empty lists). */
  resolved: boolean;
}

/**
 * Prior (references) and derivative (citers) works of a web result,
 * resolved by DOI, else provider work id, else title.
 *
 * `sources` narrows the extra providers unioned in alongside OpenAlex
 * (default "semantic_scholar,crossref"). Pass "" for OpenAlex alone.
 */
export function getWebResultConnections(
  params: {
    doi?: string | null;
    title?: string | null;
    workId?: string | null;
    sources?: string | null;
  },
  signal?: AbortSignal
): Promise<WebResultConnections> {
  const search = new URLSearchParams();

  if (params.doi) search.set("doi", params.doi);
  if (params.title) search.set("title", params.title);
  if (params.workId) search.set("work_id", params.workId);
  if (params.sources !== undefined && params.sources !== null) {
    search.set("sources", params.sources);
  }

  return fetch(
    `${API_URL}/api/web/connections?${search.toString()}`,
    signal ? { signal } : undefined
  ).then(handle<WebResultConnections>);
}

// ============================================================
// LITERATURE ACTIONS (multi-select context menu)
// ============================================================

export interface RenameResult {
  ok: boolean;
  renamed: { id: number; stored_path: string }[];
  skipped: { id: number; reason: string }[];
}

export interface MergeResult {
  ok: boolean;
  master_id: number;
  merged_ids: number[];
  fields_filled: number;
  library_moved: number;
  library_dropped: number;
  citations_moved: number;
  citations_dropped: number;
}

export function refreshPapersMetadata(
  paperIds: number[]
): Promise<{ ok: boolean; queued: number[] }> {
  return fetch(`${API_URL}/api/papers/refresh-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds }),
  }).then(handle<{ ok: boolean; queued: number[] }>);
}

export function revealPapers(
  paperIds: number[]
): Promise<{ ok: boolean; paper_id: number; path: string }> {
  return fetch(`${API_URL}/api/papers/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds }),
  }).then(handle<{ ok: boolean; paper_id: number; path: string }>);
}

export function renamePaperFiles(
  paperIds: number[],
  pattern: "title" | "author-year" | "author-year-title" | "custom",
  customName?: string
): Promise<RenameResult> {
  return fetch(`${API_URL}/api/papers/rename-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paper_ids: paperIds,
      pattern,
      custom_name: customName,
    }),
  }).then(handle<RenameResult>);
}

export function markPapers(
  paperIds: number[],
  valid: boolean
): Promise<{ ok: boolean; updated: number; valid: boolean }> {
  return fetch(`${API_URL}/api/papers/mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds, valid }),
  }).then(handle<{ ok: boolean; updated: number; valid: boolean }>);
}

export function mergePapers(
  paperIds: number[]
): Promise<MergeResult> {
  return fetch(`${API_URL}/api/papers/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds }),
  }).then(handle<MergeResult>);
}

// ============================================================
// TOURNAMENTS — statistically grounded battles
//
// A tournament scores every pipeline on many leave-one-out citation
// queries and lets paired tests decide; the single-bout Arena winner
// is a consensus score with no ground truth (descriptive only).
// ============================================================

export type TournamentMetric = "ndcg" | "mrr" | "recall" | "hit";
export type TournamentOutcome = "winner" | "tie" | "inconclusive";

export interface TournamentInterval {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

export interface TournamentRankingRow extends TournamentInterval {
  pipeline: string;
}

export interface TournamentPair {
  a: string;
  b: string;
  mean_diff: number;
  lo: number;
  hi: number;
  p_value: number;
  p_adjusted: number;
  significant: boolean;
  /** Unpaired Cliff's delta (kept so older runs stay comparable). */
  cliffs_delta: number;
  /** P(first beats second on a query) - P(second beats first): the paired
   *  version, which the size label is read from. Absent on older runs. */
  paired_delta?: number;
  cohens_dz: number | null;
  /** "wilcoxon" (scores) or "mcnemar" (0/1 metrics such as hit rate). */
  test?: "wilcoxon" | "mcnemar";
  /** The effect size the labels are based on: Cliff's delta or Cohen's h. */
  effect_kind?: "delta" | "h";
  effect_size?: number;
  effect_label?: "negligible" | "very small" | "small" | "medium" | "large";
  cohens_h?: number;
  /** McNemar: queries where only the first / only the second pipeline hit. */
  a_only?: number;
  b_only?: number;
}

export interface TournamentVerdict {
  outcome: TournamentOutcome;
  reason: string;
  winner: string | null;
  n_queries: number;
  alpha?: number;
  ranking: TournamentRankingRow[];
  tie_groups: string[][];
  top_group?: string[];
  omnibus: {
    statistic: number;
    df: number;
    p_value: number;
    n_queries: number;
    mean_ranks: Record<string, number>;
  } | null;
  /** True for 0/1 metrics: McNemar's exact test and Cohen's h are used. */
  binary?: boolean;
  pairwise_test?: string;
  pairwise: TournamentPair[];
  required_n: number | null;
  /** Smallest gap between the top two this many queries can detect. */
  detectable_gap?: number | null;
  min_effect?: number;
  seed?: number;
  resamples?: number;
}

export interface TournamentResult {
  kind: string;
  label: string | null;
  primary_metric: TournamentMetric;
  primary_metric_name: string;
  top_k: number;
  recall_k: number;
  pipelines: string[];
  n_queries: number;
  dropped: { seed_paper_id: number; reason: string }[];
  min_refs: number;
  seed: number;
  verdict: TournamentVerdict;
  secondary: Record<string, Record<string, TournamentInterval>>;
  run_id: number | null;
}

export interface TournamentRunSummary {
  id: number;
  kind: string;
  label: string | null;
  created_at: string;
  primary_metric: TournamentMetric;
  top_k: number;
  n_queries: number;
  dropped_queries: number;
  pipelines: string[];
  outcome: TournamentOutcome | "pending";
  /** running / interrupted / error while unfinished, else done. */
  status?: TournamentJobState;
  winner_pipeline_id: string | null;
  corpus_size: number | null;
  corpus_version: string | null;
}

export interface TournamentParams {
  pipelines?: string[];
  topK?: number;
  nQueries?: number;
  minRefs?: number;
  primaryMetric?: TournamentMetric;
  seed?: number;
  label?: string;
  record?: boolean;
}

export function runTournament(
  params: TournamentParams = {},
): Promise<TournamentResult> {
  return fetch(`${API_URL}/api/evaluation/tournament`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pipelines: params.pipelines,
      top_k: params.topK ?? 10,
      n_queries: params.nQueries ?? 60,
      min_refs: params.minRefs ?? 3,
      primary_metric: params.primaryMetric ?? "ndcg",
      seed: params.seed ?? 0,
      label: params.label || undefined,
      record: params.record ?? true,
    }),
  }).then(handle<TournamentResult>);
}

export function getTournamentPool(minRefs = 3): Promise<{
  min_refs: number;
  available: number;
  required_n_for_0_05: number;
}> {
  return fetch(
    `${API_URL}/api/evaluation/tournament/pool?min_refs=${minRefs}`,
  ).then(
    handle<{
      min_refs: number;
      available: number;
      required_n_for_0_05: number;
    }>,
  );
}

export function getTournamentHistory(
  page = 1,
  pageSize = 10,
): Promise<{
  runs: TournamentRunSummary[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}> {
  const search = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  return fetch(`${API_URL}/api/evaluation/tournament/history?${search}`).then(
    handle<{
      runs: TournamentRunSummary[];
      total: number;
      page: number;
      page_size: number;
      pages: number;
    }>,
  );
}

export function getTournament(id: number): Promise<TournamentResult> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}`).then(
    handle<TournamentResult>,
  );
}

export type TournamentExportFormat = "csv" | "pairwise" | "json";

/** Fetch a stored tournament as a download (text + server filename). */
export async function exportTournament(
  id: number,
  format: TournamentExportFormat,
): Promise<{ filename: string; text: string }> {
  const response = await fetch(
    `${API_URL}/api/evaluation/tournament/${id}/export?format=${format}`,
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string" ? body.detail : "Export failed.",
    );
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  return {
    filename: match?.[1] ?? `tournament-${id}.${format === "json" ? "json" : "csv"}`,
    text: await response.text(),
  };
}

export interface LinkReferencesResult {
  ok: boolean;
  local_papers_with_doi: number;
  work_ids_found: number;
  rows_linked: number;
  failed_batches: number;
}

/** Match cached references to local papers (needed for tournaments). */
export function linkReferences(): Promise<LinkReferencesResult> {
  return fetch(`${API_URL}/api/citations/link-references`, {
    method: "POST",
  }).then(handle<LinkReferencesResult>);
}

export interface GatherLiteratureResult {
  references?: {
    papers_considered: number;
    papers_expanded: number;
    rows_added: number;
    failed_batches: number;
    not_found: number;
  };
  unresolved_references: number;
  considered: number;
  added: number;
  already_in_library: number;
  skipped_no_abstract: number;
  failed_batches: number;
  rows_linked: number;
  limit: number;
  index_rebuilt: boolean;
}

/** Live state of the background literature gather. */
export interface GatherJob {
  state: "idle" | "running" | "done" | "error";
  phase?: "references" | "linking" | "fetching" | "indexing" | "done";
  /** Reference-list expansion: batches and papers handled so far. */
  ref_batches_done?: number;
  ref_batches_total?: number;
  papers_expanded?: number;
  papers_considered?: number;
  ref_rows_added?: number;
  limit?: number;
  batches_done?: number;
  batches_total?: number;
  added?: number;
  rows_linked?: number;
  skipped_no_abstract?: number;
  already_in_library?: number;
  failed_batches?: number;
  /** Titles of the most recently added papers, newest last. */
  recent?: string[];
  elapsed?: number;
  summary?: GatherLiteratureResult;
  error?: string;
}

/**
 * Start importing the library's most-cited unresolved references from
 * OpenAlex as papers (so tournaments have ground truth), then rebuild
 * the index. Runs in the background: poll getGatherStatus().
 */
export function gatherLiterature(limit = 300): Promise<GatherJob> {
  return fetch(`${API_URL}/api/citations/gather-literature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit, rebuild_index: true }),
  }).then(handle<GatherJob>);
}

export function getGatherStatus(): Promise<GatherJob> {
  return fetch(`${API_URL}/api/citations/gather-literature/status`).then(
    handle<GatherJob>,
  );
}

// ============================================================
// SYNC — refresh paper metadata from Crossref, then rebuild the index
// ============================================================

export interface SyncJob {
  state: "idle" | "running" | "done" | "error";
  phase?: "metadata" | "indexing" | "done";
  /** Papers looked up so far / in total. */
  done?: number;
  total?: number;
  considered?: number;
  changed?: number;
  not_found?: number;
  failed?: number;
  /** How many papers had each field filled or upgraded. */
  fields?: Record<string, number>;
  elapsed?: number;
  summary?: {
    considered: number;
    changed: number;
    not_found: number;
    failed: number;
    fields: Record<string, number>;
    index_rebuilt: boolean;
  };
  error?: string;
}

/** Start a sync in the background; poll getSyncStatus(). */
export function startSync(force = false): Promise<SyncJob> {
  return fetch(`${API_URL}/api/papers/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force, rebuild_index: true }),
  }).then(handle<SyncJob>);
}

export function getSyncStatus(): Promise<SyncJob> {
  return fetch(`${API_URL}/api/papers/sync/status`).then(handle<SyncJob>);
}

// ============================================================
// DURABLE TOURNAMENTS
//
// A tournament takes minutes, so it runs as a job on the server and is
// saved query by query. The client starts it, polls its status, and can
// disconnect (sleep, reload, closed tab) and re-attach: nothing about
// the run depends on the browser.
// ============================================================

export type TournamentJobState = "running" | "interrupted" | "error" | "done";

export interface TournamentRunStatus {
  run_id: number;
  status: TournamentJobState;
  label: string | null;
  pipelines: string[];
  primary_metric: TournamentMetric;
  top_k: number;
  /** Queries finished (scored or dropped) and chosen for this run. */
  done: number;
  total: number;
  dropped: number;
  /** Time actually spent scoring (a sleep is not counted). */
  busy_seconds: number;
  seconds_per_query: number | null;
  eta_seconds: number | null;
  /** The query being scored right now. */
  current: { title: string; position: number } | null;
  /** Mean of the primary metric per pipeline so far (provisional). */
  partial_means: Record<string, number>;
  outcome: TournamentOutcome | "pending" | null;
  winner_pipeline_id: string | null;
  error: string | null;
  created_at: string;
}

export function startTournament(
  params: TournamentParams = {},
): Promise<TournamentRunStatus> {
  return fetch(`${API_URL}/api/evaluation/tournament/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pipelines: params.pipelines,
      top_k: params.topK ?? 10,
      n_queries: params.nQueries ?? 60,
      min_refs: params.minRefs ?? 3,
      primary_metric: params.primaryMetric ?? "ndcg",
      seed: params.seed ?? 0,
      label: params.label || undefined,
    }),
  }).then(handle<TournamentRunStatus>);
}

export function getTournamentStatus(id: number): Promise<TournamentRunStatus> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}/status`).then(
    handle<TournamentRunStatus>,
  );
}

/** The newest unfinished run, so a reloaded page can re-attach to it. */
export function getActiveTournament(): Promise<{
  run: TournamentRunStatus | null;
}> {
  return fetch(`${API_URL}/api/evaluation/tournament/active`).then(
    handle<{ run: TournamentRunStatus | null }>,
  );
}

export function resumeTournament(id: number): Promise<TournamentRunStatus> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}/resume`, {
    method: "POST",
  }).then(handle<TournamentRunStatus>);
}

export function stopTournament(id: number): Promise<{ stopping: boolean }> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}/stop`, {
    method: "POST",
  }).then(handle<{ stopping: boolean }>);
}

export function discardTournament(id: number): Promise<{ status: string }> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}`, {
    method: "DELETE",
  }).then(handle<{ status: string }>);
}


/** Recompute a finished run's statistics from its stored scores. */
export function reanalyzeTournament(id: number): Promise<TournamentResult> {
  return fetch(`${API_URL}/api/evaluation/tournament/${id}/reanalyze`, {
    method: "POST",
  }).then(handle<TournamentResult>);
}

// ============================================================
// BATTLE JUDGING — quality, not agreement.

export function judgeBattle(params: {
  battleId?: number;
  lists?: Record<string, number[]>;
  topK?: number;
  relevant: number[];
}): Promise<BattleJudgement> {
  return fetch(`${API_URL}/api/evaluation/judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      battle_id: params.battleId ?? null,
      lists: params.lists ?? null,
      top_k: params.topK ?? null,
      relevant: params.relevant,
    }),
  }).then(handle<BattleJudgement>);
}

export interface JudgedBoard {
  n_judged: number;
  n_skipped_nothing_relevant: number;
  by_basis: Record<string, number>;
  min_for_verdict: number;
  pipelines: {
    pipeline: string;
    mean: number;
    lo: number;
    hi: number;
    n: number;
    hit_rate: number;
  }[];
  verdict: {
    outcome: string;
    winner: string | null;
    tie_groups: string[][];
    reason?: string;
  } | null;
}

export function getJudgedBattles(): Promise<JudgedBoard> {
  return fetch(`${API_URL}/api/evaluation/battles/judged`).then(
    handle<JudgedBoard>,
  );
}

// ============================================================
// BATTLE SERIES — many queries under one label, one board.

export interface CleanedQueries {
  queries: string[];
  duplicates_dropped: number;
  truncated: number;
  over_limit: number;
  limit: number;
}

export function cleanSeriesQueries(text: string): Promise<CleanedQueries> {
  return fetch(`${API_URL}/api/evaluation/battle-series/queries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then(handle<CleanedQueries>);
}

export interface SeriesSeedPaper {
  id: number;
  title: string;
  year: number | null;
  n_refs: number;
}

export function sampleSeriesSeeds(
  n: number,
  seed: number,
): Promise<{ eligible: number; papers: SeriesSeedPaper[] }> {
  const search = new URLSearchParams({ n: String(n), seed: String(seed) });

  return fetch(`${API_URL}/api/evaluation/battle-series/sample?${search}`).then(
    handle<{ eligible: number; papers: SeriesSeedPaper[] }>,
  );
}

export interface SeriesLabel {
  label: string;
  battles: number;
  last: string | null;
}

export function getSeriesLabels(): Promise<SeriesLabel[]> {
  return fetch(`${API_URL}/api/evaluation/battle-series/labels`).then(
    handle<SeriesLabel[]>,
  );
}

export interface SeriesSummary {
  label: string;
  n_battles: number;
  n_queries: number;
  decisive: number;
  too_close: number;
  unscored: number;
  agreement: {
    pipeline: string;
    mean: number;
    lo: number;
    hi: number;
    n: number;
    decisive_wins: number;
  }[];
  judged: JudgedBoard;
}

export function getSeriesSummary(label: string): Promise<SeriesSummary> {
  const search = new URLSearchParams({ label });

  return fetch(`${API_URL}/api/evaluation/battle-series/summary?${search}`).then(
    handle<SeriesSummary>,
  );
}

// ============================================================
// RECIPE SWEEP — the Lab's blend explorer.

export interface SweepWeights {
  tfidf: number;
  sbert: number;
  metadata: number;
}

export interface SweepCell {
  weights: SweepWeights;
  mean: number;
}

export interface SweepComparison {
  preset: string;
  preset_mean: number;
  mean_diff: number;
  lo: number;
  hi: number;
  clear: boolean;
  worse: boolean;
}

export interface SweepHeldout {
  n_select: number;
  n_confirm: number;
  chosen: SweepWeights;
  chosen_select_mean: number;
  chosen_confirm: { mean: number; lo: number; hi: number; n: number };
  comparisons: SweepComparison[];
  strongest_preset: string;
  outcome: "better" | "worse" | "no_difference";
}

export interface SweepResult {
  k: number;
  step: number;
  n_queries: number;
  skipped: number;
  metric: string;
  grid: SweepCell[];
  top: SweepCell[];
  preset_means?: Record<string, number>;
  heldout: SweepHeldout | null;
  reason?: string | null;
}

export type SweepEvent =
  | { event: "start"; n_queries: number; grid_size: number }
  | { event: "progress"; done: number; total: number }
  | { event: "done"; result: SweepResult }
  | { event: "error"; detail: string };

export async function runRecipeSweep(
  params: { nQueries: number; k: number; step: number; minRefs: number; seed: number },
  onEvent: (event: SweepEvent) => void,
  signal?: AbortSignal,
): Promise<SweepResult> {
  const res = await fetch(`${API_URL}/api/evaluation/recipe-sweep`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      n_queries: params.nQueries,
      k: params.k,
      step: params.step,
      min_refs: params.minRefs,
      seed: params.seed,
    }),
  });

  if (!res.ok || !res.body) {
    return handle<SweepResult>(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: SweepResult | null = null;

  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as SweepEvent;

    if (event.event === "error") throw new Error(event.detail);
    if (event.event === "done") final = event.result;
    onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";
    lines.forEach(consume);
  }

  consume(buffer);

  if (!final) throw new Error("The sweep ended before it finished.");

  return final;
}

// ============================================================
// LIBRARY FOLDERS — organise saved papers (Zotero / Mendeley style).

export interface LibraryFolder {
  id: number;
  name: string;
  parent_id: number | null;
  /** Papers placed directly in this folder (not its subfolders). */
  paper_count: number;
}

export interface LibraryFolderOverview {
  folders: LibraryFolder[];
  /** paper id (as a string key) -> the folders it is in. */
  memberships: Record<string, number[]>;
  /** Saved papers that are in no folder. */
  unfiled: number;
  max_depth: number;
}

export function getLibraryFolders(): Promise<LibraryFolderOverview> {
  return fetch(`${API_URL}/api/library/folders`).then(handle<LibraryFolderOverview>);
}

export function createLibraryFolder(
  name: string,
  parentId: number | null = null,
): Promise<{ id: number; name: string; parent_id: number | null }> {
  return fetch(`${API_URL}/api/library/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_id: parentId }),
  }).then(handle<{ id: number; name: string; parent_id: number | null }>);
}

/** Rename and/or move; pass `parentId: null` to move to the top level. */
export function updateLibraryFolder(
  id: number,
  changes: { name?: string; parentId?: number | null },
): Promise<{ id: number; name: string; parent_id: number | null }> {
  const body: Record<string, unknown> = {};

  if (changes.name !== undefined) body.name = changes.name;
  if (changes.parentId !== undefined) body.parent_id = changes.parentId;

  return fetch(`${API_URL}/api/library/folders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(handle<{ id: number; name: string; parent_id: number | null }>);
}

export function deleteLibraryFolder(id: number): Promise<{ status: string; folders_removed: number }> {
  return fetch(`${API_URL}/api/library/folders/${id}`, { method: "DELETE" }).then(
    handle<{ status: string; folders_removed: number }>,
  );
}

export function setLibraryFolderPapers(
  id: number,
  paperIds: number[],
  action: "add" | "remove",
): Promise<{ changed: number; skipped: number[] }> {
  return fetch(`${API_URL}/api/library/folders/${id}/papers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds, action }),
  }).then(handle<{ changed: number; skipped: number[] }>);
}

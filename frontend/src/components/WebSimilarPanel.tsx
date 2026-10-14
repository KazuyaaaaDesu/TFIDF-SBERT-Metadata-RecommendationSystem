/**
 * WEB SIMILAR PANEL — the Similar tab for a web result.
 *
 * A web result is not a saved paper, so the saved-paper workbench
 * (graph over the repository + cached citations) does not apply.
 * Two scopes instead:
 *   IN YOUR LIBRARY  the repository papers most similar to the web
 *                    paper, ranked by the active pipeline from a
 *                    text query built out of its title + abstract.
 *   ON THE WEB       its OpenAlex prior (references) and
 *                    derivative (citers) works, resolved by DOI,
 *                    else title.
 * Requests are aborted when the selection or settings change.
 */

import { useEffect, useState } from "react";
import { Library, Globe } from "lucide-react";

import {
  getRecommendations,
  getWebResultConnections,
  type DialWeights,
  type Paper,
  type SearchResult,
  type WebResultConnections,
  type WebSearchResult,
} from "../api";
import ResponsiveLabel from "./ResponsiveLabel";
import { EmptyState } from "./ui";
import WebWorksList from "./WebWorksList";

type Scope = "library" | "web";
type Side = "prior" | "derivative";

/* Which providers the web neighborhood is drawn from. OpenAlex is
   always the lead and cannot be switched off -- it is the only one that
   returns each neighbor's own reference list, which the graph's edge
   structure is built from. The rest are additive, so the default asks
   for the widest neighborhood and the choice is remembered per browser
   rather than re-picked per selection. */
const OPTIONAL_SOURCES = [
  ["semantic_scholar", "Semantic Scholar"],
  ["crossref", "Crossref"],
  ["open_citations", "OpenCitations"],
  ["europe_pmc", "Europe PMC"],
] as const;

const SOURCE_KEY = "paperrec_web_conn_sources";

type SourceState = Record<string, boolean>;

function readSources(): SourceState {
  try {
    const raw = window.localStorage.getItem(SOURCE_KEY);

    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SourceState>;

      return {
        semantic_scholar: parsed.semantic_scholar !== false,
        crossref: parsed.crossref !== false,
        open_citations: parsed.open_citations !== false,
        europe_pmc: parsed.europe_pmc !== false,
      };
    }
  } catch {
    // fall through to the wide default
  }

  return {
    semantic_scholar: true,
    crossref: true,
    open_citations: true,
    europe_pmc: true,
  };
}

const QUERY_CHARS = 1500;

/** Text query that stands in for the web paper in the corpus. */
export function webResultQuery(result: WebSearchResult): string {
  return [result.title, result.abstract ?? ""]
    .join(". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, QUERY_CHARS);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const SEG =
  "flex flex-1 items-center justify-center rounded border-[3px] border-gray-900 px-2 py-1.5 text-sm font-semibold transition-colors pixel-ease";

export default function WebSimilarPanel({
  result,
  pipeline,
  pipelineLabel,
  weights,
  topK,
  onSelectPaper,
}: {
  result: WebSearchResult;
  pipeline: string;
  pipelineLabel: string;
  weights?: DialWeights;
  topK: number;
  /** Open a repository paper in the inspector. */
  onSelectPaper: (paper: Paper) => void;
}) {
  const [scope, setScope] = useState<Scope>("library");
  const [side, setSide] = useState<Side>("prior");

  const [library, setLibrary] = useState<SearchResult[] | null>(null);
  const [libraryError, setLibraryError] = useState("");

  const [web, setWeb] = useState<WebResultConnections | null>(null);
  const [webError, setWebError] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sourceState, setSourceState] = useState<SourceState>(readSources);

  /* Only the enabled extras go on the wire; the backend ignores unknown
     names, so this never has to be escaped or validated here. */
  const sourceQuery = OPTIONAL_SOURCES
    .filter(([id]) => sourceState[id])
    .map(([id]) => id)
    .join(",");

  const query = webResultQuery(result);
  const weightsKey = weights
    ? `${weights.tfidf}/${weights.sbert}/${weights.metadata}`
    : "";

  function toggleSource(id: string, on: boolean) {
    setSourceState((current) => {
      const next = { ...current, [id]: on };

      try {
        window.localStorage.setItem(SOURCE_KEY, JSON.stringify(next));
      } catch {
        // best-effort: a browser that refuses storage still gets the
        // narrower neighborhood for this session.
      }

      return next;
    });
  }

  useEffect(() => {
    if (scope !== "library") return;
    if (!query) {
      setLibrary([]);
      return;
    }

    const controller = new AbortController();
    setLibrary(null);
    setLibraryError("");

    getRecommendations(
      {
        pipeline,
        query,
        topK: Math.min(topK, 25),
        ...(weights ? { weights } : {}),
      },
      controller.signal
    )
      .then((rows) => setLibrary(rows))
      .catch((error) => {
        if (!isAbort(error)) setLibraryError(errorText(error));
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, query, pipeline, topK, weightsKey]);

  useEffect(() => {
    if (scope !== "web") return;

    const controller = new AbortController();
    setWeb(null);
    setWebError("");
    setActiveKey(null);

    getWebResultConnections(
      { doi: result.doi, title: result.title, sources: sourceQuery },
      controller.signal
    )
      .then((data) => setWeb(data))
      .catch((error) => {
        if (!isAbort(error)) setWebError(errorText(error));
      });

    return () => controller.abort();
  }, [scope, result.doi, result.title, sourceQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-web-similar>
      <div
        role="tablist"
        aria-label="Similar papers scope"
        className="flex shrink-0 gap-0.5 border-b-[3px] border-gray-900 bg-canvas p-2"
      >
        {(
          [
            ["library", "In your library", Library],
            ["web", "On the web", Globe],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={scope === id}
            title={label}
            onClick={() => setScope(id)}
            className={`${SEG} ${
              scope === id
                ? "bg-accent text-onAccent"
                : "bg-surface text-ink hover:bg-accentSoft"
            }`}
          >
            <ResponsiveLabel icon={icon}>{label}</ResponsiveLabel>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {scope === "library" ? (
          libraryError ? (
            <div className="p-4">
              <EmptyState
                title="Couldn't rank your library."
                description={libraryError}
              />
            </div>
          ) : library === null ? (
            <p className="animate-blink p-4 text-sm font-bold text-muted">
              Ranking your library with {pipelineLabel}…
            </p>
          ) : library.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing similar in your library."
                description="No repository paper matched this result's title and abstract."
              />
            </div>
          ) : (
            <div className="p-4">
              <p className="text-sm leading-6 text-muted">
                Repository papers most similar to this result, ranked by{" "}
                {pipelineLabel} from its title and abstract. Select one to
                open it.
              </p>
              <ol className="mt-3 grid gap-2">
                {library.map((row, index) => (
                  <li key={row.paper.id}>
                    <button
                      type="button"
                      data-library-row
                      onClick={() => onSelectPaper(row.paper)}
                      className="flex w-full items-baseline gap-3 rounded border-[3px] border-gray-900 bg-white p-2.5 text-left transition-colors pixel-ease hover:bg-accentSoft"
                    >
                      <span className="w-5 shrink-0 font-mono text-xs font-bold text-muted">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-sm font-bold leading-5 text-ink">
                        {row.paper.title}
                      </span>
                      <span className="shrink-0 text-right font-mono text-xs text-muted">
                        {row.paper.publication_year ?? "—"}
                        <span className="ml-2 font-bold text-ink">
                          {row.score.toFixed(3)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )
        ) : webError ? (
          <div className="p-4">
            <EmptyState
              title="Couldn't reach the citation sources."
              description={webError}
            />
          </div>
        ) : web === null ? (
          <p className="animate-blink p-4 text-sm font-bold text-muted">
            Looking up related works on OpenAlex and Semantic Scholar…
          </p>
        ) : !web.resolved ||
          (web.prior_works.length === 0 &&
            web.derivative_works.length === 0) ? (
          <div className="p-4">
            <EmptyState
              title="No related works found for this result"
              description="No provider could match it by DOI or title, or none of them lists references or citers for it."
            />
          </div>
        ) : (
          <>
            {/* Provider switches. OpenAlex is fixed on because it is
                the only source that supplies the graph's edge
                structure, so it is named rather than offered. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-900/20 px-4 py-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
                Sources
              </span>

              <span className="flex items-center gap-1.5 rounded border-[2px] border-gray-900 bg-canvas px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-[#2f9e44]" />
                OpenAlex
              </span>

              {OPTIONAL_SOURCES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={sourceState[id]}
                  onClick={() => toggleSource(id, !sourceState[id])}
                  title={`${sourceState[id] ? "Stop including" : "Also include"} ${label} works`}
                  className={`flex items-center gap-1.5 rounded border-[2px] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
                    sourceState[id]
                      ? "border-gray-900 bg-canvas text-ink"
                      : "border-dashed border-gray-900 text-muted hover:bg-accentSoft"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      sourceState[id] ? "bg-[#2f9e44]" : "bg-gray-400"
                    }`}
                  />
                  {label}
                </button>
              ))}
            </div>

            <div
              role="tablist"
              aria-label="Related works"
              className="flex gap-0.5 p-2 pb-0"
            >
              {(
                [
                  ["prior", `Prior works (${web.prior_works.length})`],
                  ["derivative", `Derivative works (${web.derivative_works.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={side === id}
                  onClick={() => setSide(id)}
                  className={`${SEG} ${
                    side === id
                      ? "bg-accent text-onAccent"
                      : "bg-surface text-ink hover:bg-accentSoft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <WebWorksList
              side={side}
              works={side === "prior" ? web.prior_works : web.derivative_works}
              activeKey={activeKey}
              onActiveKey={setActiveKey}
              connections={web}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * WEB WORKS LIST — the Prior works / Derivative works tabs for the
 * WEB scope: the references (prior) and citers (derivative) of the
 * center paper, unioned across OpenAlex, Semantic Scholar and Crossref.
 */

import type { WebConnections, WebWork } from "../api";
import { downloadWebWorksCsv } from "../utils/worksCsv";
import {
  answeredSources,
  provenanceLabel,
  sourceLabel,
  unavailableNote,
  workUrl,
} from "../utils/webWorkSources";

interface WebWorksListProps {
  side: "prior" | "derivative";
  works: WebWork[];
  activeKey: string | null;
  onActiveKey: (key: string | null) => void;
  /** Omit where there is no graph to jump to. */
  onShowInGraph?: () => void;
  /** The payload these works came from, for the provenance caption. */
  connections?: Pick<WebConnections, "sources" | "sources_skipped"> | null;
  widened?: boolean;
}

const DESCRIPTIONS: Record<"prior" | "derivative", string> = {
  prior:
    "Works this paper cites, most-cited first — the seminal background " +
    "of the field. Selecting one highlights its node in the graph.",
  derivative:
    "Works citing this paper, most-cited first — surveys and recent " +
    "follow-ups. Selecting one highlights its node in the graph.",
};

function letterLabel(index: number): string {
  return String.fromCharCode(97 + (index % 26));
}

export default function WebWorksList({
  side,
  works,
  activeKey,
  onActiveKey,
  onShowInGraph,
  connections,
  widened = false,
}: WebWorksListProps) {
  const title = side === "prior" ? "Prior works" : "Derivative works";
  const providers = answeredSources(connections);
  const note = unavailableNote(connections);

  return (
    <div className="p-4" data-web-works={side}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="max-w-3xl text-sm leading-6 text-muted">
            {onShowInGraph
              ? DESCRIPTIONS[side]
              : DESCRIPTIONS[side].replace(
                  " Selecting one highlights its node in the graph.",
                  ""
                )}
          </p>

          {/* Provenance: the list is a union, so say who answered
              rather than implying one graph produced it all. */}
          <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
            {providers}
          </p>

          {/* A provider that was down is worth saying: the list is
              shorter than the user would otherwise expect. */}
          {note && (
            <p className="mt-1 text-xs text-muted">{note}</p>
          )}
        </div>

        {works.length > 0 && (
          <button
            type="button"
            onClick={() => downloadWebWorksCsv(title, works)}
            className="shrink-0 rounded border-[3px] border-gray-900 bg-white px-3 py-1.5 font-mono text-xs font-bold text-ink transition-colors pixel-ease hover:bg-accent hover:text-onAccent"
          >
            Download
          </button>
        )}
      </div>

      {works.length === 0 ? (
        <p className="mt-4 rounded border-[3px] border-dashed border-gray-900 bg-canvas px-4 py-6 text-center text-sm text-muted">
          {providers} returned no {side === "prior" ? "references" : "citers"}
          {" "}for this work.
        </p>
      ) : (
        <ul
          className={`mt-4 grid gap-3 ${
            widened ? "lg:grid-cols-2" : ""
          }`}
        >
          {works.map((work, index) => {
            const isActive = activeKey === work.work_id;

            return (
              <li
                key={work.work_id}
                data-work-row
                className={`rounded border-[3px] p-3 transition-colors ${
                  isActive
                    ? "border-gray-900 bg-accent text-onAccent"
                    : "border-gray-900 bg-white"
                }`}
              >
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() =>
                    onActiveKey(isActive ? null : work.work_id)
                  }
                  className="flex w-full items-baseline gap-3 text-left"
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[2px] font-mono text-xs font-bold ${
                      isActive
                        ? "border-onAccent bg-white/20 text-onAccent"
                        : "border-gray-900 bg-canvas text-ink"
                    }`}
                  >
                    {side === "prior" ? index + 1 : letterLabel(index)}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span
                      className={`block break-words text-sm font-bold leading-5 ${
                        isActive ? "text-onAccent" : "text-ink"
                      }`}
                    >
                      {work.title ?? work.work_id}
                    </span>

                    <span
                      className={`mt-1 block text-xs ${
                        isActive ? "text-onAccent" : "text-muted"
                      }`}
                    >
                      {work.author ?? "Unknown author"}
                      {work.publication_year
                        ? `, ${work.publication_year}`
                        : ""}
                      {work.cited_by_count !== null
                        ? ` · ${work.cited_by_count} citations`
                        : ""}
                    </span>

                    {/* A row only earns a chip when it is not simply
                        OpenAlex's: either a second graph corroborated
                        it, or it came from one graph alone. */}
                    {(() => {
                      const provenance = provenanceLabel(work);

                      if (!provenance) return null;

                      return (
                        <span
                          className={`mt-1 inline-block rounded border-[2px] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] ${
                            isActive
                              ? "border-onAccent text-onAccent"
                              : "border-gray-900 bg-canvas text-muted"
                          }`}
                        >
                          {provenance}
                        </span>
                      );
                    })()}
                  </span>
                </button>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {work.doi && (
                    <a
                      href={`https://doi.org/${work.doi}`}
                      target="_blank"
                      rel="noreferrer"
                      className={`break-all text-xs underline ${
                        isActive ? "text-onAccent" : "text-accent"
                      }`}
                    >
                      doi.org/{work.doi}
                    </a>
                  )}

                  {/* One honest link per row: the old hardcoded
                      openalex.org link 404'd for every row the other
                      providers contributed. */}
                  {!work.doi &&
                    (() => {
                      const url = workUrl(work);

                      if (!url) return null;

                      return (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className={`text-xs underline ${
                            isActive ? "text-onAccent" : "text-accent"
                          }`}
                        >
                          {sourceLabel(work.sources?.[0] ?? "openalex")}
                        </a>
                      );
                    })()}

                  {onShowInGraph && (<button
                    type="button"
                    onClick={onShowInGraph}
                    className={`ml-auto font-mono text-[10px] font-bold uppercase tracking-[0.12em] underline ${
                      isActive ? "text-onAccent" : "text-muted hover:text-accent"
                    }`}
                  >
                    Show in graph
                  </button>)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

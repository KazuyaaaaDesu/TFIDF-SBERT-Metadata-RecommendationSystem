/**
 * INSPECTOR BODIES — the Details / Notes / PDF tab bodies of the
 * repository inspector, shared by the inline right pane and the
 * InspectorPopup so there is one implementation of each.
 */

import { getPaperPdfUrl } from "../api";
import type { Paper } from "../api";
import FindPdfPanel from "./FindPdfPanel";
import { Check } from "./retro/PixelIcons";
import { Button } from "./ui";

const SIGNAL_FIELDS = ["title", "abstract", "keywords", "publication_year"] as const;

function categoryOf(paper: Paper) {
  const parts = paper.subject_category?.split(":", 2).map((p) => p.trim());
  return { subject: parts?.[0] ?? "", category: parts?.[1] ?? "" };
}

export function hasStoredPdf(paper: Paper | null): boolean {
  return paper?.stored_path?.toLowerCase().endsWith(".pdf") ?? false;
}

const ACTION_BTN =
  "inline-flex h-9 items-center justify-center rounded border-[3px] border-gray-900 bg-white px-3 text-sm font-semibold text-ink hover:bg-accent hover:text-onAccent transition-colors";

export function PaperDetailsBody({
  paper,
  isSelectingSeed,
  saved,
  onUseSeed,
  onSave,
  onView,
  onDelete,
}: {
  paper: Paper;
  isSelectingSeed: boolean;
  saved: boolean;
  onUseSeed: () => void;
  onSave: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const { subject: s, category: c } = categoryOf(paper);
  return (
    <div className="p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {s && (
          <span className="rounded border-[2px] border-gray-900 bg-gray-900 px-1.5 py-0.5 text-xs font-bold text-white">
            {s}
          </span>
        )}
        {c && <span className="text-muted">{c}</span>}
        <span className="text-muted">·</span>
        <span className="text-muted">{paper.publication_year ?? "—"}</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{paper.document_type ?? "Document"}</span>
      </div>

      <h2 className="text-base font-bold leading-6 text-ink">
        {paper.title || "Untitled paper"}
      </h2>
      <p className="mt-1 text-xs text-muted">
        {paper.author ?? "Unknown author"}
        {paper.citation_count != null ? ` · ${paper.citation_count} cited` : ""}
      </p>

      {paper.abstract && (
        <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-muted">
          {paper.abstract}
        </p>
      )}

      <div className="mt-4 rounded border-[2px] border-gray-900 bg-canvas p-3">
        <p className="mb-2 text-xs font-bold text-ink">Recommendation signals</p>
        <div className="grid grid-cols-2 gap-1.5">
          {SIGNAL_FIELDS.map((field) => {
            const filled = paper[field] != null && paper[field] !== "";
            return (
              <span key={field} className="flex items-center gap-1.5 text-xs text-muted">
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border-[2px] ${
                    filled ? "border-gray-900 bg-ink" : "border-gray-900 bg-white"
                  }`}
                >
                  {filled && <Check className="h-2 w-2 text-onInk" />}
                </span>
                {field === "publication_year"
                  ? "Year"
                  : field[0].toUpperCase() + field.slice(1)}
              </span>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          {paper.is_valid_for_recommendation
            ? "Valid for recommendation."
            : `Missing: ${paper.missing_fields ?? "some fields"}.`}
        </p>
      </div>

      {paper.doi && (
        <p className="mt-3 break-all text-xs text-muted">
          <span className="font-bold text-ink">DOI:</span> {paper.doi}
        </p>
      )}

      {paper.keywords && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {paper.keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
            .slice(0, 6)
            .map((k) => (
              <span
                key={k}
                className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 font-mono text-xs text-ink"
              >
                {k}
              </span>
            ))}
        </div>
      )}

      <p className="mt-3 break-all font-mono text-xs text-muted">
        <span className="font-bold text-ink">File:</span> {paper.stored_path || "No file"}
      </p>

      <div className="mt-5 flex flex-wrap gap-2 border-t-[3px] border-gray-900 pt-4">
        {isSelectingSeed ? (
          <Button
            variant="primary"
            type="button"
            disabled={!paper.is_valid_for_recommendation}
            onClick={onUseSeed}
          >
            Use as seed
          </Button>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={onSave} disabled={saved}>
              {saved ? "Saved" : "Save paper"}
            </Button>
            <Button variant="quiet" type="button" onClick={onView}>
              View
            </Button>
            <button type="button" onClick={onDelete} className={ACTION_BTN}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function PaperNotesBody({
  paperId,
  value,
  onChange,
}: {
  paperId: number;
  value: string;
  onChange: (id: number, text: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <p className="mb-2 text-xs font-bold text-muted">Notes on this paper</p>
      <textarea
        value={value}
        onChange={(e) => onChange(paperId, e.target.value)}
        placeholder="Write annotations, quotes, or reading notes here…"
        className="ui-input min-h-40 flex-1 resize-y font-mono text-xs leading-5"
      />
      <p className="mt-2 text-xs text-muted">Saved automatically in this browser.</p>
    </div>
  );
}

export function PaperPdfBody({
  paper,
  onPreview,
  onDeletePdf,
  onAttached,
}: {
  paper: Paper;
  /** null = the stored PDF. */
  onPreview: (url: string | null) => void;
  onDeletePdf: () => void;
  onAttached: (updated: Paper) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      {hasStoredPdf(paper) ? (
        <>
          <button
            type="button"
            onClick={() => onPreview(null)}
            title="Preview in the pop-up viewer"
            className="block w-full overflow-hidden rounded border-[2px] border-gray-900 bg-canvas transition-colors pixel-ease hover:border-gray-600"
          >
            <iframe
              src={getPaperPdfUrl(paper.id)}
              title={paper.title || "Paper PDF"}
              className="pointer-events-none h-72 w-full border-0"
            />
          </button>

          <p className="mt-3 break-all font-mono text-xs text-muted">
            <span className="font-bold text-ink">File:</span> {paper.stored_path}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => onPreview(null)}>
              Preview in viewer
            </Button>
            <a
              href={getPaperPdfUrl(paper.id)}
              target="_blank"
              rel="noreferrer"
              className={ACTION_BTN}
            >
              Open full PDF ↗
            </a>
            <button type="button" onClick={onDeletePdf} className={ACTION_BTN}>
              Delete PDF
            </button>
          </div>

          <p className="mt-3 text-xs leading-5 text-muted">
            Deleting the PDF keeps the bibliographic record. The PDF you can fetch
            a different open-access copy here afterwards.
          </p>
        </>
      ) : (
        <>
          <p className="mb-3 text-xs leading-5 text-muted">
            No PDF attached to this paper yet. Search the open-access sources
            below, or delete and replace an existing copy.
          </p>
          <FindPdfPanel
            key={paper.id}
            paper={paper}
            onPreview={(url) => onPreview(url)}
            onAttached={onAttached}
          />
        </>
      )}
    </div>
  );
}

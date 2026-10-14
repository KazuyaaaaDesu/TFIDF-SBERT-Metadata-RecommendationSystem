import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getPaperPdfUrl,
  updatePaper,
} from "../api";
import type { AuthorPart, Paper } from "../api";
import AuthorsEditor from "./AuthorsEditor";
import { paperAuthors } from "../utils/authorNames.ts";
import FindPdfPanel from "./FindPdfPanel";
import MathText from "./MathText";
import {
  CITATION_FORMATS,
  downloadCitation,
} from "../utils/exportCitations";
import { Button } from "./ui";

interface PaperViewerModalProps {
  paper: Paper | null;
  open: boolean;
  onClose: () => void;
  canEdit?: boolean;
  onPaperUpdated?: (paper: Paper) => void;
  /** Optional external PDF to preview instead of the stored file. */
  previewUrl?: string | null;
}

interface PaperForm {
  title: string;
  author: string;
  abstract: string;
  keywords: string;
  publication_year: string;
  doi: string;
  subject_category: string;
  document_type: string;
  citation_count: string;
}

/* ============================================================
   GITINGEST DESIGN LANGUAGE
   Cream canvas #FFFDF8 · 3px gray-900 outlines · 4px radius
   Depth = a solid offset slab behind the dialog (8px, offset-lg)
   Orange = the one primary action · errors are plain ink text
   ============================================================ */

/* Compact version of the url-input (pale-blue field, chunky outline).
   No slab: nine stacked slabs in a sidebar would be noise, and the
   slab is reserved for the one dominant input on a page. */
const INPUT =
  "block w-full rounded border-[3px] border-gray-900 bg-field px-3 py-2 " +
  "text-sm font-medium text-gray-900 placeholder-gray-600 " +
  "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-gray-900 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

// Fields shown in the metadata panel, in display order.
interface FieldConfig {
  key: keyof PaperForm;
  label: string;
  control: "input" | "textarea";
  type?: "number";
  rows?: number;
  emptyText?: string;
  /** whitespace-pre-wrap + relaxed leading, for long prose */
  prose?: boolean;
  breakAll?: boolean;
}

const FIELDS: FieldConfig[] = [
  { key: "title", label: "Title", control: "input" },
  { key: "author", label: "Author", control: "input" },
  { key: "publication_year", label: "Publication year", control: "input", type: "number" },
  {
    key: "abstract",
    label: "Abstract",
    control: "textarea",
    rows: 7,
    emptyText: "No abstract available.",
    prose: true,
  },
  { key: "keywords", label: "Keywords", control: "textarea", rows: 3 },
  { key: "doi", label: "DOI", control: "input", breakAll: true },
  { key: "subject_category", label: "Subject category", control: "input" },
  { key: "document_type", label: "Document type", control: "input" },
  { key: "citation_count", label: "Citation count", control: "input", type: "number" },
];

function formFromPaper(paper: Paper): PaperForm {
  return {
    title: paper.title ?? "",
    author: paper.author ?? "",
    abstract: paper.abstract ?? "",
    keywords: paper.keywords ?? "",
    publication_year:
      paper.publication_year != null ? String(paper.publication_year) : "",
    doi: paper.doi ?? "",
    subject_category: paper.subject_category ?? "",
    document_type: paper.document_type ?? "",
    citation_count:
      paper.citation_count != null ? String(paper.citation_count) : "",
  };
}

export default function PaperViewerModal({
  paper,
  open,
  onClose,
  canEdit = false,
  onPaperUpdated,
  previewUrl = null,
}: PaperViewerModalProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPaper, setCurrentPaper] = useState<Paper | null>(paper);
  /* Authors are edited as given / middle / family parts, not one string. */
  const [authors, setAuthors] = useState<AuthorPart[]>([]);

  const [form, setForm] = useState<PaperForm>({
    title: "",
    author: "",
    abstract: "",
    keywords: "",
    publication_year: "",
    doi: "",
    subject_category: "",
    document_type: "",
    citation_count: "",
  });

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /* Export dropdown state. */
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        exportRef.current &&
        !exportRef.current.contains(event.target as Node)
      ) {
        setExportOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [exportOpen]);

  useEffect(() => {
    setCurrentPaper(paper);

    if (!paper) {
      return;
    }

    setForm(formFromPaper(paper));
    setAuthors(paperAuthors(paper));
    setEditing(false);
    setError(null);
  }, [paper]);

  // --------------------------------------------------------
  // FOCUS MANAGEMENT
  // When the viewer opens (or switches to another paper),
  // move focus into the dialog so keyboard input lands in the
  // pop-up instead of the page behind it. Focus is returned
  // to whatever was focused before (e.g. the View button).
  // --------------------------------------------------------

  useEffect(() => {
    if (!open || !currentPaper) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      previouslyFocused.current = document.activeElement;
    }

    const frame = requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [open, currentPaper?.id]);

  useEffect(() => {
    if (open) {
      return;
    }

    previouslyFocused.current?.focus();
    previouslyFocused.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !currentPaper) {
    return null;
  }

  const pdfUrl = previewUrl ?? getPaperPdfUrl(currentPaper.id);  // An external preview URL always renders in the frame; otherwise
  // only papers with a stored .pdf do.
  const isPdf =
    previewUrl != null ||
    (currentPaper.stored_path?.toLowerCase().endsWith(".pdf") ?? false);

  const handleChange = (field: keyof PaperForm, value: string) => {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const updatedPaper = await updatePaper(currentPaper.id, {
        title: form.title.trim() || undefined,
        // Structured parts; the server rebuilds the display string.
        authors: authors
          .map((a) => ({
            given: a.given.trim(),
            middle: a.middle.trim(),
            family: a.family.trim(),
            suffix: a.suffix.trim(),
          }))
          .filter((a) => a.given || a.middle || a.family),
        abstract: form.abstract.trim() || undefined,
        keywords: form.keywords.trim() || undefined,
        publication_year: form.publication_year.trim()
          ? Number(form.publication_year)
          : undefined,
        doi: form.doi.trim() || undefined,
        subject_category: form.subject_category.trim() || undefined,
        document_type: form.document_type.trim() || undefined,
        citation_count: form.citation_count.trim()
          ? Number(form.citation_count)
          : undefined,
      });

      setCurrentPaper(updatedPaper);
      setEditing(false);

      if (onPaperUpdated) {
        onPaperUpdated(updatedPaper);
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update paper."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    if (!currentPaper) {
      return;
    }

    setForm(formFromPaper(currentPaper));
    setAuthors(paperAuthors(currentPaper));
    setEditing(false);
    setError(null);
  };

  // --------------------------------------------------------
  // Called by FindPdfPanel once a candidate PDF has been
  // confirmed and successfully attached to this paper.
  // --------------------------------------------------------
  const handlePdfAttached = (updatedPaper: Paper) => {
    setCurrentPaper(updatedPaper);

    if (onPaperUpdated) {
      onPaperUpdated(updatedPaper);
    }
  };

  /* Portalled to <body>: the route-in animation on <main> leaves a
     persistent identity transform, which would trap this fixed scrim
     inside <main> — the header stayed visible above the dialog and
     the 92vh window was clipped at the viewport bottom. */
  return createPortal(
    /* Scrim is the solid cream canvas rather than a translucent black:
       the spec allows no translucency, and the ink outline + slab read
       best against cream. */
    <div
      className="fixed inset-0 z-[9990] flex items-center justify-center bg-canvas p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Sizing lives on the wrapper so the slab matches the dialog
          exactly. The maxes keep it inside the scrim padding at every
          viewport (92vh/95vw alone overrun p-6 on short windows). */}
      <div className="relative h-[92vh] w-[95vw] max-h-[calc(100dvh-3rem)] max-w-[min(1600px,calc(100vw-3rem))]">
        {/* offset-lg slab: second solid layer, 8px right / 8px down */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 rounded bg-gray-900"
        />

        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labeledby="paper-viewer-title"
          tabIndex={-1}
          className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded border-[3px] border-gray-900 bg-white text-gray-900 focus:outline-none"
        >
          {/* ================================================= */}
          {/* HEADER (navbar treatment: cream, ink rule below) */}
          {/* ================================================= */}

          <div className="flex items-center justify-between gap-4 border-b-[3px] border-gray-900 bg-canvas px-5 py-3">
            <div className="min-w-0">
              <h2
                id="paper-viewer-title"
                className="truncate text-xl font-bold leading-snug text-gray-900"
              >
                <MathText text={currentPaper.title} />
              </h2>

              <p className="text-sm text-gray-600">
                {isPdf ? "PDF reader" : "Bibliographic record"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              {canEdit && !editing && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              )}

              {/* Export citation dropdown */}
              <div ref={exportRef} className="relative">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setExportOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                >
                  Export ▾
                </Button>

                {exportOpen && (
                  <ul
                    role="menu"
                    aria-label="Export citation"
                    className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded border-[3px] border-gray-900 bg-white py-0.5"
                  >
                    {CITATION_FORMATS.map((format) => (
                      <li key={format.id}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            downloadCitation(currentPaper, format.id);
                            setExportOpen(false);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-sm font-medium text-gray-900 transition-colors pixel-ease hover:bg-accentSoft"
                        >
                          {format.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {editing && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancelEdit}
                    disabled={saving}
                  >
                    Cancel
                  </Button>

                  {/* button-primary, scaled down for the header bar */}
                  <Button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="!px-4 !py-1.5 !text-base"
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </>
              )}

              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                aria-label="Close"
                className="!px-3 !py-0.5 !text-2xl !leading-none"
              >
                ×
              </Button>
            </div>
          </div>

          {/* ================================================= */}
          {/* ERROR: no red, plain ink text on white */}
          {/* ================================================= */}

          {error && (
            <div
              role="alert"
              className="border-b-[3px] border-gray-900 bg-white px-5 py-3 text-sm font-medium text-gray-900"
            >
              {error}
            </div>
          )}

          {/* ================================================= */}
          {/* BODY */}
          {/* ================================================= */}

          <div className="flex min-h-0 flex-1">
            {/* ----------------- PDF READER ----------------- */}
            <div className="min-w-0 flex-1 bg-canvas">
              {isPdf ? (
                <iframe
                  src={pdfUrl}
                  title={currentPaper.title || "Paper PDF"}
                  className="h-full w-full border-0"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-8">
                  {/* result-panel */}
                  <div className="w-full max-w-md rounded border-[3px] border-gray-900 bg-white p-6 text-left">
                    <p className="text-xl font-bold leading-snug text-gray-900">
                      PDF unavailable
                    </p>

                    <p className="mt-2 text-sm leading-normal text-gray-600">
                      This paper was imported as a BibTeX citation and does
                      not have a stored PDF file.
                    </p>

                    <FindPdfPanel
                      key={currentPaper.id}
                      paper={currentPaper}
                      onAttached={handlePdfAttached}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ----------------- METADATA PANEL ----------------- */}
            <aside className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l-[3px] border-gray-900 bg-white">
              <div className="p-5">
                <h3 className="font-pixelify text-xl font-bold leading-snug text-gray-900">
                  Paper information
                </h3>

                {/* whitespace groups the fields; no divider rules */}
                <div className="mt-6 space-y-5">
                  {FIELDS.map((field) => {
                    const inputId = `paper-field-${field.key}`;
                    const raw = currentPaper[field.key];
                    const isEmpty = raw == null || raw === "";

                    return (
                      <div key={field.key}>
                        <label
                          htmlFor={editing ? inputId : undefined}
                          className="font-pixelify mb-1.5 block text-base font-bold text-gray-900"
                        >
                          {field.label}
                        </label>

                        {editing && field.key === "author" ? (
                          <AuthorsEditor
                            value={authors}
                            onChange={setAuthors}
                            disabled={saving}
                          />
                        ) : editing ? (
                          field.control === "textarea" ? (
                            <textarea
                              id={inputId}
                              value={form[field.key]}
                              onChange={(event) =>
                                handleChange(field.key, event.target.value)
                              }
                              rows={field.rows}
                              className={`${INPUT} resize-y`}
                            />
                          ) : (
                            <input
                              id={inputId}
                              type={field.type}
                              value={form[field.key]}
                              onChange={(event) =>
                                handleChange(field.key, event.target.value)
                              }
                              className={INPUT}
                            />
                          )
                        ) : (
                          <p
                            className={`text-sm ${
                              field.prose
                                ? "whitespace-pre-wrap leading-relaxed"
                                : "leading-snug"
                            } ${field.breakAll ? "break-all" : ""} ${
                              isEmpty ? "text-gray-600" : "text-gray-900"
                            }`}
                          >
                            {isEmpty
                              ? field.emptyText ?? "—"
                              : field.key === "abstract" ||
                                field.key === "title" ? (
                                  <MathText text={String(raw)} />
                                ) : (
                                  String(raw)
                                )}
                          </p>
                        )}
                      </div>
                    );
                  })}

                  {/* FILE: read-only, set in monospace like other code values */}
                  <div>
                    <p className="mb-1.5 text-sm font-bold text-gray-900">
                      Stored file
                    </p>

                    <p className="break-all font-mono text-sm leading-normal text-gray-600">
                      {currentPaper.stored_path || "No file"}
                    </p>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

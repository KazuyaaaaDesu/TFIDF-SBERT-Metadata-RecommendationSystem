/**
 * EDITABLE CELL — click-to-edit table cells with autosave.
 *
 * Single click swaps the cell for an input; Enter or blur commits
 * through the PATCH endpoint (autosave), Escape cancels. Score and
 * import dates are simply not rendered through this component — the
 * read-only columns stay untouched.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { updatePaper, type Paper } from "../api";

export type EditableField =
  | "title"
  | "author"
  | "publication_year"
  | "document_type";

interface EditableCellProps {
  paperId: number;
  field: EditableField;
  value: string | number | null;
  /** Year cells use a number input; everything else a text input. */
  isYear?: boolean;
  className?: string;
  /** Extra classes for the read (non-editing) view. */
  renderClassName?: string;
  /** Custom rendering for the read view (e.g. MathText for titles). */
  render?: (text: string) => ReactNode;
  onSaved: (updated: Paper) => void;
}

const FIELD_LABELS: Record<EditableField, string> = {
  title: "Title",
  author: "Authors",
  publication_year: "Publication year",
  document_type: "Document type",
};

export default function EditableCell({
  paperId,
  field,
  value,
  isYear = false,
  className = "",
  renderClassName = "",
  render,
  onSaved,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value === null ? "" : String(value));
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  async function commit() {
    if (!editing) {
      return;
    }

    setEditing(false);

    const raw = draft.trim();
    const payload: Record<string, string | number | null> = {};

    if (isYear) {
      const parsed = raw === "" ? null : Number(raw);
      payload[field] = Number.isFinite(parsed) ? parsed : null;
    } else {
      payload[field] = raw === "" ? null : raw;
    }

    const unchanged =
      payload[field] === value ||
      (payload[field] === null && (value === null || value === ""));

    if (unchanged) {
      setStatus("idle");
      return;
    }

    setStatus("saving");

    try {
      const updated = await updatePaper(paperId, payload);
      setStatus("saved");
      onSaved(updated);

      window.setTimeout(() => setStatus("idle"), 1400);
    } catch (e) {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2200);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={isYear ? "number" : "text"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void commit();
          } else if (event.key === "Escape") {
            setEditing(false);
            setDraft(value === null ? "" : String(value));
          }
        }}
        aria-label={`Edit ${FIELD_LABELS[field]}`}
        className={`ui-input min-h-8 px-2 py-1 text-xs ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      // A single click is left alone so it bubbles to the table row, which
      // selects the paper and opens the inspector. Only a double-click is
      // taken here, to start editing.
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
      title={`Double-click to edit ${FIELD_LABELS[field]} (autosaves)`}
      aria-label={`Edit ${FIELD_LABELS[field]}`}
      className={`group/cell inline-flex max-w-full items-center gap-1 text-left transition-colors ${
        status === "error" ? "text-rose-600" : ""
      } ${className}`}
    >
      <span
        className={`truncate ${status === "saved" ? "text-emerald-600" : ""} ${renderClassName}`}
      >
        {value === null || value === ""
          ? "—"
          : render
            ? render(String(value))
            : String(value)}
      </span>

      {status === "saving" && (
        <span className="animate-blink text-[10px] font-bold text-muted">
          …
        </span>
      )}
      {status === "saved" && (
        <span className="text-[10px] font-bold text-emerald-600">✓</span>
      )}
      {status === "error" && (
        <span
          className="text-[10px] font-bold"
          title="Save failed — try again"
        >
          ✗
        </span>
      )}
    </button>
  );
}
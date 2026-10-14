import { useState } from "react";

import type { AuthorPart } from "../api";
import { parseAuthorList } from "../utils/authorNames.ts";

/* ============================================================
   AUTHORS EDITOR
   Edits a paper's authors as the three parts a citation style needs
   (given / middle / family) plus a suffix ("Jr."), one row per
   author, in author order. "Paste names" fills the rows from a
   free-form list ("Smith, John; Doe, Jane A.") using the same parser
   the server uses, so what you see is what gets stored.
   ============================================================ */

const CELL =
  "block w-full min-w-0 rounded border-[3px] border-gray-900 bg-field px-2 py-1.5 " +
  "text-sm font-medium text-gray-900 placeholder-gray-600 " +
  "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-gray-900 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const ICON_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded border-[2px] border-gray-900 " +
  "bg-surface text-sm font-bold text-ink transition-colors pixel-ease hover:bg-accentSoft " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const empty = (): AuthorPart => ({ given: "", middle: "", family: "", suffix: "" });

export default function AuthorsEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: AuthorPart[];
  onChange: (next: AuthorPart[]) => void;
  disabled?: boolean;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");

  function patch(index: number, field: keyof AuthorPart, text: string) {
    onChange(value.map((a, i) => (i === index ? { ...a, [field]: text } : a)));
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function applyPaste() {
    const parsed = parseAuthorList(pasted);
    if (parsed.length) onChange(parsed);
    setPasted("");
    setPasteOpen(false);
  }

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-sm text-gray-600">
          No authors yet. Add one below or paste a list.
        </p>
      )}

      {value.map((author, index) => (
        <fieldset
          key={index}
          className="rounded border-[3px] border-gray-900 p-2"
          disabled={disabled}
        >
          <legend className="px-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-gray-700">
            Author {index + 1}
          </legend>

          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0">
              <span className="mb-0.5 block text-[11px] font-bold text-gray-700">
                Given
              </span>
              <input
                className={CELL}
                value={author.given}
                onChange={(e) => patch(index, "given", e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="min-w-0">
              <span className="mb-0.5 block text-[11px] font-bold text-gray-700">
                Middle
              </span>
              <input
                className={CELL}
                value={author.middle}
                onChange={(e) => patch(index, "middle", e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="min-w-0">
              <span className="mb-0.5 block text-[11px] font-bold text-gray-700">
                Family
              </span>
              <input
                className={CELL}
                value={author.family}
                onChange={(e) => patch(index, "family", e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="min-w-0">
              <span className="mb-0.5 block text-[11px] font-bold text-gray-700">
                Suffix
              </span>
              <input
                className={CELL}
                value={author.suffix}
                placeholder="Jr., III"
                onChange={(e) => patch(index, "suffix", e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              className={ICON_BTN}
              onClick={() => move(index, -1)}
              disabled={disabled || index === 0}
              aria-label={`Move author ${index + 1} up`}
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              className={ICON_BTN}
              onClick={() => move(index, 1)}
              disabled={disabled || index === value.length - 1}
              aria-label={`Move author ${index + 1} down`}
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              className={`${ICON_BTN} ml-auto`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              aria-label={`Remove author ${index + 1}`}
              title="Remove"
            >
              ✕
            </button>
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded border-[2px] border-gray-900 bg-surface px-2.5 py-1 text-sm font-semibold text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:opacity-50"
          onClick={() => onChange([...value, empty()])}
          disabled={disabled}
        >
          + Add author
        </button>
        <button
          type="button"
          className="rounded border-[2px] border-gray-900 bg-surface px-2.5 py-1 text-sm font-semibold text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:opacity-50"
          onClick={() => setPasteOpen((open) => !open)}
          disabled={disabled}
          aria-expanded={pasteOpen}
        >
          Paste names
        </button>
      </div>

      {pasteOpen && (
        <div className="space-y-2">
          <textarea
            className={`${CELL} resize-y`}
            rows={3}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Smith, John M.; Doe, Jane  — or —  John Smith and Jane Doe"
          />
          <button
            type="button"
            className="rounded border-[2px] border-gray-900 bg-accent px-2.5 py-1 text-sm font-bold text-onAccent transition-colors pixel-ease hover:brightness-110 disabled:opacity-50"
            onClick={applyPaste}
            disabled={!pasted.trim()}
          >
            Replace with these
          </button>
        </div>
      )}
    </div>
  );
}

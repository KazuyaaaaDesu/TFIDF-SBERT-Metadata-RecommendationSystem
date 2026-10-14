import { useEffect, useMemo, useState } from "react";
import { Copy, Download, RotateCcw } from "lucide-react";

import type { TournamentResult } from "../api";
import {
  blocksToHtml,
  blocksToPlainText,
  parseChatMarkdown,
} from "../utils/chatMarkdown.ts";
import {
  INTERPRETATION_STYLES,
  interpret,
  type InterpretationStyle,
} from "../utils/tournamentInterpretation.ts";
import ChatMarkdown from "./ChatMarkdown";

/* ============================================================
   TOURNAMENT INTERPRETATION
   One box, several readings. The tabs change how the same result is
   written up (plain language, thesis results, technical, executive,
   caveats, tables with a reading guide); the text is generated from the
   numbers by fixed rules, so every figure in it is in the result.

   The text is Markdown, shown rendered or as source (the source is
   editable, and edits are kept per tab). It can be copied as Markdown,
   as rich text (tables stay tables when pasted into Word or Docs), or
   as plain text (tables paste into a spreadsheet as cells), and saved
   as a .md file.
   ============================================================ */

function readStyle(key: string): InterpretationStyle {
  try {
    const saved = window.localStorage.getItem(key);
    if (INTERPRETATION_STYLES.some((s) => s.id === saved)) {
      return saved as InterpretationStyle;
    }
  } catch {
    /* storage unavailable */
  }
  return "plain";
}

/** Copy `text`; with `html`, also as rich text. Falls back to a hidden
 *  textarea where the async clipboard API is unavailable (plain http). */
async function copyToClipboard(text: string, html?: string): Promise<void> {
  try {
    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the legacy path */
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Copy is blocked in this browser context.");
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const ACTION =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded border-[2px] border-gray-900 bg-white px-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-ink transition-colors pixel-ease hover:bg-accentSoft disabled:cursor-not-allowed disabled:opacity-50";

export default function TournamentInterpretation({
  result,
  nameOf,
  generate,
  resetKey,
  storageKey = "paperrec_tournament_interpretation_style",
  filenameStem,
}: {
  result?: TournamentResult;
  nameOf: (pipelineId: string) => string;
  /** Write the text for another kind of result (e.g. a battle series). */
  generate?: (style: InterpretationStyle) => string;
  /** A different value starts from fresh, un-edited text. */
  resetKey?: string | number | null;
  storageKey?: string;
  filenameStem?: string;
}) {
  const [style, setStyle] = useState<InterpretationStyle>(() => readStyle(storageKey));
  const [view, setView] = useState<"preview" | "markdown">("preview");
  const [edits, setEdits] = useState<Partial<Record<InterpretationStyle, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);

  // A different run starts from fresh text.
  useEffect(() => setEdits({}), [resetKey ?? result?.run_id]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, style);
    } catch {
      /* best-effort */
    }
  }, [style]);

  const generated = useMemo(
    () => (generate ? generate(style) : interpret(result!, style, nameOf)),
    // nameOf is stable per render of the panel; the result is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, generate, style],
  );
  const text = edits[style] ?? generated;
  const edited = edits[style] !== undefined && edits[style] !== generated;
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  const current = INTERPRETATION_STYLES.find((s) => s.id === style)!;

  function say(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? null : n)), 2200);
  }

  async function copy(kind: "markdown" | "rich" | "plain") {
    try {
      if (kind === "markdown") await copyToClipboard(text);
      else if (kind === "plain") await copyToClipboard(blocksToPlainText(blocks));
      else await copyToClipboard(blocksToPlainText(blocks), blocksToHtml(blocks));
      say(
        kind === "markdown"
          ? "Copied as Markdown"
          : kind === "rich"
            ? "Copied: paste into Word or Docs"
            : "Copied as plain text",
      );
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not copy.");
    }
  }

  return (
    <section
      aria-label="Interpretation"
      className="rounded border-[3px] border-gray-900 bg-surface"
    >
      {/* the style tabs */}
      <div
        role="tablist"
        aria-label="Interpretation style"
        className="flex flex-wrap gap-1.5 border-b-[3px] border-gray-900 bg-canvas p-2"
      >
        {INTERPRETATION_STYLES.map(({ id, label }) => {
          const active = id === style;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStyle(id)}
              className={`rounded border-[2px] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                active
                  ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-3px_0_rgba(0,0,0,0.25)]"
                  : "border-gray-900/50 bg-white text-ink hover:bg-accentSoft"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* what this reading is, and the preview / source switch */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-[2px] border-gray-900/30 px-3 py-2">
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted">
          {current.blurb}{" "}
          <span className="text-ink/60">
            Generated from the tables above; nothing is added that isn't in
            the numbers.
          </span>
        </p>
        <div
          role="group"
          aria-label="View"
          className="flex rounded border-[2px] border-gray-900 bg-white p-0.5"
        >
          {(["preview", "markdown"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${
                view === v ? "bg-gray-900 text-onInk" : "text-ink hover:bg-accentSoft"
              }`}
            >
              {v === "preview" ? "Preview" : "Markdown"}
            </button>
          ))}
        </div>
      </div>

      {/* the box */}
      <div className="p-3">
        {view === "preview" ? (
          <div
            className="max-h-[32rem] min-h-[10rem] overflow-y-auto rounded border-[3px] border-gray-900 bg-white p-3 text-sm leading-6 text-ink"
            tabIndex={0}
            aria-label={`${current.label} interpretation`}
          >
            <ChatMarkdown content={text} />
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setEdits((prev) => ({ ...prev, [style]: e.target.value }))}
            spellCheck={false}
            aria-label={`${current.label} interpretation, Markdown source`}
            className="block h-[32rem] max-h-[70vh] w-full resize-y rounded border-[3px] border-gray-900 bg-white p-3 font-mono text-xs leading-5 text-ink focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-gray-900"
          />
        )}
      </div>

      {/* export */}
      <div className="flex flex-wrap items-center gap-2 border-t-[2px] border-gray-900/30 px-3 py-2">
        <button type="button" className={ACTION} onClick={() => void copy("markdown")}>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Copy Markdown
        </button>
        <button
          type="button"
          className={ACTION}
          onClick={() => void copy("rich")}
          title="Tables stay tables when pasted into Word, Google Docs or Outlook"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Copy for Word
        </button>
        <button
          type="button"
          className={ACTION}
          onClick={() => void copy("plain")}
          title="Plain text; tables paste into a spreadsheet as cells"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Copy plain
        </button>
        <button
          type="button"
          className={ACTION}
          onClick={() =>
            download(
              `${filenameStem ?? `tournament-${result?.run_id ?? "run"}`}-${style}.md`,
              text.endsWith("\n") ? text : `${text}\n`,
            )
          }
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download .md
        </button>
        {edited && (
          <button
            type="button"
            className={ACTION}
            onClick={() =>
              setEdits((prev) => {
                const next = { ...prev };
                delete next[style];
                return next;
              })
            }
            title="Discard your edits and regenerate this reading"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset text
          </button>
        )}
        <span role="status" className="ml-auto font-mono text-[11px] font-bold text-ink">
          {notice ?? (edited ? "Edited" : "")}
        </span>
      </div>
    </section>
  );
}

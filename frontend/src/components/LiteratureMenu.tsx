/**
 * LITERATURE MENU — the multi-select context menu for Repository and
 * My Library rows.
 *
 * Actions: update details (re-runs backend enrichment), open file
 * (in-app viewer), open externally, reveal the containing folder,
 * rename the stored documents, merge records, mark recommendation
 * validity, and copy-as (formatted citation / BibTeX / LaTeX).
 *
 * Mutation actions run their own API calls; the host page hears
 * about every result through `onChanged(message)` so it can reload
 * its rows and show the message.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  getEnrichmentStatus,
  getPaperPdfUrl,
  markPapers,
  mergePapers,
  refreshPapersMetadata,
  revealPapers,
  renamePaperFiles,
  type Paper,
} from "../api";
import { CloseX } from "./retro/PixelIcons";
import { usePlacedMenu } from "./ContextMenu";
import {
  citationParts,
} from "../utils/citationStyles";
import { citationKey, paperToBibtex } from "../utils/exportCitations";
import { readSettings } from "../utils/preferences";

type Dialog = "rename" | "merge" | null;

const ITEM =
  "block w-full rounded border-2 border-gray-900 bg-surface px-2 py-1.5 " +
  "text-left font-bold text-ink transition-colors pixel-ease " +
  "hover:bg-accentSoft focus-visible:bg-accentSoft " +
  "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

const DIALOG_BUTTON =
  "rounded border-2 border-gray-900 bg-surface px-3 py-1.5 font-bold " +
  "text-ink transition-colors pixel-ease hover:bg-accentSoft " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const DIALOG_BUTTON_PRIMARY =
  "rounded border-2 border-gray-900 bg-surface px-3 py-1.5 font-bold " +
  "text-ink transition-colors pixel-ease hover:bg-accent " +
  "hover:text-onAccent disabled:cursor-not-allowed disabled:opacity-40";

const DIALOG_INPUT =
  "w-full rounded border-2 border-gray-900 bg-surface px-2 py-1 " +
  "font-mono text-sm text-ink placeholder:text-muted " +
  "focus:border-accent focus:outline-none";

export default function LiteratureMenu({
  papers,
  x,
  y,
  onClose,
  onOpenFile,
  onChanged,
}: {
  papers: Paper[];
  x: number;
  y: number;
  onClose: () => void;
  onOpenFile: (paper: Paper) => void;
  onChanged: (message: string) => void;
}) {
  // Placed (and re-placed on resize or content change) so it stays on screen;
  // the menu is drawn at 75% scale.
  const { ref: menuRef, style: placed } = usePlacedMenu(x, y, 0.75);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const single = papers.length === 1;

  // File actions need a stored file; the first selected paper with
  // one is the target. Without any, external open is disabled (the
  // endpoint would answer with a raw 404 page otherwise).
  const filePapers = papers.filter(
    (paper) => (paper.stored_path ?? "").trim().length > 0
  );
  const filePaper = filePapers[0] ?? null;

  // Dismiss on outside click / touch / Escape. While a dialog
  // (rename, merge) is open it owns the screen: the menu handlers
  // must stand down, or the dialog's own clicks would close the
  // whole menu before the dialog's actions could run.
  useEffect(() => {
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (dialog !== null) {
        return;
      }

      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (dialog !== null) {
        setDialog(null);
        return;
      }

      onClose();
    }

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("touchstart", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, dialog]);

  function run(action: () => Promise<string>) {
    setBusy(true);

    action()
      .then((message) => {
        onChanged(message);
        onClose();
      })
      .catch((error: Error) => {
        onChanged(error.message);
        onClose();
      })
      .finally(() => setBusy(false));
  }

  // ----------------------------------------------------------
  // Simple actions
  // ----------------------------------------------------------

  function updateDetails() {
    run(async () => {
      const ids = papers.map((paper) => paper.id);
      const result = await refreshPapersMetadata(ids);

      // Poll the queue so the page refreshes after the writes land.
      const pending = new Set(result.queued);

      for (let attempt = 0; attempt < 20 && pending.size > 0; attempt++) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, 1500)
        );

        for (const id of [...pending]) {
          try {
            const { status } = await getEnrichmentStatus(id);

            if (status === "done" || status === "failed") {
              pending.delete(id);
            }
          } catch {
            pending.delete(id);
          }
        }
      }

      return `Metadata refresh finished for ${ids.length} record${
        ids.length === 1 ? "" : "s"
      }.`;
    });
  }

  function openExternally() {
    if (!filePaper) {
      onChanged("No stored file for the selected paper.");
      onClose();
      return;
    }

    window.open(
      getPaperPdfUrl(filePaper.id),
      "_blank",
      "noopener,noreferrer"
    );

    onChanged(
      filePapers.length > 1
        ? `Opened the first of ${filePapers.length} stored files in a new tab.`
        : "Opened the file in a new tab."
    );
    onClose();
  }

  function openFolder() {
    run(async () => {
      const result = await revealPapers(
        papers.map((paper) => paper.id)
      );

      return `Opened the containing folder (${
        result.path.split("/").pop() ?? ""
      }).`;
    });
  }

  function markValid(valid: boolean) {
    run(async () => {
      const result = await markPapers(
        papers.map((paper) => paper.id),
        valid
      );

      return valid
        ? `${result.updated} record${
            result.updated === 1 ? "" : "s"
          } marked valid for recommendation.`
        : `${result.updated} record${
            result.updated === 1 ? "" : "s"
          } marked not valid.`;
    });
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      onChanged(`${label} copied to the clipboard.`);
    } catch {
      onChanged("The clipboard is unavailable in this browser.");
    }

    onClose();
  }

  /**
   * Rich copy: puts both HTML and plain text on the clipboard so
   * Word (and other rich editors) keep the italicized segments the
   * style calls for; plain-text targets still get clean text.
   */
  async function copyRich(html: string, text: string, label: string) {
    try {
      if (
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard.write
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);

        onChanged(`${label} copied to the clipboard (with italics).`);
        onClose();
        return;
      }
    } catch {
      // Fall through to the plain-text write below.
    }

    await copy(text, label);
  }

  function copyFormatted() {
    const settings = readSettings();
    const styleLabel = settings.citationStyle.toUpperCase();

    const parts = papers.map((paper, index) =>
      citationParts(
        paper,
        settings.citationStyle,
        settings.citationIncludeDoi,
        settings.citationStyle === "ieee" ? index + 1 : undefined
      )
    );

    const text = parts.map((entry) => entry.text).join("\n\n");

    const html = parts
      .map(
        (entry) =>
          `<p style="margin:0 0 10px 0">${entry.html}</p>`
      )
      .join("");

    void copyRich(
      html,
      text,
      `${styleLabel} ${single ? "citation" : "citations"}`
    );
  }

  function copyBibtex() {
    const settings = readSettings();
    const text = papers
      .map((paper) =>
        paperToBibtex(paper, {
          includeAbstract: settings.bibtexIncludeAbstract,
        })
      )
      .join("\n");

    void copy(text, "BibTeX");
  }

  function copyLatex() {
    const text = `\\cite{${papers.map(citationKey).join(",")}}`;

    void copy(text, "LaTeX citation");
  }

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        data-literature-menu
        style={{
          ...placed,
          transform: "scale(0.75)",
          transformOrigin: "top left",
        }}
        className="fixed z-[9000] w-80 select-none rounded border-[3px] border-gray-900 bg-white p-2 font-mono text-sm text-ink"
      >
        <p className="px-2 pb-1.5 font-bold tracking-[0.25em] text-accent">
          {papers.length} SELECTED
        </p>

        {busy && (
          <p className="mb-1 px-2 font-mono text-[10px] font-bold tracking-[0.2em] text-accent">
            WORKING…
          </p>
        )}

        <button
          type="button"
          role="menuitem"
          disabled={busy}
          className={ITEM}
          onClick={updateDetails}
        >
          Update details
        </button>

        <button
          type="button"
          role="menuitem"
          disabled={busy}
          className={`${ITEM} mt-1`}
          onClick={() => {
            onOpenFile(papers[0]);
            onClose();
          }}
        >
          Open file
        </button>

        <button
          type="button"
          role="menuitem"
          disabled={!filePaper}
          title={
            filePaper
              ? undefined
              : "No stored file for the selected paper."
          }
          className={`${ITEM} mt-1`}
          onClick={openExternally}
        >
          Open file externally
        </button>

        <button
          type="button"
          role="menuitem"
          disabled={busy}
          className={`${ITEM} mt-1`}
          onClick={openFolder}
        >
          Open containing folder
        </button>

        <div className="mt-2 border-t-2 border-gray-200 px-2 pt-1.5 font-bold tracking-[0.15em] text-muted">
          COLLECTIONS
        </div>

        <button
          type="button"
          role="menuitem"
          disabled={busy}
          className={`${ITEM} mt-1`}
          onClick={() => setDialog("rename")}
        >
          Rename document files…
        </button>

        <button
          type="button"
          role="menuitem"
          disabled={busy || papers.length < 2}
          title={
            papers.length < 2
              ? "Select at least two papers to merge"
              : undefined
          }
          className={`${ITEM} mt-1`}
          onClick={() => setDialog("merge")}
        >
          Merge documents…
        </button>

        {/* MARK AS ▸ */}
        <SubMenu label="Mark as">
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={ITEM}
            onClick={() => markValid(true)}
          >
            Valid for recommendation
          </button>

          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={`${ITEM} mt-1`}
            onClick={() => markValid(false)}
          >
            Not valid
          </button>
        </SubMenu>

        {/* COPY AS ▸ */}
        <SubMenu label="Copy as">
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={copyFormatted}
          >
            Formatted citation (
            {readSettings().citationStyle.toUpperCase()})
          </button>

          <button
            type="button"
            role="menuitem"
            className={`${ITEM} mt-1`}
            onClick={copyBibtex}
          >
            BibTeX
          </button>

          <button
            type="button"
            role="menuitem"
            className={`${ITEM} mt-1`}
            onClick={copyLatex}
          >
            LaTeX \cite command
          </button>
        </SubMenu>
      </div>

      {dialog === "rename" && (
        <RenameDialog
          papers={papers}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            onChanged(message);
            onClose();
          }}
        />
      )}

      {dialog === "merge" && (
        <MergeDialog
          papers={papers}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            onChanged(message);
            onClose();
          }}
        />
      )}
    </>,
    document.body,
  );
}

function SubMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${ITEM} flex items-center justify-between gap-3`}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2 border-t-2 border-gray-200 px-2 pt-1.5">
          <div className="flex flex-col">{children}</div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// RENAME DIALOG
// ============================================================

const RENAME_PATTERNS = [
  { id: "title", label: "Paper title" },
  { id: "author-year", label: "Author — Year" },
  { id: "author-year-title", label: "Author — Year — Title" },
  { id: "custom", label: "Custom name" },
] as const;

function RenameDialog({
  papers,
  onClose,
  onDone,
}: {
  papers: Paper[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [pattern, setPattern] =
    useState<(typeof RENAME_PATTERNS)[number]["id"]>("title");
  const [customName, setCustomName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function submit() {
    setBusy(true);
    setError("");

    renamePaperFiles(
      papers.map((paper) => paper.id),
      pattern,
      pattern === "custom" ? customName : undefined
    )
      .then((result) => {
        const renamed = result.renamed.length;
        const skipped = result.skipped.length;

        onDone(
          `Renamed ${renamed} file${renamed === 1 ? "" : "s"}${
            skipped
              ? `; ${skipped} skipped (no file or already named)`
              : ""
          }.`
        );
      })
      .catch((requestError: Error) => {
        setError(requestError.message);
      })
      .finally(() => setBusy(false));
  }

  return (
    <Modal title="Rename document files" onClose={onClose}>
      {error && (
        <p
          className="mb-3 rounded border-2 border-gray-900 bg-surface px-2 py-1 text-ink"
          role="alert"
        >
          {error}
        </p>
      )}

      <p className="leading-5 text-muted">
        Renaming {papers.length} stored document
        {papers.length === 1 ? "" : "s"}. The file extension is kept;
        collisions get a numeric suffix.
      </p>

      <label className="mt-4 flex flex-col gap-1">
        <span className="font-bold text-ink">
          Name pattern
        </span>
        <select
          className={DIALOG_INPUT}
          value={pattern}
          onChange={(event) =>
            setPattern(
              event.target.value as (typeof RENAME_PATTERNS)[number]["id"]
            )
          }
        >
          {RENAME_PATTERNS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      {pattern === "custom" && (
        <label className="mt-3 flex flex-col gap-1">
          <span className="font-bold text-ink">
            Custom name
          </span>
          <input
            className={DIALOG_INPUT}
            value={customName}
            placeholder="e.g. thesis-reading-01"
            onChange={(event) => setCustomName(event.target.value)}
          />
          <span className="text-xs text-muted">
            Multiple papers get a numeric suffix.
          </span>
        </label>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className={DIALOG_BUTTON}
          onClick={onClose}
        >
          Cancel
        </button>

        <button
          type="button"
          className={DIALOG_BUTTON_PRIMARY}
          disabled={busy || (pattern === "custom" && !customName.trim())}
          onClick={submit}
        >
          {busy ? "Renaming…" : "Rename files"}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// MERGE DIALOG
// ============================================================

function MergeDialog({
  papers,
  onClose,
  onDone,
}: {
  papers: Paper[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function submit() {
    setBusy(true);
    setError("");

    mergePapers(papers.map((paper) => paper.id))
      .then((result) => {
        onDone(
          `Merged ${result.merged_ids.length + 1} records into #${
            result.master_id
          }; ${result.library_moved} library entr${
            result.library_moved === 1 ? "y" : "ies"
          } and ${result.citations_moved} citation rows kept.`
        );
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setBusy(false));
  }

  return (
    <Modal title="Merge documents" onClose={onClose}>
      {error && (
        <p
          className="mb-3 rounded border-2 border-gray-900 bg-surface px-2 py-1 text-ink"
          role="alert"
        >
          {error}
        </p>
      )}

      <p className="leading-5 text-muted">
        Merge {papers.length} records into one. The record with the
        most complete metadata becomes the master; saved-library
        entries and citation rows are repointed to it, and the other
        records are deleted. Duplicate PDFs are left on disk.
      </p>

      <ul className="mt-3 flex flex-col gap-1 text-ink">
        {papers.map((paper) => (
          <li key={paper.id} className="truncate">
            #{paper.id} · {paper.title}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className={DIALOG_BUTTON}
          onClick={onClose}
        >
          Cancel
        </button>

        <button
          type="button"
          className={DIALOG_BUTTON_PRIMARY}
          disabled={busy}
          onClick={submit}
        >
          {busy ? "Merging…" : `Merge ${papers.length} records`}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[9200] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded border-[3px] border-gray-900 bg-white p-4 font-mono text-sm text-ink">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate font-bold tracking-[0.25em] text-accent">
            {title.toUpperCase()}
          </h2>

          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className={DIALOG_BUTTON}
          >
            <CloseX className="h-3 w-3" />
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}

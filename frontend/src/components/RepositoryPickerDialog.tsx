/**
 * REPOSITORY PICKER — the mini-repository pop-up behind the
 * "Browse Repository" buttons on My Library.
 *
 * Search the live repository (the same /api/papers listing the
 * Repository tab uses), page through the results, and pick a paper —
 * the chosen Paper is returned to the host via onPick, so the
 * Library can act on it (save it, open it, …). Everything runs
 * inside the theme's large RetroDialog.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ResponsiveLabel from "./ResponsiveLabel";

import { listPapers, type Paper } from "../api";
import MathText from "../components/MathText";
import PetFigure from "../components/PetFigure";
import RetroDialog from "../components/retro/RetroDialog";
import { Button, EmptyState } from "../components/ui";

const PAGE_SIZE = 10;

export default function RepositoryPickerDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (paper: Paper) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Live search with a short debounce; each keystroke re-lists.
  useEffect(() => {
    if (!open) {
      return;
    }

    let stale = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);

      listPapers({
        search: query.trim() || undefined,
        sort_by: "relevance",
      })
        .then((rows) => {
          if (!stale) {
            setPapers(rows);
            setPage(1);
          }
        })
        .catch((e) => {
          if (!stale) {
            setError(e instanceof Error ? e.message : "Failed to load.");
          }
        })
        .finally(() => {
          if (!stale) {
            setLoading(false);
          }
        });
    }, 250);

    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const pageCount = Math.max(1, Math.ceil(papers.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paged = papers.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <RetroDialog
      open={open}
      title="Browse repository"
      size="lg"
      confirmLabel="Close"
      onConfirm={onClose}
    >
      <div className="flex min-h-[380px] flex-col gap-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the repository…"
          aria-label="Search the repository"
          autoFocus
          className="ui-input text-sm"
        />

        <div className="min-h-0 flex-1 overflow-y-auto rounded border-[2px] border-gray-900 bg-canvas">
          {loading ? (
            <p className="animate-blink p-6 text-center text-muted">
              Searching the repository…
            </p>
          ) : error ? (
            <p className="status-error m-3">{error}</p>
          ) : papers.length === 0 ? (
            <EmptyState
              title="No papers found."
              description="Try broader search terms."
              figure={<PetFigure size={56} />}
            />
          ) : (
            <ul className="divide-y divide-gray-200">
              {paged.map((paper) => {
                const { subject } = categoryOf(paper);
                const busy = busyId === paper.id;

                return (
                  <li
                    key={paper.id}
                    onClick={() => void handlePick(paper)}
                    className={`flex cursor-pointer items-start gap-2 p-2.5 transition-colors hover:bg-accentSoft ${
                      busy ? "opacity-60" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block font-pixelify text-sm font-bold leading-5 text-ink">
                        <MathText text={paper.title} />
                      </span>

                      <span className="mt-0.5 block text-xs text-muted">
                        {paper.author ?? "Unknown author"}
                        {paper.publication_year
                          ? ` · ${paper.publication_year}`
                          : ""}
                        {paper.document_type
                          ? ` · ${paper.document_type}`
                          : ""}
                      </span>

                      {subject && (
                        <span className="mt-1 inline-block rounded-full border-[2px] border-gray-900 bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {subject}
                        </span>
                      )}
                    </div>

                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handlePick(paper);
                      }}
                      className="shrink-0"
                    >
                      {busy ? "Adding…" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t-[2px] border-gray-200 pt-3">
          <span className="font-mono text-xs text-muted">
            {papers.length === 0
              ? "0 papers"
              : `${pageStart + 1}–${Math.min(
                  pageStart + PAGE_SIZE,
                  papers.length,
                )} of ${papers.length}`}
          </span>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              aria-label="Previous page"
              title="Previous page"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ResponsiveLabel icon={ChevronLeft}>Prev</ResponsiveLabel>
            </Button>
            <span className="font-mono text-xs text-muted">
              {page} / {pageCount}
            </span>
            <Button
              type="button"
              aria-label="Next page"
              title="Next page"
              variant="secondary"
              disabled={page >= pageCount}
              onClick={() =>
                setPage((value) => Math.min(pageCount, value + 1))
              }
            >
              <ResponsiveLabel icon={ChevronRight}>Next</ResponsiveLabel>
            </Button>
          </div>
        </div>
      </div>
    </RetroDialog>
  );

  async function handlePick(paper: Paper) {
    if (busyId !== null) {
      return;
    }
    setBusyId(paper.id);
    try {
      await onPick(paper);
    } finally {
      setBusyId(null);
    }
  }
}

function categoryOf(paper: Paper) {
  const parts = paper.subject_category?.split(":", 2).map((p) => p.trim());
  return { subject: parts?.[0] ?? "", category: parts?.[1] ?? "" };
}
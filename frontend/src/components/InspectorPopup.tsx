/**
 * INSPECTOR POP-UP — the large, tabbed pop-up window for a paper's
 * inspector (Details / Notes / PDF / Similar). The inline right pane
 * and this pop-up render the same tab bodies; the pop-up just gives
 * them room (and the full, non-compact connections workbench).
 *
 * Portaled to the document root; Esc and a click on the backdrop
 * close it. Full-screen on phones, a big framed window on desktop.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, Info, Network, NotebookPen, Search, X } from "lucide-react";
import ResponsiveLabel from "./ResponsiveLabel";

export type InspectorTab = "details" | "notes" | "pdf" | "similar";

export const INSPECTOR_TABS: {
  id: InspectorTab;
  label: string;
  icon: typeof Info;
}[] = [
  { id: "details", label: "Details", icon: Info },
  { id: "notes", label: "Notes", icon: NotebookPen },
  { id: "pdf", label: "PDF", icon: FileText },
  { id: "similar", label: "Similar", icon: Network },
];

export default function InspectorPopup({
  open,
  title,
  tab,
  onTabChange,
  onClose,
  renderTab,
  onOpenSearch,
  tabs = INSPECTOR_TABS,
}: {
  open: boolean;
  title: string;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  renderTab: (tab: InspectorTab) => ReactNode;
  /** Secondary action: continue on the Search page. */
  onOpenSearch?: () => void;
  /** Tabs to offer (a web result has only Details and Similar). */
  tabs?: typeof INSPECTOR_TABS;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /* A confirm or the PDF viewer opened from here sits above us:
         Esc belongs to it, not to this pop-up. */
      const stacked = document.querySelectorAll(
        "[role='dialog'][aria-modal='true']",
      );
      if (stacked.length > 0) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9100] flex items-stretch justify-center bg-gray-900/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-surface outline-none sm:h-[min(92vh,900px)] sm:max-w-6xl sm:rounded-xl sm:border-[3px] sm:border-gray-900 sm:shadow-[6px_6px_0_rgba(0,0,0,0.3)] animate-pop-in"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b-[3px] border-gray-900 bg-accent px-4 py-2.5">
          <p className="min-w-0 truncate font-mono text-xs font-bold uppercase tracking-[0.15em] text-onAccent">
            {title}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {onOpenSearch && (
              <button
                type="button"
                onClick={onOpenSearch}
                title="Open on Search page"
                className="inline-flex items-center gap-1 rounded border-[2px] border-onAccent/80 px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-onAccent hover:bg-onAccent/15"
              >
                <ResponsiveLabel icon={Search}>Open on Search page</ResponsiveLabel>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              className="grid h-6 w-6 place-items-center rounded border-[2px] border-onAccent/80 text-onAccent hover:bg-onAccent/15"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div
          role="tablist"
          className="flex shrink-0 gap-0.5 border-b-[3px] border-gray-900 bg-canvas p-2"
        >
          {tabs.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              title={label}
              onClick={() => onTabChange(id)}
              className={`flex flex-1 items-center justify-center rounded border-[3px] border-gray-900 px-2 py-1.5 text-sm font-semibold transition-colors pixel-ease ${
                tab === id
                  ? "bg-accent text-onAccent"
                  : "bg-surface text-ink hover:bg-accentSoft"
              }`}
            >
              <ResponsiveLabel icon={icon}>{label}</ResponsiveLabel>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {renderTab(tab)}
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}

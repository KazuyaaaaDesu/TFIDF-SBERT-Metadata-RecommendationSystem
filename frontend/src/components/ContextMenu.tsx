/**
 * ContextMenu: a right-click menu that is always on screen.
 *
 * It is rendered into <body> (a transformed ancestor such as the page's
 * entry animation would otherwise make `position: fixed` relative to that
 * ancestor), measured after it renders, and placed by `placeMenu` so it
 * flips away from a window edge instead of running off it. It is placed
 * again when its content changes size or the window is resized, and it
 * scrolls inside itself when it is taller than the window.
 *
 * Keyboard: arrows / Home / End move, Enter or Space picks, Escape closes.
 * It closes on an outside press, on scrolling the page and on losing the
 * window.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { placeMenu } from "../utils/menuPosition";

export type MenuEntry =
  | {
      id: string;
      label: string;
      icon?: ReactNode;
      hint?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Marks the entry as the current choice (a check at the end). */
      checked?: boolean;
      onSelect: () => void;
    }
  | { separator: true; id: string }
  | { heading: string; id: string };

export function usePlacedMenu(
  x: number,
  y: number,
  scale = 1,
): {
  ref: React.MutableRefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState({ left: x, top: y, maxHeight: null as number | null });

  const reposition = useCallback(() => {
    const element = ref.current;

    if (!element) return;

    setPlacement(
      placeMenu({
        x,
        y,
        // natural size: scrollHeight is the full content even when capped
        width: element.offsetWidth * scale,
        height: Math.max(element.offsetHeight, element.scrollHeight) * scale,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y, scale]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  useEffect(() => {
    const element = ref.current;

    window.addEventListener("resize", reposition);

    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(reposition)
        : null;

    if (element && observer) observer.observe(element);

    return () => {
      window.removeEventListener("resize", reposition);
      observer?.disconnect();
    };
  }, [reposition]);

  return {
    ref,
    style: {
      left: placement.left,
      top: placement.top,
      maxHeight: placement.maxHeight !== null ? placement.maxHeight / scale : undefined,
      overflowY: placement.maxHeight !== null ? "auto" : undefined,
    },
  };
}

export default function ContextMenu({
  x,
  y,
  entries,
  onClose,
  title,
  ariaLabel = "Context menu",
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  const { ref, style } = usePlacedMenu(x, y);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Dismiss on an outside press, page scroll, Escape and window blur.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;

    function onDown(event: Event) {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    }
    function onScroll(event: Event) {
      if (ref.current && ref.current.contains(event.target as Node)) return;
      closeRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    }

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onScroll, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onDown);

    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onDown);
      previous?.focus?.();
    };
  }, [ref]);

  // Focus the first enabled item so the keyboard works at once.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [ref]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];

    if (!items.length) return;

    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length].focus();
    };

    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index <= 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") event.preventDefault();
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      data-context-menu
      style={style}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[9400] w-64 max-w-[calc(100vw-16px)] select-none rounded border-[3px] border-gray-900 bg-surface p-1.5 text-sm text-ink shadow-[4px_4px_0_rgb(var(--gray-900)/0.28)]"
    >
      {title && (
        <p className="truncate px-2 pb-1 pt-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
          {title}
        </p>
      )}
      {entries.map((entry) => {
        if ("separator" in entry) {
          return <div key={entry.id} role="separator" className="my-1 h-px bg-gray-900/25" />;
        }

        if ("heading" in entry) {
          return (
            <p
              key={entry.id}
              className="px-2 pb-0.5 pt-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted"
            >
              {entry.heading}
            </p>
          );
        }

        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect();
              closeRef.current();
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-bold transition-colors pixel-ease hover:bg-accentSoft focus-visible:bg-accentSoft focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              entry.danger ? "text-ink hover:bg-gray-900 hover:text-onInk focus-visible:bg-gray-900 focus-visible:text-onInk" : ""
            }`}
          >
            {entry.icon && <span className="shrink-0" aria-hidden="true">{entry.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && <span className="shrink-0 font-mono text-[10px] font-normal text-muted">{entry.hint}</span>}
            {entry.checked && <span aria-hidden="true" className="shrink-0 text-accent">✓</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

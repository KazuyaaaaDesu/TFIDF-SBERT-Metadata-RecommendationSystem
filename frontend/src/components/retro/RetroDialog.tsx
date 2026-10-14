/* ============================================================
   RETRO DIALOG — the theme's pop-up: a hard-bordered retro card
   over a dimmed scrim, with a brown header and pixel buttons.
   Used for every confirm/notice in the garden and the shops.

   The overlay is pinned to the WEB APP's bounding box (the
   #app-shell layout), never the whole browser window — it can
   only dim and cover the app itself, never stray UI outside it.
   ============================================================ */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function appBox(): Rect {
  /* In full screen only the fullscreen element's subtree is displayed
     (the garden's), so that is the area a dialog must cover. */
  const fullscreen = document.fullscreenElement;
  if (fullscreen) {
    const rect = fullscreen.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  const app = document.getElementById("app-shell");
  if (app) {
    const rect = app.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export default function RetroDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  size = "md",
  onConfirm,
  onCancel,
  showCancelButton = true,
  focusOnOpen = true,
  autoCloseMs = 0,
  skin,
  woodBody = false,
  elevated = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Small notices, medium confirms, large content pop-ups. */
  size?: "sm" | "md" | "lg";
  onConfirm?: () => void;
  onCancel?: () => void;
  /** With `onCancel`, Esc, a click outside and the header "x" dismiss the
   *  pop-up. Pass false to drop the footer Cancel button too (a shop
   *  pop-up wants "x" and a single Close, not Cancel + Close). */
  showCancelButton?: boolean;
  /** Seat keyboard focus inside the pop-up on open. Hover-opened
   *  pop-ups pass false: stealing focus under the pointer both
   *  shifts the keyboard unexpectedly and (on close) yanks focus
   *  back at the trigger. */
  focusOnOpen?: boolean;
  /** Close itself after this many ms, as if dismissed (0 = stay open).
   *  For notices; the player can always close them sooner. */
  autoCloseMs?: number;
  /** "wood": the garden menu's carved frame, header and footer. */
  skin?: "wood";
  /** With the wood skin, make the body wood too (the almanac's pages). */
  woodBody?: boolean;
  /** Stack above other large pop-ups (e.g. the inspector pop-up). */
  elevated?: boolean;
}) {
  const wood = skin === "wood";
  const [box, setBox] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const measure = () => setBox(appBox());
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  /* While a dialog is open the page behind it is frozen: scroll
     (wheel, touch, arrow, space) is blocked so the layout cannot
     slide out from under the pop-up, focus is trapped inside it,
     and Tab/Shift+Tab cycle through its buttons only. */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    /* Seat focus inside the pop-up immediately so Tab never leaks
       into the page behind it. (Hover-opened pop-ups opt out.) */
    const seat = window.setTimeout(() => {
      if (!focusOnOpen) {
        return;
      }
      const dialog = document.querySelector(
        "[role='dialog'][aria-modal='true']",
      );
      const first = dialog?.querySelector<HTMLElement>("button");
      first?.focus();
    }, 0);

    const block = (event: Event) => {
      /* The freeze applies to the page behind the pop-up only:
         wheel/touch over the dialog's own scrollable areas must
         keep working (large pop-ups scroll their content). */
      if (
        event.target instanceof Element &&
        event.target.closest?.("[role='dialog']")
      ) {
        return;
      }
      event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCancel) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      ) {
        event.preventDefault();
        return;
      }
      if (event.key === "Tab") {
        const dialog = document.querySelector(
          "[role='dialog'][aria-modal='true']",
        );
        const focusables = dialog
          ? Array.from(
              dialog.querySelectorAll<HTMLElement>(
                "button, [tabindex]:not([tabindex='-1'])",
              ),
            )
          : [];
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("wheel", block, { passive: false });
    window.addEventListener("touchmove", block, { passive: false });
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(seat);
      window.removeEventListener("wheel", block);
      window.removeEventListener("touchmove", block);
      document.removeEventListener("keydown", onKey);
      if (focusOnOpen) {
        previouslyFocused?.focus();
      }
    };
  }, [open, onCancel, focusOnOpen]);

  /* Click outside the pop-up closes it. The scrim itself lets the
     pointer pass through (it never intercepts a hover), so this
     listens on the document instead of the overlay. */
  useEffect(() => {
    if (!open) return;

    const closeOnOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        cardRef.current &&
        !cardRef.current.contains(event.target) &&
        onCancel
      ) {
        onCancel();
      }
    };

    document.addEventListener("pointerdown", closeOnOutside);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutside);
  }, [open, onCancel]);

  /* Persistent notices live up to 10 s, then close themselves —
     the user can always close them earlier. */
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!open || autoCloseMs <= 0) return;
    const id = window.setTimeout(() => cancelRef.current?.(), autoCloseMs);
    return () => window.clearTimeout(id);
  }, [open, autoCloseMs]);

  if (!open || !box) return null;

  const cardWidth = {
    sm: "w-[min(92%,320px)]",
    md: "w-[min(92%,460px)]",
    lg: "w-[min(96%,720px)] max-h-[88vh]",
  }[size];

  /* Portaled: the pop-up paints at the document root so the tree
     card's rounded clip can never truncate it — while its scrim
     still only covers the web app's bounding box. (Inside a
     fullscreen element it portals into that element instead, or the
     browser would not display it at all.) */
  return createPortal((
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={`pointer-events-none ${elevated ? "z-[9300]" : "z-[70]"} grid place-items-center bg-black/45 p-4 outline-none`}
      style={{
        position: "fixed",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }}
    >
      <div
        ref={cardRef}
        className={`pointer-events-auto animate-pop-in overflow-hidden rounded-xl shadow-[6px_6px_0_rgba(0,0,0,0.3)] ${
          wood
            ? "wood-board border-[3px] border-[color:var(--gm-edge)]"
            : "border-[3px] border-gray-900 bg-white"
        } ${size === "lg" ? "flex flex-col" : ""} ${cardWidth}`}
      >
        <div
          className={`flex shrink-0 items-center justify-between gap-3 border-b-[3px] px-4 py-2.5 ${
            wood
              ? "wood-plaque wood-rope-top rounded-none border-x-0 border-t-0 border-b-[color:var(--gm-edge2)] pt-3.5"
              : "border-gray-900 bg-accent"
          }`}
        >
          <p
            className={`font-mono text-xs font-bold uppercase tracking-[0.15em] ${
              wood ? "wood-label" : "text-onAccent"
            }`}
          >
            {title}
          </p>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className={`grid h-5 w-5 place-items-center rounded border-[2px] font-mono text-[11px] font-bold leading-none transition-colors pixel-ease ${
                wood
                  ? "wood-chip border-[color:var(--gm-edge)]"
                  : "border-onAccent/80 text-onAccent hover:bg-onAccent/15"
              }`}
            >
              {"\u00D7"}
            </button>
          )}
        </div>

        <div
          className={`text-xs leading-5 ${
            wood && !woodBody ? "border-y-[3px] border-[color:var(--gm-edge2)] bg-white text-ink" : wood ? "" : "text-ink"
          } ${size === "lg" ? "min-h-0 flex-1 overflow-y-auto p-4" : "p-4"}`}
        >
          {children}
        </div>

        <div
          className={`flex shrink-0 justify-end gap-2 px-4 py-3 ${
            wood
              ? "wood-plaque rounded-none border-x-0 border-b-0 border-t-[color:var(--gm-edge2)]"
              : "border-t-[3px] border-gray-900 bg-canvas"
          }`}
        >
          {onCancel && showCancelButton && (
            <button
              type="button"
              onClick={onCancel}
              className={`rounded-lg border-[3px] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors pixel-ease ${
                wood
                  ? "wood-chip border-[color:var(--gm-edge)]"
                  : "border-[2px] border-gray-900 bg-white text-ink hover:bg-accentSoft"
              }`}
            >
              {cancelLabel}
            </button>
          )}
          {onConfirm && (
            <button
              type="button"
              onClick={onConfirm}
              className={`rounded-lg border-[3px] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all pixel-ease ${
                wood
                  ? "wood-chip-lit"
                  : "border-gray-900 bg-accent text-onAccent shadow-[3px_3px_0_rgba(0,0,0,0.18)] hover:brightness-110 hover:bg-accent hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_rgba(0,0,0,0.18)] active:translate-y-[3px] active:shadow-none"
              }`}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  ), document.fullscreenElement ?? document.body);
}
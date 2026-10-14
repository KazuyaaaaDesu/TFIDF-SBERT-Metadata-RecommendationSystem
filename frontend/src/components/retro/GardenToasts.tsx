/**
 * Garden pop-ups: short notices for the tree's milestones and cheats.
 *
 * Each pop-up stays until the player closes it, or closes itself after
 * AUTO_CLOSE_MS. A shrinking bar shows the time left. The stack is
 * portalled into the fullscreen element when there is one, above the shop
 * dialogs, so a notice is never hidden behind the menu that caused it.
 */

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const AUTO_CLOSE_MS = 10_000;
/** The oldest pop-up makes room once this many are showing. */
const MAX_VISIBLE = 4;

export type ToastTone = "milestone" | "cheat-on" | "cheat-off";

export interface GardenToast {
  id: number;
  tone: ToastTone;
  title: string;
  body: string;
}

const TONE: Record<ToastTone, { bar: string; tag: string; label: string }> = {
  milestone: { bar: "bg-accent", tag: "bg-accent text-onAccent", label: "Milestone" },
  "cheat-on": { bar: "bg-gray-900", tag: "bg-gray-900 text-onInk", label: "Cheat on" },
  "cheat-off": { bar: "bg-gray-500", tag: "bg-accentSoft text-ink", label: "Cheat off" },
};

export function useGardenToasts(autoCloseMs = AUTO_CLOSE_MS) {
  const [toasts, setToasts] = useState<GardenToast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);

    if (timer !== undefined) window.clearTimeout(timer);

    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<GardenToast, "id">) => {
      const id = nextId.current++;

      setToasts((current) => {
        const next = [...current, { ...toast, id }];

        /* Make room: the oldest goes, with its timer. */
        while (next.length > MAX_VISIBLE) {
          const dropped = next.shift();

          if (dropped) {
            const timer = timers.current.get(dropped.id);

            if (timer !== undefined) window.clearTimeout(timer);

            timers.current.delete(dropped.id);
          }
        }

        return next;
      });
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), autoCloseMs),
      );

      return id;
    },
    [autoCloseMs, dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);

      timers.current.clear();
    },
    [],
  );

  return { toasts, push, dismiss };
}

export function GardenToastStack({
  toasts,
  onDismiss,
  autoCloseMs = AUTO_CLOSE_MS,
}: {
  toasts: GardenToast[];
  onDismiss: (id: number) => void;
  autoCloseMs?: number;
}) {
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed right-3 top-16 z-[90] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
      data-garden-toasts
    >
      {toasts.map((toast) => {
        const tone = TONE[toast.tone];

        return (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            data-garden-toast={toast.tone}
            className="pointer-events-auto relative overflow-hidden rounded-lg border-[3px] border-gray-900 bg-white pb-2 pl-3 pr-9 pt-2 shadow-[4px_4px_0_rgba(0,0,0,0.3)]"
          >
            <p className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
              <span
                className={`rounded border-[2px] border-gray-900 px-1.5 py-0.5 text-[8px] ${tone.tag}`}
              >
                {tone.label}
              </span>
              {toast.title}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink/90">{toast.body}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Close pop-up"
              className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded border-[2px] border-gray-900 bg-white text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              <X className="h-3 w-3" />
            </button>
            {/* time left before it closes itself */}
            <span
              aria-hidden="true"
              className={`absolute bottom-0 left-0 h-1 w-full origin-left ${tone.bar} garden-toast-bar`}
              style={{ animationDuration: `${autoCloseMs}ms` }}
            />
          </div>
        );
      })}
    </div>,
    document.fullscreenElement ?? document.body,
  );
}

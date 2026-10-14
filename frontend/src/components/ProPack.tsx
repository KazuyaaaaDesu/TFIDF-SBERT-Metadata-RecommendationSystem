/**
 * PRO PACK — the simulated in-app purchase.
 *
 * A thesis prototype: NOTHING is charged. The checkout is a demo
 * dialog (offer -> short fake processing -> receipt) and the
 * purchase is only a local flag in state/sun.tsx. The secret
 * quests (Pet and Garden) are never touched by buying.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Loader2, Lock, ShoppingBag } from "lucide-react";

import { useSun } from "../state/sun";
import { treeSpecies } from "../data/knowledge";
import {
  PRO_PACK_BENEFITS,
  PRO_PACK_FERTILIZER,
  PRO_PACK_PRICE_LABEL,
  PRO_PACK_QUEST_NOTE,
  PRO_PACK_TOKENS,
} from "../utils/proPack";
import RetroDialog from "./retro/RetroDialog";
import ResponsiveLabel, { labelProps } from "./ResponsiveLabel";

type Phase = "offer" | "processing" | "done";

/* The dialog is hosted once (AppLayout) and opened through this tiny
   store: buying unlocks PRO, which unmounts the locked-surface buttons,
   and the receipt must outlive them. */
let dialogOpen = false;
const listeners = new Set<() => void>();
function setDialogOpen(value: boolean) {
  dialogOpen = value;
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function ProPackHost() {
  const open = useSyncExternalStore(subscribe, () => dialogOpen);
  return <ProPackDialog open={open} onClose={() => setDialogOpen(false)} />;
}

function ProPackDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { purchasePro } = useSun();
  const [phase, setPhase] = useState<Phase>("offer");
  const [seed, setSeed] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhase("offer");
      setSeed(null);
    }
  }, [open]);

  useEffect(() => {
    if (phase !== "processing") return;
    const id = window.setTimeout(() => {
      const result = purchasePro();
      setSeed(result.seedSpecies);
      setPhase("done");
    }, 1400);
    return () => window.clearTimeout(id);
    // purchasePro closes over fresh state each render; the timer only
    // needs to start once per processing phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <RetroDialog
      open={open}
      title={
        phase === "done"
          ? "Pro Pack unlocked"
          : phase === "processing"
            ? "Processing"
            : "Pro Pack"
      }
      size="md"
      confirmLabel={
        phase === "done" ? "Close" : `Buy Pro Pack – ${PRO_PACK_PRICE_LABEL}`
      }
      cancelLabel="Cancel"
      showCancelButton={phase === "offer"}
      onConfirm={
        phase === "done"
          ? onClose
          : phase === "offer"
            ? () => setPhase("processing")
            : undefined
      }
      onCancel={phase === "processing" ? undefined : onClose}
    >
      {phase === "offer" && (
        <div className="flex flex-col gap-3">
          <p className="rounded border-[2px] border-gray-900 bg-accentSoft px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-ink">
            Demo checkout – nothing is charged
          </p>
          <p className="font-pixelify text-lg font-bold text-ink">
            {PRO_PACK_PRICE_LABEL}{" "}
            <span className="font-mono text-[10px] uppercase text-muted">
              one-time
            </span>
          </p>
          <ul className="flex flex-col gap-1.5">
            {PRO_PACK_BENEFITS.map((line) => (
              <li key={line} className="flex items-start gap-2 text-ink">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted">{PRO_PACK_QUEST_NOTE}</p>
        </div>
      )}

      {phase === "processing" && (
        <div
          className="flex flex-col items-center gap-3 py-4 text-ink"
          role="status"
        >
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <p className="font-mono text-[10px] font-bold uppercase tracking-wide">
            Demo checkout – nothing is charged
          </p>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-3">
          <p className="rounded border-[2px] border-gray-900 bg-accentSoft px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-ink">
            Demo receipt – nothing was charged
          </p>
          <p className="text-ink">You received:</p>
          <ul className="flex flex-col gap-1.5 text-ink">
            <li>PRO unlocked for My Library</li>
            <li>
              {PRO_PACK_FERTILIZER.toLocaleString("en-US")} fertilizer (in your
              hold)
            </li>
            <li>{PRO_PACK_TOKENS.toLocaleString("en-US")} tree tokens</li>
            <li>
              1 seed pack:{" "}
              {seed
                ? `${treeSpecies(seed).label} added to your seed bank`
                : "you already own every tree"}
            </li>
          </ul>
          <p className="text-muted">{PRO_PACK_QUEST_NOTE}</p>
        </div>
      )}
    </RetroDialog>
  );
}

/** Entry point: a "Buy Pro" button that opens the offer, or a
 *  "PRO owned" chip once bought. Shown in every site mode. */
export default function ProPackButton({
  variant = "chip",
}: {
  variant?: "chip" | "button";
}) {
  const { proPurchased } = useSun();
  if (proPurchased) {
    return (
      <span className="font-pixelify inline-flex h-9 items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accent px-3 text-sm font-bold text-onAccent">
        PRO owned
      </span>
    );
  }

  const label = "Buy Pro";
  const base =
    variant === "chip"
      ? "font-pixelify inline-flex h-9 items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accent px-3 text-sm font-bold text-onAccent hover:brightness-110"
      : "inline-flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-accent px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wide text-onAccent hover:brightness-110";

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className={base}
        {...labelProps(`${label} – ${PRO_PACK_PRICE_LABEL} (demo checkout)`)}
      >
        <ResponsiveLabel icon={variant === "chip" ? Lock : ShoppingBag}>
          {label} {"–"} {PRO_PACK_PRICE_LABEL}
        </ResponsiveLabel>
      </button>
    </>
  );
}

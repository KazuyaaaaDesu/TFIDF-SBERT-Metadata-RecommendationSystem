/**
 * The ghost that follows a dragged paper. It is a document by default and
 * changes shape in a drop zone: it slips into a folder, crumples over the
 * pet, and greys out with a stop sign where a drop is not possible. See
 * utils/paperDrag.ts for how zones are found.
 */

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { crumpledBallDataURL } from "./retro/CrumpledPaper";
import { getPaperDrag, subscribePaperDrag } from "../utils/paperDrag";
import "./paperDragGhost.css";

let crumpled: string | null = null;

function crumpledSrc(): string {
  crumpled ??= crumpledBallDataURL(96);

  return crumpled;
}

function DocumentShape() {
  return (
    <svg viewBox="0 0 44 56" className="pdg-doc" aria-hidden="true">
      <path
        d="M4 2h26l10 10v40a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill="rgb(var(--surface))"
        stroke="rgb(var(--gray-900))"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M30 2v10h10" fill="rgb(var(--accent-soft))" stroke="rgb(var(--gray-900))" strokeWidth="3" strokeLinejoin="round" />
      <path d="M9 24h26M9 32h26M9 40h17" stroke="rgb(var(--gray-900))" strokeWidth="2.5" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

function FolderShape() {
  return (
    <svg viewBox="0 0 64 50" className="pdg-folder" aria-hidden="true">
      <path
        d="M4 8a3 3 0 0 1 3-3h17l6 6h27a3 3 0 0 1 3 3v29a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"
        fill="rgb(var(--accent))"
        stroke="rgb(var(--gray-900))"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M4 19h56" stroke="rgb(var(--gray-900))" strokeWidth="3" />
    </svg>
  );
}

export default function PaperDragGhost() {
  const drag = useSyncExternalStore(subscribePaperDrag, getPaperDrag, getPaperDrag);

  if (!drag.active) return null;

  const kind = drag.zone?.kind ?? "free";
  const label =
    kind === "folder"
      ? `Add to “${drag.zone!.label}”`
      : kind === "pet"
        ? drag.zone!.label || "Remove from library"
        : kind === "blocked"
          ? drag.zone!.label || "Drop on a folder"
          : drag.title;

  return createPortal(
    <div
      className="pdg"
      data-kind={kind}
      style={{ transform: `translate(${drag.x + 16}px, ${drag.y + 14}px)` }}
      aria-hidden="true"
    >
      <div className="pdg-stage">
        <FolderShape />
        <DocumentShape />
        <img className="pdg-ball" src={crumpledSrc()} alt="" />
        <span className="pdg-stop">⊘</span>
        {drag.count > 1 && <span className="pdg-count">{drag.count}</span>}
      </div>
      <span className="pdg-label">{label}</span>
    </div>,
    document.body,
  );
}

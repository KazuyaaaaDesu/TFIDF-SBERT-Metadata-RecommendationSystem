/**
 * The state behind the custom drag ghost for saved papers.
 *
 * A native drag image cannot change once the drag has started, and it is a
 * flat screenshot. So the native image is hidden and the app draws its own
 * ghost (components/PaperDragGhost.tsx): a document while the pointer is in
 * open space, a different shape once it is over a place that takes the
 * paper (a folder, the pet) or refuses it.
 *
 * Drop places announce themselves with data attributes:
 *   data-drop-zone="folder" | "pet" | "blocked"   data-drop-label="…"
 *
 * Pointer position comes from `dragover` events on the document (the only
 * events a native drag delivers), and the drag always ends on `dragend`,
 * `drop` or Escape, so the ghost can never get stuck on screen.
 */

export type DropZoneKind = "folder" | "pet" | "blocked";

export interface DropZone {
  kind: DropZoneKind;
  label: string;
}

export interface PaperDragState {
  active: boolean;
  x: number;
  y: number;
  title: string;
  count: number;
  zone: DropZone | null;
}

const IDLE: PaperDragState = { active: false, x: 0, y: 0, title: "", count: 1, zone: null };

let state: PaperDragState = IDLE;
const listeners = new Set<() => void>();

function publish(next: PaperDragState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribePaperDrag(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getPaperDrag(): PaperDragState {
  return state;
}

/** The drop place under a point, read from the data attributes. */
export function zoneFromElement(element: Element | null): DropZone | null {
  const host = element?.closest<HTMLElement>("[data-drop-zone]") ?? null;
  const kind = host?.dataset.dropZone;

  if (!host || (kind !== "folder" && kind !== "pet" && kind !== "blocked")) return null;

  return { kind, label: host.dataset.dropLabel ?? "" };
}

function sameZone(a: DropZone | null, b: DropZone | null) {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.label === b.label);
}

function onDragOver(event: DragEvent) {
  const zone = zoneFromElement(document.elementFromPoint(event.clientX, event.clientY));

  if (
    event.clientX === state.x &&
    event.clientY === state.y &&
    sameZone(zone, state.zone)
  ) {
    return;
  }

  publish({ ...state, x: event.clientX, y: event.clientY, zone });
}

function onEnd() {
  endPaperDrag();
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") endPaperDrag();
}

export function beginPaperDrag(info: { title: string; count: number; x: number; y: number }): void {
  endPaperDrag();
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("dragend", onEnd, true);
  document.addEventListener("drop", onEnd, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onEnd);
  publish({ active: true, x: info.x, y: info.y, title: info.title, count: info.count, zone: null });
}

export function endPaperDrag(): void {
  document.removeEventListener("dragover", onDragOver, true);
  document.removeEventListener("dragend", onEnd, true);
  document.removeEventListener("drop", onEnd, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", onEnd);

  if (state.active) publish(IDLE);
}

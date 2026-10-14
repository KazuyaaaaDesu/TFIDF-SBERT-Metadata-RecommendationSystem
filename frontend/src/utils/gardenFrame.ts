/**
 * The garden's frame theme (wood, stone, parchment, ...) is written on
 * <html> so every carved panel wears it, including ones that live outside
 * the garden: the cheat console, the dialogs. It must stay there on every
 * page, not just while the garden is on screen, so the app applies the
 * saved choice at start and the garden keeps it current.
 */

export const GARDEN_FRAME_KEY = "paperrec_garden_frame";

/** Put `frame` on <html> ("wood" is the stylesheet's default: no attribute). */
export function applyGardenFrame(frame: string, root: HTMLElement = document.documentElement): void {
  if (frame === "wood" || !/^[a-z]+$/.test(frame)) delete root.dataset.gardenTheme;
  else root.dataset.gardenTheme = frame;
}

export function applyStoredGardenFrame(): void {
  try {
    applyGardenFrame(window.localStorage.getItem(GARDEN_FRAME_KEY) ?? "wood");
  } catch {
    /* storage unavailable: the default frame */
  }
}

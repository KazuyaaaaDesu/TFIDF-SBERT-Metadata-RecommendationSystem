/**
 * Where a right-click menu goes so it is always fully on screen.
 *
 * The menu opens with its top-left corner at the pointer. If that would
 * run off the right or bottom edge it flips to the other side of the
 * pointer (so it never covers what was clicked), and if it fits on neither
 * side it is pinned inside the margin. A menu taller than the window gets a
 * `maxHeight` so it can scroll instead of being cut off.
 */

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set when the menu is taller than the space available. */
  maxHeight: number | null;
}

export interface PlaceMenuInput {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

function place(
  at: number,
  size: number,
  viewport: number,
  margin: number,
): number {
  const max = viewport - size - margin;

  if (at <= max) return Math.max(margin, at); // fits where it opened

  // grows to the left / upwards instead, still inside the margin
  const flipped = Math.min(at - size, max);

  if (flipped >= margin) return flipped;

  return Math.max(margin, max); // fits neither way: pin to the far edge
}

export function placeMenu(input: PlaceMenuInput): MenuPlacement {
  const margin = input.margin ?? 8;
  const availableHeight = Math.max(0, input.viewportHeight - margin * 2);
  const availableWidth = Math.max(0, input.viewportWidth - margin * 2);
  const tooTall = input.height > availableHeight;
  const height = tooTall ? availableHeight : input.height;
  const width = Math.min(input.width, availableWidth);

  return {
    left: place(input.x, width, input.viewportWidth, margin),
    top: tooTall ? margin : place(input.y, height, input.viewportHeight, margin),
    maxHeight: tooTall ? availableHeight : null,
  };
}

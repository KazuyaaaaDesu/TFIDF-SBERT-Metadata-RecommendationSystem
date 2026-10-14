/**
 * Which height milestones a tree has just reached.
 *
 * Two ladders share the same feet scale (ancient = 1000 ft): the knowledge
 * stages (the tree can answer deeper questions) and the cheat words. A
 * milestone is crossed when the height rises past it, so nothing fires on
 * load, on a reset, or when the tree shrinks. Pure and dependency-free so it
 * runs under `node --test`.
 */

export interface HeightMilestone {
  kind: "knowledge" | "cheat";
  /** The height in feet that was reached. */
  at: number;
  /** Position on its own ladder, 0-based. */
  index: number;
}

export function milestonesCrossed(
  before: number,
  after: number,
  knowledgeHeights: readonly number[],
  cheatHeights: readonly number[],
): HeightMilestone[] {
  if (!(after > before)) return [];

  const crossed: HeightMilestone[] = [];

  knowledgeHeights.forEach((at, index) => {
    if (before < at && after >= at) crossed.push({ kind: "knowledge", at, index });
  });
  cheatHeights.forEach((at, index) => {
    if (before < at && after >= at) crossed.push({ kind: "cheat", at, index });
  });

  /* Lowest first; on a tie the cheat reads after the knowledge it comes with. */
  return crossed.sort(
    (a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "knowledge" ? -1 : 1),
  );
}

/**
 * The cheat words a rise from `before` to `after` unlocks, each paired with
 * the word at its OWN position on the ladder. (Indexing the filtered list
 * instead pairs a 450 ft crossing with the 250 ft word whenever the lower
 * rung was not crossed in the same step.) Rungs with no word come back with
 * an empty string.
 */
export function cheatsCrossed(
  before: number,
  after: number,
  heights: readonly number[],
  set: readonly { word: string; effect: string }[],
): { height: number; index: number; word: string; effect: string }[] {
  const out: { height: number; index: number; word: string; effect: string }[] = [];

  heights.forEach((height, index) => {
    if (height > before && height <= after) {
      out.push({
        height,
        index,
        word: set[index]?.word ?? "",
        effect: set[index]?.effect ?? "",
      });
    }
  });

  return out;
}

/**
 * Asking the tree too much.
 *
 * The tree answers with a stored fact, one per ask. Ask it again and again
 * and it loses patience: after a few quick asks it will sometimes brush the
 * player off with a grumpy line instead of a fact, more often the faster the
 * asks come. A brush-off gives no fact and pays no token, so spamming gains
 * nothing.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

/** How far back "recent" reaches. */
export const BURST_WINDOW_MS = 30_000;
/** Asks inside the window that the tree answers without complaint. */
export const FREE_ASKS = 3;

/** The asks that still count as recent. */
export function recentAsks(times: readonly number[], now: number): number[] {
  return times.filter((t) => now - t < BURST_WINDOW_MS && t <= now);
}

/** Chance of a brush-off when this is the `count`-th recent ask. */
export function brushOffChance(count: number): number {
  if (count <= FREE_ASKS) return 0;

  return Math.min(0.7, 0.2 + 0.1 * (count - FREE_ASKS - 1));
}

/**
 * Record an ask at `now` and decide whether the tree brushes it off.
 * Returns the updated recent-ask list too, brushed off or not, so that
 * pestering a grumpy tree keeps it grumpy.
 */
export function registerAsk(
  times: readonly number[],
  now: number,
  rand: () => number,
): { times: number[]; brushOff: boolean } {
  const next = [...recentAsks(times, now), now];

  return { times: next, brushOff: rand() < brushOffChance(next.length) };
}

const GENERIC_LINES = [
  "Don't bother me. I'm photosynthesizing.",
  "Ask again and a branch might fall on you.",
  "I'm busy growing. Come back later.",
  "Do I look like a search engine?",
  "Shh. The roots are mid-thought.",
  "That's enough questions for one afternoon.",
  "Rings take time. So does patience.",
  "Go read the Engine page. I'm resting.",
  "One fact at a time, please. Slowly.",
  "Too many questions. My bark itches.",
  "Ask the pet. I'm on my break.",
  "I'm resting my rings. Shoo.",
];

const SPECIES_LINES: Record<string, string[]> = {
  crimson: [
    "Even sap runs slower when it's hurried.",
    "I turn red when I'm annoyed. Look at me.",
  ],
  oak: [
    "I've waited a thousand years. You can wait a minute.",
    "I answer to the jays, not to you. Quiet.",
  ],
  birch: [
    "My bark is peeling from all this fuss.",
    "I'm a pioneer, not a help desk.",
  ],
  elm: [
    "The blight was less tiresome than you.",
    "Shade is for resting. Let me rest.",
  ],
  redwood: [
    "Fog takes hours to settle. Be like fog.",
    "I'm three hundred feet up and still within earshot. Hush.",
  ],
  beanstalk: [
    "Keep asking and I'll grow out of earshot.",
    "I climbed past the clouds to get away from questions.",
  ],
  rosevine: [
    "Careful. Everything about me has thorns.",
    "Ask nicely, or ask the thorns.",
  ],
};

/** A grumpy line in the tree's own voice: its species' or a shared one. */
export function grumpyLine(species: string, rand: () => number): string {
  const own = SPECIES_LINES[species] ?? [];
  const pool = rand() < 0.35 && own.length > 0 ? own : GENERIC_LINES;

  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

export const GRUMPY_LINE_COUNT = {
  generic: GENERIC_LINES.length,
  species: Object.fromEntries(
    Object.entries(SPECIES_LINES).map(([id, lines]) => [id, lines.length]),
  ),
};

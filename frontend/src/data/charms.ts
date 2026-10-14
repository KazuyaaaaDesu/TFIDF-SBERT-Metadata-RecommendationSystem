/* ============================================================
   GARDEN CHARMS — what the tree's cheat words switch on.

   A charm is a piece of the garden: foliage, a plant, a creature, a
   kind of light, or a relic. Each tree has five of its own, one for
   every kind, and unlocks them in that order as it grows (the heights
   are CHEAT_HEIGHTS in knowledge.ts). An unlocked charm is a switch: on
   or off, whenever you like.

   Scene layers are the other kind of switch: the garden's ordinary
   scenery (clouds, the fence, falling leaves ...). They are never
   locked, so the garden can be as busy or as quiet as the player likes.
   ============================================================ */

import { CHEAT_HEIGHTS, CHEAT_SETS, type TreeSpeciesId } from "./knowledge";

export type CharmKind = "foliage" | "plant" | "creature" | "light" | "relic";

export const CHARM_KINDS: { kind: CharmKind; label: string }[] = [
  { kind: "foliage", label: "Foliage" },
  { kind: "plant", label: "Plant" },
  { kind: "creature", label: "Creature" },
  { kind: "light", label: "Light & weather" },
  { kind: "relic", label: "Relic" },
];

export interface Charm {
  /** The cheat word that switches it. */
  word: string;
  label: string;
  kind: CharmKind;
  /** The height in feet at which the tree can hold it. */
  height: number;
  /** What it does in the garden. */
  effect: string;
}

const LABELS: Record<string, string> = {
  keys: "Maple Keys",
  creeper: "Scarlet Creeper",
  squirrel: "Red Squirrel",
  blaze: "Autumn Blaze",
  syrup: "Sap Bucket",
  mast: "Acorn Mast",
  daisies: "Oxeye Daisies",
  jay: "Blue Jay",
  dapple: "Dappled Light",
  hollow: "Owl Hollow",
  catkins: "Catkins",
  anemone: "Wood Anemones",
  woodpecker: "Woodpecker",
  moonbeam: "Moonbeam",
  ribbons: "Bark Ribbons",
  coins: "Seed Coins",
  wisteria: "Wisteria Swags",
  oriole: "Oriole's Nest",
  shade: "Avenue Shade",
  lantern: "Avenue Lamp",
  drip: "Fog Drip",
  ferns: "Sword Ferns",
  slug: "Banana Slug",
  mist: "Coastal Mist",
  grove: "Family Grove",
  pods: "Bean Pods",
  beans: "Magic Beans",
  hen: "Golden Hen",
  gleam: "Golden Gleam",
  harp: "Golden Harp",
  petals: "Rose Petals",
  brambles: "Thorn Brambles",
  butterfly: "Blue Butterfly",
  blush: "Rose Blush",
  rapier: "Rose Rapier",
};

/** The five charms of a tree, lowest first. */
export function charmsFor(species: TreeSpeciesId): Charm[] {
  return (CHEAT_SETS[species] ?? []).map((entry, index) => ({
    word: entry.word,
    label: LABELS[entry.word] ?? entry.word,
    kind: CHARM_KINDS[index]?.kind ?? "relic",
    height: CHEAT_HEIGHTS[index],
    effect: entry.effect,
  }));
}

/** The charms that are both unlocked and switched on, for the renderer. */
export function activeCharms(
  species: TreeSpeciesId,
  unlocked: readonly string[],
  armed: readonly string[],
): string[] {
  return charmsFor(species)
    .map((charm) => charm.word)
    .filter((word) => unlocked.includes(word) && armed.includes(word));
}

/* ------------------------------------------------------------ */
/* Scene layers                                                  */
/* ------------------------------------------------------------ */

export interface SceneLayer {
  id: string;
  label: string;
  group: "Sky & ground" | "The tree" | "The climb" | "Particles";
}

export const SCENE_LAYERS: SceneLayer[] = [
  { id: "clouds", label: "Clouds", group: "Sky & ground" },
  { id: "weather", label: "Snow & dust", group: "Sky & ground" },
  { id: "fireflies", label: "Fireflies", group: "Sky & ground" },
  { id: "fence", label: "Fence", group: "Sky & ground" },
  { id: "house", label: "House", group: "Sky & ground" },
  { id: "bigfall", label: "Tumbling leaves", group: "The tree" },
  { id: "birds", label: "Birds in the crown", group: "The tree" },
  { id: "vines", label: "Trunk vines", group: "The tree" },
  { id: "sap", label: "Sap glow", group: "The tree" },
  { id: "hanging", label: "Hanging vines", group: "The climb" },
  { id: "sylphs", label: "Sylphs", group: "The climb" },
  { id: "shafts", label: "Sun shafts", group: "The climb" },
  { id: "crownshadow", label: "Crown shadow", group: "The climb" },
  { id: "summitclouds", label: "Summit clouds", group: "The climb" },
  { id: "fall", label: "Falling leaves", group: "Particles" },
  { id: "pollen", label: "Pollen dust", group: "Particles" },
  { id: "motes", label: "Motes of light", group: "Particles" },
  { id: "haze", label: "Haze leaves", group: "Particles" },
  { id: "pagefoliage", label: "Specks drifting over the pages", group: "Particles" },
  { id: "treasures", label: "Treasure glints (the scavenger hunt)", group: "Particles" },
];

/** The stray specks that drift about the garden. They start switched off
 *  (until the player first touches the scene switches), and each can be
 *  turned on here or in the Almanac's Scene page. */
export const PARTICLE_LAYERS = ["fall", "pollen", "motes", "haze", "pagefoliage"];

/* ============================================================
   KNOWLEDGE TREE
   A tiny pixel tree that grows with progress (Seed, Sprout,
   Sapling, Elder Tree) and takes the user's chosen species: Oak
   (broad crown), Birch (slender, pale trunk), Elm (vase-shaped),
   or Redwood (conical tiers). Plain rects, a three-tone foliage
   ramp with dithered edges, and a few dark speckles keep it crisp
   inside the pet menu at any scale.

   The trunk lengthens with the tree's height in feet (pass
   `heightFt`), so fertilizer visibly stretches the tree between
   stage changes, mirroring the bare-trunk trick pixel packs use.
   ============================================================ */

import {
  treeSpecies,
  type TreeSpeciesId,
} from "../../data/knowledge";

const SOIL = "#57534e";
const BIRCH_MARK = "#343a40";

/* Idle sway by stage: younger, lighter trees move more and faster;
   the elder tree barely stirs (mirrors the weight factor of the
   original pygame simulation). */

/* Feet of height needed for each extra trunk pixel, capped so the
   trunk never pierces the crown. */
const FEET_PER_TRUNK_PIXEL = 250;
const MAX_TRUNK_BONUS = 3;

interface Foliage {
  light: string;
  mid: string;
  deep: string;
}

/**
 * One canopy bundle: a mid-tone block with a light dithered top
 * edge and a dark dithered bottom edge (classic 2-pixel checker).
 */
function LeafBlock({
  x,
  y,
  w,
  h,
  foliage,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  foliage: Foliage;
}) {
  const topPixels = Math.max(1, Math.floor((w - 2) / 4));
  const bottomPixels = Math.max(1, Math.floor(w / 4));

  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={foliage.mid} />

      {Array.from({ length: topPixels }).map((_, index) => (
        <rect
          key={`top-${index}`}
          x={x + 2 + index * 4}
          y={y}
          width={2}
          height={2}
          fill={foliage.light}
        />
      ))}

      {h >= 4 &&
        Array.from({ length: bottomPixels }).map((_, index) => (
          <rect
            key={`bottom-${index}`}
            x={x + index * 4}
            y={y + h - 2}
            width={2}
            height={2}
            fill={foliage.deep}
          />
        ))}
    </>
  );
}

function Canopy({
  species,
  level,
  foliage,
}: {
  species: TreeSpeciesId;
  level: number;
  foliage: Foliage;
}) {
  const shoots = (
    <>
      <LeafBlock x={15} y={24} w={4} h={2} foliage={foliage} />
      <LeafBlock x={21} y={23} w={4} h={2} foliage={foliage} />
    </>
  );

  if (level === 1) return shoots;

  if (species === "birch") {
    return (
      <>
        {/* airy oval canopy with dangling leaf clusters */}
        <LeafBlock x={15} y={15} w={10} h={9} foliage={foliage} />
        {level >= 3 && (
          <>
            <LeafBlock x={17} y={10} w={6} h={6} foliage={foliage} />
            <rect x={13} y={23} width={2} height={3} fill={foliage.deep} />
            <rect x={19} y={24} width={2} height={3} fill={foliage.deep} />
            <rect x={25} y={23} width={2} height={3} fill={foliage.deep} />
          </>
        )}
      </>
    );
  }

  if (species === "beanstalk") {
    return (
      <>
        {/* a tall green vine: broad leaves stacked up a slim stalk */}
        <LeafBlock x={14} y={17} w={12} h={4} foliage={foliage} />
        <LeafBlock x={16} y={12} w={8} h={5} foliage={foliage} />
        {level >= 3 && (
          <>
            <LeafBlock x={11} y={14} w={7} h={3} foliage={foliage} />
            <LeafBlock x={22} y={9} w={7} h={3} foliage={foliage} />
            <LeafBlock x={17} y={3} w={6} h={6} foliage={foliage} />
            <rect x={13} y={21} width={2} height={3} fill={foliage.deep} />
            <rect x={26} y={20} width={2} height={3} fill={foliage.deep} />
          </>
        )}
      </>
    );
  }

  if (species === "rosevine") {
    return (
      <>
        {/* a tangled, arching crown dotted with blooms */}
        <LeafBlock x={12} y={15} w={16} h={7} foliage={foliage} />
        <LeafBlock x={15} y={10} w={10} h={6} foliage={foliage} />
        <rect x={17} y={13} width={2} height={2} fill="#ffd1df" />
        {level >= 3 && (
          <>
            <LeafBlock x={9} y={13} w={22} h={8} foliage={foliage} />
            <LeafBlock x={16} y={5} w={8} h={6} foliage={foliage} />
            <rect x={13} y={14} width={2} height={2} fill="#ffd1df" />
            <rect x={23} y={12} width={2} height={2} fill="#ffd1df" />
            <rect x={19} y={7} width={2} height={2} fill="#ffd1df" />
          </>
        )}
      </>
    );
  }

  if (species === "redwood") {
    return (
      <>
        {/* conifer tiers, narrowing upward to a tip */}
        <LeafBlock x={12} y={16} w={16} h={5} foliage={foliage} />
        <LeafBlock x={15} y={11} w={10} h={6} foliage={foliage} />
        {level >= 3 && (
          <>
            <LeafBlock x={9} y={20} w={22} h={4} foliage={foliage} />
            <LeafBlock x={18} y={4} w={4} h={6} foliage={foliage} />
          </>
        )}
      </>
    );
  }

  if (species === "elm") {
    return (
      <>
        {/* tall vase: wide crown, narrow shoulders */}
        <LeafBlock x={14} y={14} w={12} h={6} foliage={foliage} />
        <LeafBlock x={16} y={9} w={8} h={6} foliage={foliage} />
        {level >= 3 && (
          <>
            <LeafBlock x={11} y={12} w={18} h={8} foliage={foliage} />
            <LeafBlock x={17} y={3} w={6} h={5} foliage={foliage} />
            <rect x={15} y={20} width={2} height={2} fill={foliage.deep} />
            <rect x={24} y={21} width={2} height={2} fill={foliage.deep} />
          </>
        )}
      </>
    );
  }

  /* Oak: broad, rounded bundle crown. */
  return (
    <>
      <LeafBlock x={13} y={17} w={14} h={7} foliage={foliage} />
      <LeafBlock x={15} y={13} w={10} h={5} foliage={foliage} />
      {level >= 3 && (
        <>
          <LeafBlock x={10} y={15} w={20} h={8} foliage={foliage} />
          <LeafBlock x={15} y={6} w={10} h={6} foliage={foliage} />
          <rect x={14} y={20} width={2} height={2} fill={foliage.deep} />
          <rect x={25} y={21} width={2} height={2} fill={foliage.deep} />
        </>
      )}
    </>
  );
}

export default function KnowledgeTree({
  stage,
  species = "oak",
  size = 36,
  heightFt = 1,
}: {
  stage: number;
  species?: TreeSpeciesId;
  /** Rendered size in CSS pixels (square). */
  size?: number;
  /** Tree height in feet; stretches the trunk between stages. */
  heightFt?: number;
}) {
  const level = Math.max(0, Math.min(3, stage));
  const tree = treeSpecies(species);

  const foliage: Foliage = {
    light: tree.leafLight,
    mid: tree.leaf,
    deep: tree.leafDeep,
  };

  const trunkBonus = Math.min(
    MAX_TRUNK_BONUS,
    Math.floor(Math.max(0, heightFt) / FEET_PER_TRUNK_PIXEL),
  );

  const baseTrunkTop =
    tree.id === "redwood" || tree.id === "beanstalk" ? 16 : tree.id === "elm" ? 18 : 20;
  const trunkTop = baseTrunkTop - trunkBonus;

  return (
    <svg
      viewBox="0 0 40 40"
      style={{ width: size, height: size }}
      className="shrink-0"
      role="img"
      aria-label={`${tree.label} tree of knowledge, stage ${level + 1} of 4`}
    >
      {/* soil — the thumbnails hold still; no stray animation */}
      <rect x="9" y="34" width="22" height="4" fill={SOIL} />

      <g>
        {level === 0 ? (
          <>
            <rect x="19" y="30" width="2" height="4" fill={tree.trunk} />
            <LeafBlock x={18} y={27} w={4} h={3} foliage={foliage} />
          </>
        ) : (
          <rect
            x="19"
            y={trunkTop}
            width="2"
            height={34 - trunkTop}
            fill={tree.trunk}
          />
        )}

        {tree.id === "birch" && level >= 2 && (
          <>
            <rect x="19" y="24" width="2" height="1" fill={BIRCH_MARK} />
            <rect x="19" y="29" width="2" height="1" fill={BIRCH_MARK} />
          </>
        )}

        {level >= 1 && (
          <Canopy species={tree.id} level={level} foliage={foliage} />
        )}
      </g>
    </svg>
  );
}

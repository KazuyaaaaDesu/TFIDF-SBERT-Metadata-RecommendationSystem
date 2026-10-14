import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSimilarPapersGraph,
  SimilarGraphNode,
  SimilarPapersGraph,
  type DialWeights,
} from "../api";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import { useTheme } from "../theme";
import { CloseX } from "./retro/PixelIcons";
import { clusterColors, cssColor } from "../utils/clusterColors";
import { layoutLabels } from "../utils/labelLayout";

const GUIDES_KEY = "paperrec_cluster_guides";

function readGuides(): boolean {
  try {
    return window.localStorage.getItem(GUIDES_KEY) !== "0";
  } catch {
    return true;
  }
}

interface ConnectedPapersGraphProps {
  paperId: number;
  pipeline?: string;
  topK?: number;
  /** Dial allocation for pipeline="custom". */
  weights?: DialWeights;
  /** Let the canvas grow beyond the narrow-pane width. */
  widened?: boolean;
  /** Paper ids to highlight from a focused prior/derivative work. */
  highlightPaperIds?: number[];
  /** Reports graph node selection so sibling tabs can mirror it. */
  onSelectNode?: (id: number | null) => void;
  /** Controls layer: edge-mode toggle (Similarity / Shared topics /
   *  Both), minimum-strength slider with a live edge count, zones
   *  around the shared-topic clusters, citation-sized and
   *  year-colored nodes, and an extended legend. */
  controls?: boolean;
  /** Selected-paper side panel: details, most-similar %, shared
   *  topics, and the Ask / Open-in-library actions. */
  sidePanel?: boolean;
  onAskAbout?: (paperId: number, title: string) => void;
  onOpenInLibrary?: (paperId: number) => void;
}

interface PositionedNode extends SimilarGraphNode {
  x: number;
  y: number;
  rank: number; // 0 for the current paper, 1..n for similar papers
  isDot: boolean;
}

/*
  Pipelines that can be passed in:
    "tfidf" | "sbert" | "tfidf_sbert" |
    "tfidf_metadata" | "sbert_metadata" | "tfidf_sbert_metadata"
*/

/* ============================================================
   GITINGEST DESIGN LANGUAGE
   White result-panel · 3px gray-900 outline · 4px radius · no blur
   Ink = the selected paper · Orange = hovered / selected (active state)
   Depth is a solid offset slab (4px / 4px), never a drop shadow.
   ============================================================ */

/*
  LAYOUT NOTES
  ------------
  Layout follows the algorithm Connected Papers themselves describe
  (connectedpapers.com/about): a FORCE-DIRECTED graph (d3-force)
  that visually clusters similar papers together and pushes less
  similar ones apart, so proximity encodes similarity. Selecting a
  node highlights the SHORTEST PATH back to the origin paper.

  Titles are not drawn next to nodes (long labels collide and force
  a wide minimum width). The SVG holds numbered nodes and scales to
  any width; titles live in the ranked list underneath, linked to
  the graph (hover / click either one and the other highlights).
*/
interface GraphDims {
  width: number;
  height: number;
  cx: number;
  cy: number;
}

// Compact canvas for the side panes; the big workbench tab uses a
// wider, web-matching aspect (560:440 vs 900:520) — the tall compact
// aspect pushed the details card below the fold when widened.
const COMPACT_DIMS: GraphDims = {
  width: 560,
  height: 440,
  cx: 280,
  cy: 220,
};
const WIDE_DIMS: GraphDims = { width: 900, height: 520, cx: 450, cy: 260 };

const CURRENT_RADIUS = 30;

// Extra papers fetched beyond the requested link count, rendered
// as small unlabeled dots to suggest further connections.
const SUGGESTIONS = 12;

const DOT_RADIUS = 6.5;

// Slab offset, in SVG user units (matches translate-x-1 / translate-y-1).
const SLAB = 4;
// Stroke of the chunky outline, in SVG user units.
const OUTLINE = 3;

// SVG needs concrete color values; these mirror the Tailwind tokens used elsewhere.
// All read the live CSS variables so the graph follows the active theme palette.
const COLORS = {
  ink: "rgb(var(--ink) / 1)",
  surface: "rgb(var(--surface) / 1)",
  hairline: "rgb(var(--hairline) / 1)",
  // Theme accent (amber by default) — the "orange = active" node fill.
  orange: "rgb(var(--accent) / 1)",
  // Auto-legibility text color for accent-filled nodes.
  onAccent: "rgb(var(--on-accent) / 1)",
  onInk: "rgb(var(--on-ink) / 1)",
};

function resolveAccent(): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();

  return `rgb(${raw || "243 156 18"})`;
}

/*
 * Force-directed layout (d3-force), as described by Connected
 * Papers: similar papers cluster together, less similar ones are
 * pushed away. The origin paper is pinned at the center. Runs a
 * fixed number of simulation ticks so the layout is deterministic
 * per graph (no animation loop, no jank).
 *
 * Edge weight drives the link forces (stronger edge -> shorter
 * rest length and higher stiffness), so proximity encodes the same
 * blended similarity the edge itself carries.
 */
type GraphEdge = [number, number, number];

function buildForceLayout(
  nodes: SimilarGraphNode[],
  edges: GraphEdge[],
  dotIds: Set<number>,
  dims: GraphDims,
): PositionedNode[] {
  const ringX = dims.width * 0.214;
  const ringY = dims.height * 0.227;

  const simNodes = nodes.map((node, index) => ({
    ...node,
    x: dims.cx + Math.cos((index / Math.max(nodes.length, 1)) * Math.PI * 2) * ringX,
    y: dims.cy + Math.sin((index / Math.max(nodes.length, 1)) * Math.PI * 2) * ringY,
    fx: node.relationship === "current" ? dims.cx : undefined,
    fy: node.relationship === "current" ? dims.cy : undefined,
    rank: 0,
    isDot: dotIds.has(node.id),
  }));

  const links = edges.map(([source, target, weight]) => ({
    source,
    target,
    weight,
  }));

  const simulation = forceSimulation(simNodes as never)
    .force(
      "link",
      forceLink(links as { source: number; target: number; weight: number }[])
        .id((node: SimulationNodeDatum) => (node as { id: number }).id)
        .distance(
          (link: { source: number; target: number; weight: number }) =>
            70 + (1 - link.weight) * 140,
        )
        .strength(
          (link: { source: number; target: number; weight: number }) =>
            0.15 + link.weight * 0.5,
        ),
    )
    .force("charge", forceManyBody().strength(-190))
    .force("center", forceCenter(dims.cx, dims.cy))
    .force(
      "collide",
      forceCollide((node: SimulationNodeDatum) => {
        const typed = node as unknown as {
          relationship: string;
          isDot: boolean;
        };

        return typed.relationship === "current"
          ? CURRENT_RADIUS + 6
          : typed.isDot
            ? DOT_RADIUS + 6
            : 18;
      }).iterations(2),
    )
    .stop();

  // Deterministic settle — enough ticks for the layout to relax.
  simulation.tick(200);

  // Ranks follow similarity order, not layout position.
  let rank = 0;
  for (const node of simNodes) {
    if (node.relationship === "similar") {
      rank += 1;
      node.rank = rank;
    }
  }

  return simNodes as PositionedNode[];
}

// Similarity is encoded by size only (no tinted washes), so the fills stay
// flat: white = idle, orange = active, ink = the paper being compared.
function getNodeRadius(node: PositionedNode, min: number, max: number) {
  if (node.relationship === "current") {
    return CURRENT_RADIUS;
  }

  const span = Math.max(max - min, 0.0001);
  const t = (node.similarity - min) / span;

  return 15 + t * 6;
}

/* ---------- Shared bits ---------- */

function PanelTitle({ children }: { children: string }) {
  return (
    <h3 className="text-xl font-bold leading-snug text-gray-900">{children}</h3>
  );
}

export default function ConnectedPapersGraph({
  paperId,
  pipeline = "tfidf_sbert_metadata",
  topK = 10,
  weights,
  widened = false,
  highlightPaperIds,
  onSelectNode,
  controls = false,
  sidePanel = false,
  onAskAbout,
  onOpenInLibrary,
}: ConnectedPapersGraphProps) {
  const [graph, setGraph] = useState<SimilarPapersGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [edgeMode, setEdgeMode] = useState<"similar" | "topics" | "both">(
    "both",
  );
  const [strengthPct, setStrengthPct] = useState(50);
  /* Cluster names ride on animated leader lines out in the margins,
     where they cannot land on each other or on the papers. */
  const [guides, setGuides] = useState(readGuides);
  const dims = widened ? WIDE_DIMS : COMPACT_DIMS;
  const { accent, mode } = useTheme();
  const [accentColor, setAccentColor] = useState(resolveAccent);

  useEffect(() => {
    setAccentColor(resolveAccent());
  }, [accent]);

  /* Theme-derived color helpers: the controls layer's zones, year
     gradient, edges and legend all lerp from the live accent and
     ink tokens instead of hardcoded hues. */
  const accentTriplet = useMemo(() => {
    const match = accentColor.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return match
      ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
      : { r: 243, g: 156, b: 18 };
  }, [accentColor]);

  const inkTriplet = useMemo(() => {
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--ink")
        .trim();
      const parts = raw.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every((value) => Number.isFinite(value))) {
        return { r: parts[0], g: parts[1], b: parts[2] };
      }
    } catch {
      // fall through to the default
    }
    return { r: 44, g: 62, b: 80 };
  }, [accent]);

  const canvasTriplet = useMemo(() => {
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim();
      const parts = raw.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every((value) => Number.isFinite(value))) {
        return { r: parts[0], g: parts[1], b: parts[2] };
      }
    } catch {
      // fall through to the default
    }
    return { r: 255, g: 250, b: 240 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accent, mode]);

  const mixTriplet = (
    a: { r: number; g: number; b: number },
    b: { r: number; g: number; b: number },
    t: number,
  ) => ({
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  });

  const rgbString = (c: { r: number; g: number; b: number }) =>
    `rgb(${c.r} ${c.g} ${c.b})`;

  const yearFill = (year: number | null): string => {
    if (year === null || year === undefined) {
      return COLORS.surface;
    }
    const t = Math.max(0, Math.min(1, (year - 1995) / 31));
    const light = mixTriplet(accentTriplet, { r: 255, g: 255, b: 255 }, 0.68);
    return rgbString(mixTriplet(light, inkTriplet, t));
  };

  // Dial drags emit a stream of weight objects — fetch only after
  // the user settles (~600ms), so the graph doesn't re-request per
  // pointer move.
  const [debouncedWeights, setDebouncedWeights] =
    useState(weights);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedWeights(weights);
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [weights]);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setGraph(null);
    setSelectedNodeId(null);
    setHoveredNodeId(null);

    getSimilarPapersGraph(
      paperId,
      pipeline,
      topK + SUGGESTIONS,
      debouncedWeights,
    )
      .then((data) => {
        if (cancelled) {
          return;
        }

        setGraph(data);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }

        setError(
          err instanceof Error ? err.message : "Unable to load similar papers.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [paperId, pipeline, topK, debouncedWeights]);

  const currentNode = useMemo(
    () => graph?.nodes.find((node) => node.relationship === "current"),
    [graph],
  );

  const positionedNodes = useMemo<PositionedNode[]>(() => {
    if (!graph) {
      return [];
    }

    const similarNodes = graph.nodes.filter(
      (node) => node.relationship === "similar",
    );

    const dots = similarNodes.slice(topK);
    const dotIds = new Set(dots.map((node) => node.id));

    const allNodes = currentNode ? [currentNode, ...similarNodes] : similarNodes;

    return buildForceLayout(allNodes, graph.edges, dotIds, dims);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, currentNode, topK, widened]);

  const nodeMap = useMemo(
    () => new Map(positionedNodes.map((node) => [node.id, node])),
    [positionedNodes],
  );

  const rankedNodes = useMemo(
    () => positionedNodes.filter((node) => node.relationship === "similar"),
    [positionedNodes],
  );

  // The first `topK` similar papers are full labeled nodes; the
  // rest become small suggestion dots.
  const labeledNodes = useMemo(
    () => rankedNodes.slice(0, topK),
    [rankedNodes, topK],
  );

  const dotNodes = useMemo(
    () => rankedNodes.slice(topK),
    [rankedNodes, topK],
  );

  const dotIdSet = useMemo(
    () => new Set(dotNodes.map((node) => node.id)),
    [dotNodes],
  );

  /* ------------------------------------------------------------
     Controls layer (optional): similarity edges filtered by the
     strength slider, shared-topic edges derived from the real
     common_topic groups, cluster zones, citation/year styling.
     ------------------------------------------------------------ */

  const controlsOn = controls === true;

  // Similarity edges at or above the slider threshold.
  const visibleSimilarEdges = useMemo(() => {
    if (!graph || !controlsOn) {
      return graph?.edges ?? [];
    }
    const threshold = strengthPct / 100;
    return graph.edges.filter(([, , weight]) => weight >= threshold);
  }, [graph, controlsOn, strengthPct]);

  // Topic-share edges: members of the same common_topic group are
  // connected (star-shaped when the group is large, so the count
  // stays readable). These carry no natural strength — they are
  // shown dashed and are not filtered by the slider.
  const topicEdges = useMemo(() => {
    if (!graph) {
      return [] as { a: number; b: number }[];
    }
    const edges: { a: number; b: number }[] = [];

    for (const group of graph.common_topics) {
      const ids = group.mentions;
      if (ids.length < 2) continue;
      const hub = ids.slice(0, Math.min(ids.length, 10));
      for (let index = 1; index < hub.length; index += 1) {
        edges.push({ a: hub[0], b: hub[index] });
      }
    }

    return edges;
  }, [graph]);

  const showSimilarEdges =
    edgeMode === "similar" || edgeMode === "both";
  const showTopicEdges =
    controlsOn && (edgeMode === "topics" || edgeMode === "both");

  const edgeSummary = controlsOn
    ? `${visibleSimilarEdges.length} similar edge${
        visibleSimilarEdges.length === 1 ? "" : "s"
      } ≥ ${strengthPct}% · ${topicEdges.length} topic link${
        topicEdges.length === 1 ? "" : "s"
      }`
    : "";

  // Faint blobs around the shared-topic clusters, each in its own color
  // turned from the theme's accent (from the node positions after layout,
  // so they follow the real clustering).
  const zones = useMemo(() => {
    if (!graph || !controlsOn) {
      return [] as {
        cx: number;
        cy: number;
        rad: number;
        name: string;
        count: number;
        color: string;
      }[];
    }

    const found = graph.common_topics
      .slice(0, 5)
      .map((group) => {
        const members = group.mentions
          .map((id) => nodeMap.get(id))
          .filter((node): node is PositionedNode => Boolean(node));

        if (members.length < 2) {
          return null;
        }

        const cx =
          members.reduce((sum, node) => sum + node.x, 0) / members.length;
        const cy =
          members.reduce((sum, node) => sum + node.y, 0) / members.length;
        const spread = Math.max(
          70,
          ...members.map((node) => Math.hypot(node.x - cx, node.y - cy)),
        );

        return {
          cx,
          cy,
          rad: Math.min(170, spread + 36),
          name: group.name,
          count: members.length,
        };
      })
      .filter(
        (zone): zone is NonNullable<typeof zone> => zone !== null,
      );

    /* a color for each cluster, turned from the theme's accent */
    const palette = clusterColors(found.length, accentTriplet, canvasTriplet);

    return found.map((zone, index) => ({
      ...zone,
      color: cssColor(palette[index]),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, controlsOn, positionedNodes, accentTriplet, canvasTriplet]);

  // Citation-based node sizing (sqrt scale, like the reference).
  const citationRadius = useMemo(() => {
    if (!graph || !controlsOn) {
      return null;
    }
    const max = Math.max(
      1,
      ...graph.nodes.map((node) => node.citation_count ?? 0),
    );
    return (count: number | null) =>
      10 + 18 * Math.sqrt((count ?? 0) / max);
  }, [graph, controlsOn]);

  // Side-panel selection: the zoomed node, else the origin.
  const panelNode = useMemo(() => {
    if (!graph) return null;
    const id =
      selectedNodeId ??
      graph.nodes.find((node) => node.relationship === "current")?.id;
    return graph.nodes.find((node) => node.id === id) ?? null;
  }, [graph, selectedNodeId]);

  const panelSimilar = useMemo(() => {
    if (!graph || !panelNode) return [];
    const edges = controlsOn ? visibleSimilarEdges : graph.edges;
    return edges
      .filter(
        ([source, target]) =>
          source === panelNode.id || target === panelNode.id,
      )
      .map(([source, target, weight]) => {
        const other =
          source === panelNode.id ? target : source;
        const node = graph.nodes.find((entry) => entry.id === other);
        return node
          ? { title: node.title, pct: Math.round(weight * 100), id: node.id }
          : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 4);
  }, [graph, panelNode, controlsOn, visibleSimilarEdges]);

  const panelTopics = useMemo(() => {
    if (!graph || !panelNode) return [];
    return graph.common_topics
      .filter((group) => group.mentions.includes(panelNode.id))
      .slice(0, 3)
      .map((group) => ({
        name: group.name,
        others: group.mentions
          .filter((id) => id !== panelNode.id)
          .map((id) => graph.nodes.find((node) => node.id === id))
          .filter((node): node is SimilarGraphNode => Boolean(node))
          .slice(0, 3)
          .map((node) => node.title),
      }))
      .filter((group) => group.others.length > 0);
  }, [graph, panelNode]);

  const similarityRange = useMemo(() => {
    if (labeledNodes.length === 0) {
      return { min: 0, max: 1 };
    }

    const values = labeledNodes.map((node) => node.similarity);
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [labeledNodes]);

  const activeId = hoveredNodeId ?? selectedNodeId;

  const toggleSelected = (id: number) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
    onSelectNode?.(selectedNodeId === id ? null : id);
  };

  // ----------------------------------------------------------
  // CLICK-TO-ZOOM — selecting a node animates the canvas toward it
  // (scale + recenter) and raises its details card.
  // ----------------------------------------------------------

  const ZOOM_SCALE = 1.9;

  const zoomNode = useMemo(
    () =>
      selectedNodeId === null
        ? null
        : positionedNodes.find((node) => node.id === selectedNodeId) ??
          null,
    [positionedNodes, selectedNodeId]
  );

  const zoomStyle = useMemo(() => {
    const transition =
      "transform 450ms cubic-bezier(0.22, 1, 0.36, 1)";

    if (!zoomNode) {
      return {
        transform: "translate(0px, 0px) scale(1)",
        transition,
        transformBox: "view-box" as const,
        transformOrigin: "0 0",
      };
    }

    return {
      transform: `translate(${dims.cx - ZOOM_SCALE * zoomNode.x}px, ${
        dims.cy - ZOOM_SCALE * zoomNode.y
      }px) scale(${ZOOM_SCALE})`,
      transition,
      transformBox: "view-box" as const,
      transformOrigin: "0 0",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomNode, widened]);

  /* CLUSTER GUIDES: where each cluster's name goes. The names sit in
     columns just outside the graph (the frame grows to make room), pushed
     apart so they never overlap, and a leader line joins each to the edge
     of its cluster. They follow the zoom, so a line always points at
     where its cluster really is. */
  const guideLayout = useMemo(() => {
    if (!guides || !controlsOn || zones.length === 0) return null;

    const s = zoomNode ? ZOOM_SCALE : 1;
    const tx = zoomNode ? dims.cx - ZOOM_SCALE * zoomNode.x : 0;
    const ty = zoomNode ? dims.cy - ZOOM_SCALE * zoomNode.y : 0;
    const labelH = 24;
    /* the details panel covers the right edge, so names go on the left */
    const only = sidePanel && panelOpen ? ("left" as const) : undefined;
    const text = (name: string, count: number) =>
      `${name.length > 24 ? `${name.slice(0, 23)}…` : name} · ${count}`;
    const entries = zones.map((zone, i) => {
      const label = text(zone.name, zone.count);

      return {
        i,
        zone,
        label,
        w: Math.min(260, 20 + label.length * 7.4),
        cx: zone.cx * s + tx,
        cy: zone.cy * s + ty,
        r: zone.rad * s,
      };
    });
    const isLeft = (e: { cx: number }) => (only ? only === "left" : e.cx < dims.width / 2);
    const leftW = Math.max(0, ...entries.filter(isLeft).map((e) => e.w));
    const rightW = Math.max(0, ...entries.filter((e) => !isLeft(e)).map((e) => e.w));
    const padL = leftW > 0 ? leftW + 18 : 0;
    const padR = rightW > 0 ? rightW + 18 : 0;
    const placed = layoutLabels(
      entries.map((e) => ({ id: e.i, ax: e.cx + padL, ay: e.cy, w: e.w })),
      { width: dims.width + padL + padR, height: dims.height, h: labelH, gap: 8, pad: 8, only },
    );

    return {
      padL,
      padR,
      items: placed.map((p) => {
        const e = entries[p.id];
        const x = p.x - padL;
        const sx = p.side === "left" ? x + p.w : x;
        const sy = p.y + p.h / 2;
        /* the line ends on the edge of the cluster nearest its name */
        const dx = sx - e.cx;
        const dy = sy - e.cy;
        const len = Math.hypot(dx, dy) || 1;
        const reach = Math.min(e.r, len - 6);
        const ex = e.cx + (dx / len) * reach;
        const ey = e.cy + (dy / len) * reach;
        const bend = (sx + ex) / 2;

        return {
          key: e.zone.name,
          color: e.zone.color,
          label: e.label,
          rect: { x, y: p.y, w: p.w, h: p.h },
          path: `M ${sx} ${sy} C ${bend} ${sy}, ${bend} ${ey}, ${ex} ${ey}`,
          end: { x: ex, y: ey },
          delay: p.id * 140,
        };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guides, controlsOn, zones, zoomNode, widened, sidePanel, panelOpen]);

  // ----------------------------------------------------------
  // FOCUSED DETAILS POP-UP — auto-focused like the pet's
  // right-click menu; Escape or a click anywhere outside dismisses
  // it, and the canvas zooms back out with the same animation.
  // ----------------------------------------------------------

  const detailsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selectedNodeId !== null) {
      detailsRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
      detailsRef.current?.focus({ preventScroll: true });
    }
  }, [selectedNodeId]);

  useEffect(() => {
    if (selectedNodeId === null) {
      return;
    }

    function dismiss() {
      setSelectedNodeId(null);
      onSelectNode?.(null);
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Element | null;

      if (detailsRef.current?.contains(target as Node)) {
        return;
      }

      // Node clicks handle their own selection toggle.
      if (target?.closest?.("g[role=button]")) {
        return;
      }

      dismiss();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismiss();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedNodeId, onSelectNode]);

  // ----------------------------------------------------------
  // SHORTEST PATH from the origin paper to the active node —
  // the Connected Papers signature: highlight the similarity
  // route on selection. The server computes the route as a
  // weighted Dijkstra over the edge list (hop cost = 1 - weight),
  // so what highlights is the real similarity route rather than
  // a plain fewest-hops walk.
  // ----------------------------------------------------------

  const activePathKeys = useMemo(() => {
    if (activeId == null || !graph) {
      return new Set<string>();
    }

    const activeNode = graph.nodes.find((node) => node.id === activeId);
    const path = activeNode?.path ?? [];
    const pathKeys = new Set<string>();

    for (let index = 0; index + 1 < path.length; index += 1) {
      const from = path[index];
      const to = path[index + 1];
      pathKeys.add(`${Math.min(from, to)}-${Math.max(from, to)}`);
    }

    return pathKeys;
  }, [graph, activeId]);

  const workHighlightIds = useMemo(
    () => new Set<number>(highlightPaperIds ?? []),
    [highlightPaperIds],
  );

  const hasWorkFocus = workHighlightIds.size > 0;

  /* ---------- LOADING / ERROR / EMPTY ---------- */

  if (loading) {
    return (
      <div role="status" aria-live="polite" className="px-4 py-5 text-gray-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <PanelTitle>Similar Papers</PanelTitle>
            <p className="mt-1 text-sm text-gray-600">
              Building similarity graph from your repository…
            </p>
          </div>

          {/* small circular indicator: the one place `rounded-full` is allowed */}
          <div
            aria-hidden="true"
            className="h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-gray-900 border-t-transparent motion-reduce:animate-none"
          />
        </div>
      </div>
    );
  }

  if (error) {
    // No red: accents are never used for state. Ink text in an outlined panel.
    return (
      <div role="alert" className="px-4 py-4 text-gray-900">
        <PanelTitle>Similar Papers</PanelTitle>
        <p className="mt-1 text-sm font-medium leading-normal text-gray-900">
          {error}
        </p>
      </div>
    );
  }

  if (!graph || graph.nodes.length <= 1) {
    return (
      <div className="px-4 py-4 text-gray-900">
        <PanelTitle>Similar Papers</PanelTitle>
        <p className="mt-1 text-sm text-gray-600">
          No similar papers were found in the repository.
        </p>
      </div>
    );
  }


  return (
    <div className="overflow-hidden text-gray-900">
      {/* HEADER */}
      <div className="px-4 py-4">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <PanelTitle>Similar Papers</PanelTitle>

            <p className="mt-1 text-sm text-gray-600">
              Similar papers cluster together. Selecting a node
              highlights the similarity path back to the origin.
            </p>
          </div>

          {/* Responsive related-paper indicator: follows the right panel width
              without stealing enough space to force the title onto two lines. */}
          <span
            className="shrink-0 rounded border-[3px] border-gray-900 bg-white px-2 py-0.5 text-center text-sm font-bold leading-snug"
            style={{
              width: "clamp(72px, 22%, 140px)",
            }}
          >
            {graph.nodes.length - 1} related
          </span>
        </div>
      </div>

      {/* CONTROLS — edge-mode toggle + strength slider */}
      {controlsOn && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t-[3px] border-gray-900 bg-white px-4 py-3">
          <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-gray-600">
            Edges
          </span>

          {(
            [
              ["similar", "Similarity"],
              ["topics", "Shared topics"],
              ["both", "Both"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={edgeMode === id}
              onClick={() => setEdgeMode(id)}
              className={`rounded border-[3px] border-gray-900 px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
                edgeMode === id
                  ? "bg-accent text-onAccent"
                  : "bg-white text-gray-900 hover:bg-accentSoft"
              }`}
            >
              {label}
            </button>
          ))}

          <button
            type="button"
            aria-pressed={guides}
            onClick={() => {
              const next = !guides;

              setGuides(next);
              try {
                window.localStorage.setItem(GUIDES_KEY, next ? "1" : "0");
              } catch {
                // best-effort
              }
            }}
            title="Name each cluster on an animated line out in the margin"
            className={`rounded border-[3px] border-gray-900 px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
              guides
                ? "bg-accent text-onAccent"
                : "bg-white text-gray-900 hover:bg-accentSoft"
            }`}
          >
            Cluster guides
          </button>

          <label className="ml-auto flex items-center gap-2 text-xs font-bold text-gray-600">
            Minimum strength
            <input
              type="range"
              min={15}
              max={95}
              step={1}
              value={strengthPct}
              onChange={(event) =>
                setStrengthPct(Number(event.target.value))
              }
              className="w-36"
            />
            <span className="w-10 font-mono text-gray-900">
              {strengthPct}%
            </span>
          </label>

          <span className="w-full text-xs text-gray-600 sm:w-auto">
            {edgeSummary}
          </span>

          {/* with the guides off, a plain key names the clusters instead */}
          {!guides && zones.length > 0 && (
            <ul
              aria-label="Clusters"
              className="flex w-full flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-gray-800"
            >
              {zones.map((zone) => (
                <li key={zone.name} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border-[2px] border-gray-900"
                    style={{ background: zone.color }}
                  />
                  {zone.name} · {zone.count}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* GRAPH: sits on the cream canvas so it reads as "inside" the panel */}
      <div className="min-w-0 flex-1">
      <div className="relative border-t-[3px] border-gray-900 bg-canvas px-2 py-3">
        <svg
          viewBox={`${-(guideLayout?.padL ?? 0)} 0 ${
            dims.width + (guideLayout?.padL ?? 0) + (guideLayout?.padR ?? 0)
          } ${dims.height}`}
          className={`mx-auto block h-auto w-full ${
            widened ? "max-w-[960px]" : "max-w-[520px]"
          }`}
          role="img"
          aria-label="Similar papers graph"
          onMouseLeave={() => setHoveredNodeId(null)}
        >
          {/* ZOOM LAYER — click a node to scale/recenter here */}
          <g style={zoomStyle}>
          {/* CLUSTER ZONES — faint blobs around the shared-topic groups,
              each in its own color from the theme. Their names ride on
              the leader lines in the margins (see CLUSTER GUIDES). */}
          {controlsOn &&
            zones.map((zone) => (
              <g key={zone.name}>
                <title>{`${zone.name} (${zone.count} papers)`}</title>
                <circle
                  cx={zone.cx}
                  cy={zone.cy}
                  r={zone.rad}
                  fill={zone.color}
                  opacity={0.12}
                  stroke={zone.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                />
              </g>
            ))}

          {/* CONNECTIONS — weighted triples [source, target, weight] */}
          {(controlsOn ? visibleSimilarEdges : graph.edges).map(([sourceId, targetId, weight], edgeIndex) => {
            const source = nodeMap.get(sourceId);
            const target = nodeMap.get(targetId);

            if (!source || !target) {
              return null;
            }

            const edgeKey = `${Math.min(sourceId, targetId)}-${Math.max(
              sourceId,
              targetId,
            )}`;

            const onPath = activePathKeys.has(edgeKey);

            const touchesActive =
              activeId !== null &&
              (activeId === sourceId || activeId === targetId);

            const touchesWork =
              hasWorkFocus &&
              (workHighlightIds.has(sourceId) ||
                workHighlightIds.has(targetId));

            const dimmed =
              (activeId !== null && !onPath && !touchesActive) ||
              (hasWorkFocus && !touchesWork);

            const touchesDot =
              dotIdSet.has(sourceId) || dotIdSet.has(targetId);

            // The similarity route (shortest weighted path from the
            // origin to the active node) draws in thick ink; every
            // other edge scales thickness and opacity with its weight
            // so stronger relations read as stronger lines;
            // suggestion-dot edges stay thin and faint.
            const stroke =
              onPath || touchesActive || touchesWork
                ? COLORS.ink
                : COLORS.hairline;

            const width = onPath
              ? OUTLINE
              : touchesActive || touchesWork
                ? 2 + weight * 2
                : touchesDot
                  ? 1
                  : 1 + weight * 1.5;

            return (
              <line
                key={`${sourceId}-${targetId}`}
                className="graph-edge-in"
                style={{
                  animationDelay: `${Math.min(edgeIndex, 60) * 30}ms`,
                  transition: "opacity 100ms",
                }}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={stroke}
                strokeWidth={width}
                strokeLinecap="butt"
                opacity={
                  dimmed
                    ? 0.2
                    : onPath
                      ? 1
                      : touchesDot
                        ? 0.5
                        : 0.55 + weight * 0.45
                }
              />
            );
          })}

          {/* SHARED TOPIC EDGES — dashed, derived from common_topics */}
          {showTopicEdges &&
            topicEdges.map(({ a, b }, index) => {
              const source = nodeMap.get(a);
              const target = nodeMap.get(b);

              if (!source || !target) {
                return null;
              }

              const touchesActive =
                activeId !== null && (activeId === a || activeId === b);
              const touchesCurrent =
                currentNode !== null &&
                currentNode !== undefined &&
                (currentNode.id === a || currentNode.id === b);
              const dimmed =
                activeId !== null && !touchesActive && !touchesCurrent;

              return (
                <line
                  key={`topic-${a}-${b}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={touchesActive ? accentColor : rgbString(mixTriplet(accentTriplet, inkTriplet, 0.12))}
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  strokeLinecap="butt"
                  strokeOpacity={touchesActive ? 1 : 0.8}
                  opacity={dimmed ? 0.2 : touchesActive ? 1 : 0.55}
                  style={{
                    animationDelay: `${Math.min(index, 60) * 20}ms`,
                  }}
                />
              );
            })}

          {/* NODES */}
          {positionedNodes.map((node) => {
            const isCurrent = node.relationship === "current";
            const isActive = activeId === node.id;
            const isSelected = selectedNodeId === node.id;

            const onPath =
              activeId != null &&
              !isActive &&
              !isCurrent &&
              Array.from(activePathKeys).some((key) => {
                const [a, b] = key.split("-").map(Number);
                return a === node.id || b === node.id;
              });

            const dimmed =
              (activeId !== null &&
                !isActive &&
                !isCurrent &&
                !onPath) ||
              (hasWorkFocus &&
                !workHighlightIds.has(node.id) &&
                !isCurrent);

            const radius =
              controlsOn && citationRadius
                ? citationRadius(node.citation_count)
                : getNodeRadius(
                    node,
                    similarityRange.min,
                    similarityRange.max,
                  );

            // Flat fills only: ink = compared paper, orange = active / on
            // the similarity path / highlighted by a selected work,
            // white (or year-gradient in the controls layer) = idle.
            const fill = isCurrent
              ? COLORS.ink
              : isActive ||
                  isSelected ||
                  onPath ||
                  workHighlightIds.has(node.id)
                ? accentColor
                : controlsOn
                  ? yearFill(node.publication_year)
                  : COLORS.surface;

            // Slab only on the high-priority nodes (level-2 elevation).
            const hasSlab = isCurrent || isSelected;

            return (
              <g
                key={node.id}
                style={{
                  animationDelay: `${Math.min(node.rank, 60) * 45}ms`,
                  transition: "opacity 100ms",
                }}
                role="button"
                tabIndex={0}
                aria-label={
                  isCurrent
                    ? `Current paper: ${node.title}`
                    : `Rank ${node.rank}: ${node.title}, ${(
                        node.similarity * 100
                      ).toFixed(1)} percent similar`
                }
                aria-pressed={isSelected}
                onClick={() => toggleSelected(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleSelected(node.id);
                  }
                }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onFocus={() => setHoveredNodeId(node.id)}
                onBlur={() => setHoveredNodeId(null)}
                className="graph-node-in cursor-pointer outline-none"
                opacity={dimmed ? 0.4 : 1}
              >
                {/* offset slab: a second solid layer, same shape, no blur */}
                {hasSlab && (
                  <circle
                    cx={node.x + SLAB}
                    cy={node.y + SLAB}
                    r={radius}
                    fill={COLORS.ink}
                    stroke={COLORS.ink}
                    strokeWidth={OUTLINE}
                  />
                )}

                {/* body */}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  fill={fill}
                  stroke={COLORS.ink}
                  strokeWidth={OUTLINE}
                  className={isCurrent ? "graph-current-pulse" : ""}
                />

                {isCurrent ? (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={8}
                    fill={COLORS.surface}
                    pointerEvents="none"
                  />
                ) : (
                  <text
                    x={node.x}
                    y={node.y + 5}
                    textAnchor="middle"
                    fontSize={14}
                    fontWeight={700}
                    fill={
                      isActive || isSelected
                        ? COLORS.onAccent
                        : COLORS.ink
                    }
                    pointerEvents="none"
                  >
                    {node.rank}
                  </text>
                )}
              </g>
            );
          })}

          {/* SUGGESTION DOTS — smaller nodes hinting at further connections */}
          {dotNodes.map((node, index) => (
            <circle
              key={`dot-${node.id}`}
              className="graph-dot-in"
              style={{
                animationDelay: `${(topK + index) * 30}ms`,
              }}
              cx={node.x}
              cy={node.y}
              r={DOT_RADIUS}
              fill={COLORS.surface}
              stroke={COLORS.ink}
              strokeWidth={2}
              opacity={0.85}
              pointerEvents="none"
              aria-hidden="true"
            />
          ))}
                  </g>

          {/* CLUSTER GUIDES — names out in the margins, each on a line that
              draws itself in, keeps flowing, and ends in a ringing dot on
              the cluster it names. */}
          {guideLayout &&
            guideLayout.items.map((g) => (
              <g key={g.key} className="cluster-guide">
                <path
                  d={g.path}
                  pathLength={100}
                  fill="none"
                  stroke={g.color}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  className="cluster-guide-line"
                  style={{ animationDelay: `${g.delay}ms` }}
                />
                <path
                  d={g.path}
                  pathLength={100}
                  fill="none"
                  stroke={g.color}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeOpacity={0.55}
                  className="cluster-guide-flow"
                  style={{ animationDelay: `${g.delay + 600}ms` }}
                />
                <circle
                  cx={g.end.x}
                  cy={g.end.y}
                  r={4}
                  fill="none"
                  stroke={g.color}
                  strokeWidth={1.5}
                  className="cluster-guide-ping"
                  style={{ animationDelay: `${g.delay + 700}ms` }}
                />
                <circle
                  cx={g.end.x}
                  cy={g.end.y}
                  r={4}
                  fill={g.color}
                  stroke={COLORS.surface}
                  strokeWidth={1.5}
                  className="cluster-guide-dot"
                  style={{ animationDelay: `${g.delay + 500}ms` }}
                />
                <g
                  className="cluster-guide-label"
                  style={{ animationDelay: `${g.delay}ms` }}
                >
                  <rect
                    x={g.rect.x}
                    y={g.rect.y}
                    width={g.rect.w}
                    height={g.rect.h}
                    rx={3}
                    fill={COLORS.surface}
                    stroke={g.color}
                    strokeWidth={2}
                  />
                  <text
                    x={g.rect.x + g.rect.w / 2}
                    y={g.rect.y + g.rect.h / 2 + 4.5}
                    textAnchor="middle"
                    fontSize={13}
                    fontWeight={700}
                    fill={COLORS.ink}
                  >
                    {g.label}
                  </text>
                </g>
              </g>
            ))}
        </svg>

        {/* NODE DETAILS — raised while a node is zoomed in */}
        {zoomNode && (
          <div
            ref={detailsRef}
            data-node-details
            role="dialog"
            aria-label="Paper details"
            tabIndex={-1}
            className="animate-step-in pointer-events-none absolute bottom-3 left-3 right-3 z-10 rounded border-[3px] border-gray-900 bg-white p-3 shadow-[4px_4px_0_rgba(0,0,0,0.25)] focus:outline-none sm:right-auto sm:max-w-md"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[2px] border-gray-900 bg-gray-900 font-mono text-xs font-bold text-white">
                {zoomNode.relationship === "current" ? "★" : zoomNode.rank}
              </span>

              <button
                type="button"
                aria-label="Close details and zoom out"
                onClick={() => toggleSelected(zoomNode.id)}
                className="pointer-events-auto rounded border-2 border-gray-900 bg-white px-1.5 py-0.5 text-gray-900 transition-colors pixel-ease hover:bg-accent hover:text-onAccent"
              >
                <CloseX className="h-3 w-3" />
              </button>
            </div>

            <p className="mt-1.5 text-sm font-bold leading-snug text-gray-900">
              {zoomNode.title}
            </p>

            <p className="mt-0.5 text-xs text-gray-600">
              {zoomNode.author || "Unknown author"}
              {zoomNode.publication_year
                ? `, ${zoomNode.publication_year}`
                : ""}
              {zoomNode.relationship === "current"
                ? " · center paper"
                : ` · ${(zoomNode.similarity * 100).toFixed(1)}% similar`}
            </p>

            {zoomNode.doi && (
              <p className="mt-1">
                <a
                  href={`https://doi.org/${zoomNode.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="pointer-events-auto break-all text-xs text-accent underline"
                >
                  doi.org/{zoomNode.doi}
                </a>
              </p>
            )}

            {zoomNode.abstract && (
              <p className="mt-2 line-clamp-4 text-xs leading-5 text-gray-600">
                {zoomNode.abstract}
              </p>
            )}
          </div>
        )}

        {/* LEGEND */}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-2 text-sm text-gray-900">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border-[3px] border-gray-900 bg-gray-900"
            />
            Selected paper
          </span>

          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border-[3px] border-gray-900 bg-white"
            />
            Similar (numbered by rank)
          </span>

          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border-[3px] border-gray-900 bg-accent"
            />
            Highlighted
          </span>

          {controlsOn && (
            <>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-0 w-6 border-b-2 border-dashed border-gray-900"
                />
                Shared topic
              </span>

              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full border-[2px] border-gray-900 bg-gray-400"
                />
                <span
                  aria-hidden="true"
                  className="h-4 w-4 rounded-full border-[3px] border-gray-900 bg-gray-400"
                />
                Size = citations
              </span>

              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-16 rounded border-[1px] border-gray-900"
                  style={{
                    background: `linear-gradient(90deg, ${rgbString(
                      mixTriplet(accentTriplet, { r: 255, g: 255, b: 255 }, 0.55),
                    )}, ${rgbString(inkTriplet)})`,
                  }}
                />
                Color = year 1995 → 2026
              </span>
            </>
          )}
        </div>

      {/* SELECTED PAPER PANEL — floating overlay inside the canvas */}
        {sidePanel && graph && panelNode && (
          panelOpen ? (
          <aside
            className="absolute right-2 top-2 z-10 w-[290px] max-w-[calc(100%-2rem)] overflow-y-auto rounded border-[3px] border-gray-900 bg-white p-4 shadow-[4px_4px_0_rgba(0,0,0,0.18)]"
            style={{ maxHeight: "calc(100% - 1rem)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-gray-600">
                Selected paper
              </p>
              <button
                type="button"
                aria-label="Close selected paper panel"
                onClick={() => setPanelOpen(false)}
                className="rounded border-2 border-gray-900 bg-white px-1.5 py-0.5 text-gray-900 transition-colors pixel-ease hover:bg-accent hover:text-onAccent"
              >
                <CloseX className="h-3 w-3" />
              </button>
            </div>

            <h3 className="mt-2 text-sm font-bold leading-snug text-gray-900">
              {panelNode.title}
            </h3>

            <p className="mt-1 text-xs text-gray-600">
              {panelNode.author || "Unknown author"}
              {panelNode.publication_year
                ? ` · ${panelNode.publication_year}`
                : ""}
              {panelNode.citation_count != null
                ? ` · cited ${panelNode.citation_count}`
                : ""}
            </p>

            {panelNode.abstract && (
              <details className="group mt-2" open={false}>
                <summary className="flex cursor-pointer list-none items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-gray-600 hover:text-gray-900">
                  Abstract
                  <span className="transition-transform group-open:rotate-180">
                    ▾
                  </span>
                </summary>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                  {panelNode.abstract}
                </p>
              </details>
            )}

            <details className="group mt-3 border-t-[2px] border-gray-200 pt-3" open>
              <summary className="flex cursor-pointer list-none items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-gray-600 hover:text-gray-900">
                Most similar
                <span className="transition-transform group-open:rotate-180">
                  ▾
                </span>
              </summary>

              <div className="mt-1">
                {panelSimilar.length === 0 ? (
                  <p className="text-xs text-gray-600">
                    No similar edges above the threshold.
                  </p>
                ) : (
                  panelSimilar.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleSelected(item.id)}
                      className="flex w-full items-baseline gap-2 py-1 text-left text-xs text-gray-900 hover:underline"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {item.title}
                      </span>
                      <strong className="text-gray-600">
                        {item.pct}%
                      </strong>
                    </button>
                  ))
                )}
              </div>
            </details>

            {panelTopics.length > 0 && (
              <details
                className="group mt-3 border-t-[2px] border-gray-200 pt-3"
                open
              >
                <summary className="flex cursor-pointer list-none items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-gray-600 hover:text-gray-900">
                  Shared topics with
                  <span className="transition-transform group-open:rotate-180">
                    ▾
                  </span>
                </summary>

                <div className="mt-1 max-h-28 space-y-1.5 overflow-y-auto pr-1">
                  {panelTopics.map((group) => (
                    <div key={group.name} className="py-0.5 text-xs">
                      <span className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 text-[10px] font-bold text-gray-900">
                        {group.name}
                      </span>
                      <p className="mt-1 leading-5 text-gray-600">
                        {group.others.join(" · ")}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="mt-4 flex flex-wrap gap-2 border-t-[2px] border-gray-200 pt-3">
              {onAskAbout && (
                <button
                  type="button"
                  onClick={() =>
                    onAskAbout(panelNode.id, panelNode.title)
                  }
                  className="rounded border-[3px] border-gray-900 bg-accent px-3 py-1.5 text-sm font-bold text-onAccent transition-colors pixel-ease hover:bg-accentSoft"
                >
                  Ask about this paper
                </button>
              )}

              {onOpenInLibrary && (
                <button
                  type="button"
                  onClick={() => onOpenInLibrary(panelNode.id)}
                  className="rounded border-[3px] border-gray-900 bg-white px-3 py-1.5 text-sm font-semibold text-gray-900 transition-colors hover:bg-accentSoft"
                >
                  Open in library
                </button>
              )}
            </div>
          </aside>
          ) : (
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="absolute right-2 top-2 z-10 rounded border-[3px] border-gray-900 bg-white px-2 py-1 text-xs font-bold text-gray-900 transition-colors hover:bg-accentSoft"
          >
            Selected paper ▶
          </button>
          )
        )}
      </div>
      </div>

      {/* SHARED GROUPS — the reference model's common_authors /
          common_topics collections (topics stand in for its
          bibliographic-coupling groups; this corpus has no
          reference lists). */}
      {(graph.common_topics.length > 0 || graph.common_authors.length > 0) && (
        <div className="border-t-[3px] border-gray-900 bg-white px-4 py-3">
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-600">
            Shared across the graph
          </p>

          <div className="flex flex-wrap gap-1.5">
            {graph.common_topics.slice(0, 6).map((group) => (
              <span
                key={`topic-${group.name}`}
                title={`${group.edges_count} papers share this topic`}
                className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-0.5 text-xs font-bold text-gray-900"
              >
                {group.name}
                <span className="ml-1 text-gray-600">
                  ×{group.edges_count}
                </span>
              </span>
            ))}

            {graph.common_authors.slice(0, 4).map((group) => (
              <span
                key={`author-${group.name}`}
                title={`${group.edges_count} papers list this author`}
                className="rounded border-[2px] border-gray-900 bg-accent px-1.5 py-0.5 text-xs font-bold text-onAccent"
              >
                {group.name}
                <span className="ml-1">×{group.edges_count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* CENTER PAPER */}
      {currentNode && (
        <div className="border-t-[3px] border-gray-900 bg-white px-4 py-3">
          <p className="text-sm text-gray-600">Comparing against</p>
          <p className="mt-0.5 text-sm font-bold leading-snug text-gray-900">
            {currentNode.title}
          </p>
        </div>
      )}

      {/* FOOTER */}
      <div className="border-t-[3px] border-gray-900 bg-white px-4 py-3">
        <p className="text-sm leading-normal text-gray-600">
          Similarity is calculated using the selected recommendation pipeline
          against papers already stored in the repository.
        </p>

        {dotNodes.length > 0 && (
          <p className="mt-1.5 text-xs leading-normal text-gray-600">
            {`The small dots suggest ${dotNodes.length} further related papers — raise the link count to include them.`}
          </p>
        )}
      </div>
    </div>
  );
}


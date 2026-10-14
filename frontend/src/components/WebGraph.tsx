/**
 * WEB GRAPH — the force-directed connection canvas for the WEB scope.
 *
 * Same visual language and chrome as the local connected-papers
 * graph: "Similar Papers" header with the related count, d3-force
 * layout, ink center, numbered prior nodes, lettered derivative
 * nodes, click-to-zoom with an auto-focused details pop-up.
 *
 * Unlike a plain star, the layout uses the real inter-work structure
 * the backend derives from the fetched OpenAlex reference lists:
 * citer → prior links, co-reference between priors, and co-citation
 * between citers — so papers form complex clusters the way the local
 * graph does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";

import type { WebWork } from "../api";
import { CloseX } from "./retro/PixelIcons";

type WebEdge = [string, string, number, string];

interface WebGraphProps {
  centerTitle: string;
  prior: WebWork[];
  derivative: WebWork[];
  /** Highlight from outside (list hover / selection). */
  activeKey: string | null;
  onActiveKey: (key: string | null) => void;
  /** Rich connection list from the backend (falls back to a star). */
  edges?: WebEdge[];
  widened?: boolean;
}

interface WebNode extends SimulationNodeDatum {
  key: string;
  kind: "center" | "prior" | "derivative";
  label: string;
  work?: WebWork;
}

const OUTLINE = 3;
const ZOOM_SCALE = 1.9;

function letterLabel(index: number): string {
  return String.fromCharCode(97 + (index % 26));
}

/** Semi-log size so heavily-cited works read larger, clamped. */
function nodeRadius(work: WebWork | undefined): number {
  if (!work) {
    return 15;
  }

  const citations = Math.max(0, work.cited_by_count ?? 0);

  return Math.min(24, 12 + Math.log10(citations + 1) * 4);
}

function layout(
  nodes: WebNode[],
  links: { source: string; target: string }[],
  width: number,
  height: number
): WebNode[] {
  const positioned = nodes.map((node) => ({ ...node }));

  const linkForce = forceLink<
    WebNode,
    { source: string; target: string }
  >(links)
    .id((node) => node.key)
    .distance(130)
    .strength(0.4);

  const simulation = forceSimulation(positioned)
    .force("link", linkForce)
    .force("charge", forceManyBody().strength(-240))
    .force("center", forceCenter(width / 2, height / 2))
    .force(
      "collide",
      forceCollide((node: SimulationNodeDatum) => {
        const candidate = node as unknown as WebNode;

        return candidate.kind === "center"
          ? 46
          : nodeRadius(candidate.work) + 12;
      })
    )
    .stop();

  // Pin the center paper to the middle of the canvas.
  const center = positioned.find((node) => node.kind === "center");

  if (center) {
    center.fx = width / 2;
    center.fy = height / 2;
  }

  for (let tick = 0; tick < 260; tick += 1) {
    simulation.tick();
  }

  return positioned;
}

export default function WebGraph({
  centerTitle,
  prior,
  derivative,
  activeKey,
  onActiveKey,
  edges,
  widened = false,
}: WebGraphProps) {
  const width = widened ? 900 : 520;
  const height = widened ? 520 : 400;

  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [zoomKey, setZoomKey] = useState<string | null>(null);

  useEffect(() => {
    setHoverKey(null);
    setZoomKey(null);
  }, [centerTitle, prior, derivative]);

  const nodes = useMemo<WebNode[]>(() => {
    return [
      {
        key: "center",
        kind: "center" as const,
        label: "CENTER",
      },
      ...prior.map((work, index) => ({
        key: work.work_id,
        kind: "prior" as const,
        label: String(index + 1),
        work,
      })),
      ...derivative.map((work, index) => ({
        key: work.work_id,
        kind: "derivative" as const,
        label: letterLabel(index),
        work,
      })),
    ];
  }, [prior, derivative]);

  // Real connection structure when the backend provided it, with a
  // star edge added for any node it does not cover. The star fallback
  // is applied per node rather than wholesale: the neighborhood now
  // unions OpenAlex with Semantic Scholar and Crossref, and only
  // OpenAlex returns each neighbor's own reference list, so a row from
  // another source has no edge in the payload. Falling back only when
  // `edges` is empty would leave those nodes unlinked, and the
  // force layout would float them free of the center.
  const nodeKeys = useMemo(
    () => new Set(nodes.map((node) => node.key)),
    [nodes]
  );

  const edgeList = useMemo<WebEdge[]>(() => {
    const real = (
      edges && edges.length > 0 ? edges : []
    ).filter(
      ([from, to]) => nodeKeys.has(from) && nodeKeys.has(to)
    );

    const linked = new Set<string>();

    for (const [from, to] of real) {
      linked.add(from);
      linked.add(to);
    }

    const star = nodes
      .filter(
        (node) =>
          node.kind !== "center" && !linked.has(node.key)
      )
      .map<WebEdge>((node) => [
        node.key,
        "center",
        1,
        node.kind === "derivative" ? "cit" : "ref",
      ]);

    return [...real, ...star];
  }, [edges, nodes, nodeKeys]);

  const positioned = useMemo(() => {
    const links = edgeList.map(([from, to]) => ({
      source: from,
      target: to,
    }));

    return layout(nodes, links, width, height);
  }, [nodes, edgeList, width, height]);

  const nodeMap = useMemo(
    () => new Map(positioned.map((node) => [node.key, node])),
    [positioned]
  );

  // Hover wins over the outside highlight for the transient dim.
  const highlightKey = hoverKey ?? activeKey;

  const zoomWork = useMemo(
    () =>
      [...prior, ...derivative].find(
        (work) => work.work_id === zoomKey
      ) ?? null,
    [prior, derivative, zoomKey]
  );

  const zoomStyle = useMemo(() => {
    const transition =
      "transform 450ms cubic-bezier(0.22, 1, 0.36, 1)";

    const node = zoomKey === null ? null : nodeMap.get(zoomKey) ?? null;

    if (!node) {
      return {
        transform: "translate(0px, 0px) scale(1)",
        transition,
        transformBox: "view-box" as const,
        transformOrigin: "0 0",
      };
    }

    return {
      transform: `translate(${width / 2 - ZOOM_SCALE * (node.x ?? 0)}px, ${
        height / 2 - ZOOM_SCALE * (node.y ?? 0)
      }px) scale(${ZOOM_SCALE})`,
      transition,
      transformBox: "view-box" as const,
      transformOrigin: "0 0",
    };
  }, [nodeMap, zoomKey, width, height]);

  function handleNodeClick(node: WebNode) {
    if (node.kind === "center") {
      setZoomKey(null);
      onActiveKey(null);
      return;
    }

    const next = zoomKey === node.key ? null : node.key;

    setZoomKey(next);
    onActiveKey(next);
  }

  // ----------------------------------------------------------
  // FOCUSED DETAILS POP-UP — auto-focused like the pet's
  // right-click menu; Escape or a click anywhere outside dismisses
  // it and the canvas zooms back out.
  // ----------------------------------------------------------

  const detailsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (zoomKey !== null) {
      detailsRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
      detailsRef.current?.focus({ preventScroll: true });
    }
  }, [zoomKey]);

  useEffect(() => {
    if (zoomKey === null) {
      return;
    }

    function dismiss() {
      setZoomKey(null);
      onActiveKey(null);
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
  }, [zoomKey, onActiveKey]);

  const relatedCount = prior.length + derivative.length;

  return (
    <div className="overflow-hidden text-gray-900" data-web-graph>
      {/* HEADER — same block as the local graph */}
      <div className="px-4 py-4">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-bold leading-snug text-gray-900">
              Similar Papers
            </h3>

            <p className="mt-1 text-sm text-gray-600">
              Similar papers cluster together. Selecting a node
              highlights the similarity path back to the origin.
            </p>
          </div>

          <span
            className="shrink-0 rounded border-[3px] border-gray-900 bg-white px-2 py-0.5 text-center text-sm font-bold leading-snug"
            style={{ width: "clamp(72px, 22%, 140px)" }}
          >
            {relatedCount} related
          </span>
        </div>
      </div>

      <div className="relative border-t-[3px] border-gray-900 bg-canvas px-2 py-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`mx-auto block h-auto w-full ${
            widened ? "max-w-[960px]" : "max-w-[520px]"
          }`}
          role="img"
          aria-label="Web citation connection graph"
          onMouseLeave={() => setHoverKey(null)}
        >
          {/* ZOOM LAYER — click a node to scale/recenter here */}
          <g style={zoomStyle}>
            {/* EDGES — center star + inter-work structure */}
            {edgeList.map(([from, to, weight, kind]) => {
              const source = nodeMap.get(from);
              const target = nodeMap.get(to);

              if (!source || !target) {
                return null;
              }

              const edgeKey = `${from}-${to}`;

              const isActive =
                highlightKey !== null &&
                (highlightKey === from || highlightKey === to);

              const dimmed = highlightKey !== null && !isActive;

              const isCenterLink =
                kind === "ref" || kind === "cit";

              const baseWidth = isCenterLink
                ? 1.5
                : kind === "cites"
                  ? 1.2
                  : 1 + weight * 1.5;

              return (
                <line
                  key={edgeKey}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="rgb(var(--ink))"
                  strokeWidth={isActive ? 3 : baseWidth}
                  strokeLinecap="butt"
                  opacity={
                    dimmed
                      ? 0.08
                      : isActive
                        ? 0.95
                        : isCenterLink
                          ? 0.5
                          : kind === "cites"
                            ? 0.42
                            : 0.28
                  }
                  strokeDasharray={
                    kind === "cites"
                      ? "3 3"
                      : kind === "cit"
                        ? "5 4"
                        : undefined
                  }
                />
              );
            })}

            {/* NODES */}
            {positioned.map((node) => {
              const isCenter = node.kind === "center";
              const isActive = highlightKey === node.key;
              const isZoomed = zoomKey === node.key;
              const dimmed =
                highlightKey !== null && !isActive && !isCenter;

              const work = node.work;
              const radius = isCenter ? 26 : nodeRadius(work);

              return (
                <g
                  key={node.key}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    isCenter
                      ? `Center paper: ${centerTitle}. Click to zoom out.`
                      : `${node.kind === "prior" ? "Prior work" : "Derivative work"} ${node.label}: ${work?.title ?? node.key}`
                  }
                  aria-pressed={isZoomed}
                  onClick={() => handleNodeClick(node)}
                  onMouseEnter={() => !isCenter && setHoverKey(node.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleNodeClick(node);
                    }
                  }}
                  className="cursor-pointer outline-none"
                  opacity={dimmed ? 0.35 : 1}
                  style={{ transition: "opacity 100ms" }}
                >
                  {isCenter && (
                    <circle
                      cx={(node.x ?? 0) + 4}
                      cy={(node.y ?? 0) + 4}
                      r={26}
                      fill="rgb(var(--ink))"
                    />
                  )}

                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={radius}
                    fill={
                      isCenter
                        ? "rgb(var(--ink))"
                        : isActive || isZoomed
                          ? "rgb(var(--accent))"
                          : "#ffffff"
                    }
                    stroke="rgb(var(--ink))"
                    strokeWidth={OUTLINE}
                  />

                  <text
                    x={node.x}
                    y={(node.y ?? 0) + 5}
                    textAnchor="middle"
                    fontSize={isCenter ? 10 : 13}
                    fontWeight={700}
                    fill={
                      isCenter
                        ? "rgb(var(--canvas))"
                        : isActive || isZoomed
                          ? "rgb(var(--on-accent))"
                          : "rgb(var(--ink))"
                    }
                    pointerEvents="none"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* NODE DETAILS — raised while a node is zoomed in */}
        {zoomWork && (
          <div
            ref={detailsRef}
            data-web-node-details
            role="dialog"
            aria-label="Work details"
            tabIndex={-1}
            className="animate-step-in pointer-events-none absolute bottom-3 left-3 right-3 z-10 rounded border-[3px] border-gray-900 bg-white p-3 shadow-[4px_4px_0_rgba(0,0,0,0.25)] focus:outline-none sm:right-auto sm:max-w-md"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[2px] border-gray-900 bg-gray-900 font-mono text-xs font-bold text-white">
                {prior.some((entry) => entry.work_id === zoomWork.work_id)
                  ? prior.findIndex(
                      (entry) => entry.work_id === zoomWork.work_id
                    ) + 1
                  : letterLabel(
                      derivative.findIndex(
                        (entry) => entry.work_id === zoomWork.work_id
                      )
                    )}
              </span>

              <button
                type="button"
                aria-label="Close details and zoom out"
                onClick={() => {
                  setZoomKey(null);
                  onActiveKey(null);
                }}
                className="pointer-events-auto rounded border-2 border-gray-900 bg-white px-1.5 py-0.5 text-gray-900 transition-colors pixel-ease hover:bg-accent hover:text-onAccent"
              >
                <CloseX className="h-3 w-3" />
              </button>
            </div>

            <p className="mt-1.5 text-sm font-bold leading-snug text-gray-900">
              {zoomWork.title ?? zoomWork.work_id}
            </p>

            <p className="mt-0.5 text-xs text-gray-600">
              {zoomWork.author ?? "Unknown author"}
              {zoomWork.publication_year
                ? `, ${zoomWork.publication_year}`
                : ""}
              {zoomWork.cited_by_count !== null
                ? ` · ${zoomWork.cited_by_count} citations`
                : ""}
            </p>

            <p className="mt-1 flex flex-wrap gap-3 text-xs">
              {zoomWork.doi && (
                <a
                  href={`https://doi.org/${zoomWork.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="pointer-events-auto break-all text-accent underline"
                >
                  doi.org/{zoomWork.doi}
                </a>
              )}

              <a
                href={`https://openalex.org/${zoomWork.work_id}`}
                target="_blank"
                rel="noreferrer"
                className="pointer-events-auto text-accent underline"
              >
                openalex.org/{zoomWork.work_id}
              </a>
            </p>
          </div>
        )}

        {/* LEGEND */}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-2 text-sm text-gray-900">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border-[3px] border-gray-900 bg-gray-900"
            />
            Center paper
          </span>

          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border-[3px] border-gray-900 bg-white"
            />
            Prior works (1, 2, 3…)
          </span>

          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border-[3px] border-dashed border-gray-900 bg-white"
            />
            Derivative works (a, b, c…)
          </span>

          <span className="flex items-center gap-2">
            <svg
              aria-hidden="true"
              className="h-3 w-6"
              viewBox="0 0 24 12"
              fill="none"
            >
              <line
                x1="0"
                y1="6"
                x2="24"
                y2="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="3 3"
              />
            </svg>
            Cites / shared references
          </span>
        </div>
      </div>

      {/* FOOTER HINT */}
      <div className="border-t-[3px] border-gray-900 bg-white px-4 py-3">
        <p className="text-xs leading-5 text-gray-600">
          {zoomWork
            ? "Node details are pinned above; click it again or close the card to zoom back out."
            : "Connections come from OpenAlex reference lists: citing links, shared references (co-reference), and co-citations. Click a node to zoom into it."}
        </p>
      </div>
    </div>
  );
}

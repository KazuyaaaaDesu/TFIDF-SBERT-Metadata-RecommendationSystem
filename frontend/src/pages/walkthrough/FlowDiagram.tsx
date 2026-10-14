/**
 * FLOW DIAGRAM — hand-drawn SVG boxes-and-arrows for the Engine
 * page, matching the retro white/ink aesthetic of the walkthrough.
 *
 * Nodes are positioned explicitly (x, y, w, h) so a diagram reads
 * like a static figure, but the text is laid out for you: labels and
 * sub-labels are word-wrapped to the node width, a node grows (about
 * its center) when its text needs more room, edges that share a node
 * fan out along its side instead of piling on one point, edge labels
 * sit on a white pill, and the viewBox is computed from everything
 * that is drawn so nothing can be clipped.
 */

import { useId } from "react";
import { Maximize2 } from "lucide-react";
import ResponsiveLabel from "../../components/ResponsiveLabel";
import { useLightbox } from "./lightbox";

export interface FlowNode {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  /** Minimum height; the node grows when its wrapped text needs more. */
  h: number;
  /** Accent-filled node (the output of the stage). */
  accent?: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

const LABEL_SIZE = 13;
const SUB_SIZE = 11;
const LABEL_LH = 16;
const SUB_LH = 14;
const NODE_PAD_X = 10;
const NODE_PAD_Y = 9;
const BLOCK_GAP = 3;
const EDGE_LABEL_SIZE = 11;
const VIEW_PAD = 14;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Rendered width of a string; canvas-measured when possible, estimated otherwise. */
function textWidth(text: string, size: number, bold: boolean): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }

  if (measureCtx) {
    const family = typeof document !== "undefined" ? getComputedStyle(document.body).fontFamily : "sans-serif";
    measureCtx.font = `${bold ? 700 : 400} ${size}px ${family}`;
    return measureCtx.measureText(text).width * 1.03;
  }

  let total = 0;
  for (const ch of text) {
    const upper = ch >= "A" && ch <= "Z";
    total += size * (upper ? 0.72 : ch === " " ? 0.3 : 0.58) * (bold ? 1.06 : 1);
  }
  return total;
}

/** Greedy word wrap to `maxWidth`; a word wider than that stays on its own line. */
function wrap(text: string, maxWidth: number, size: number, bold: boolean): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (!current || textWidth(next, size, bold) <= maxWidth) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length ? lines : [""];
}

interface Laid extends FlowNode {
  labelLines: string[];
  subLines: string[];
}

function layoutNode(node: FlowNode): Laid {
  const longest = (text: string, size: number, bold: boolean) =>
    Math.max(0, ...text.split(/\s+/).map((word) => textWidth(word, size, bold)));

  // Widen (about the center) only if a single word cannot fit.
  const minInner = Math.max(
    longest(node.label, LABEL_SIZE, true),
    node.sub ? longest(node.sub, SUB_SIZE, false) : 0,
  );
  const w = Math.max(node.w, Math.ceil(minInner + NODE_PAD_X * 2));
  const x = node.x - (w - node.w) / 2;
  const inner = w - NODE_PAD_X * 2;

  const labelLines = wrap(node.label, inner, LABEL_SIZE, true);
  const subLines = node.sub ? wrap(node.sub, inner, SUB_SIZE, false) : [];
  const textH =
    labelLines.length * LABEL_LH + (subLines.length ? BLOCK_GAP + subLines.length * SUB_LH : 0);
  const h = Math.max(node.h, Math.ceil(textH + NODE_PAD_Y * 2));
  const y = node.y - (h - node.h) / 2;

  return { ...node, x, y, w, h, labelLines, subLines };
}

interface Anchor {
  x: number;
  y: number;
}

interface Route {
  edge: FlowEdge;
  start: Anchor;
  end: Anchor;
}

export default function FlowDiagram({
  nodes,
  edges,
  title,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Deprecated: the viewBox now follows the drawn content. */
  width?: number;
  /** Deprecated: the viewBox now follows the drawn content. */
  height?: number;
  title?: string;
}) {
  const markerId = `flow-arrow-${useId().replace(/:/g, "")}`;
  const laid = nodes.map(layoutNode);
  const byId = new Map(laid.map((node) => [node.id, node]));

  // ---- routing: right→left when there is a gap, else bottom→top / top→bottom ----
  type Side = "right" | "left" | "bottom" | "top";
  const pending = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to) {
      return [];
    }

    let outSide: Side = "right";
    let inSide: Side = "left";

    if (to.x < from.x + from.w - 1) {
      const below = to.y + to.h / 2 > from.y + from.h / 2;
      outSide = below ? "bottom" : "top";
      inSide = below ? "top" : "bottom";
    }

    return [{ edge, from, to, outSide, inSide }];
  });

  // Edges that share one side of a node are spread along it.
  const slots = new Map<string, { edge: FlowEdge; other: Laid }[]>();
  const slotKey = (id: string, side: Side) => `${id}:${side}`;

  for (const item of pending) {
    const out = slotKey(item.from.id, item.outSide);
    const inn = slotKey(item.to.id, item.inSide);
    slots.set(out, [...(slots.get(out) ?? []), { edge: item.edge, other: item.to }]);
    slots.set(inn, [...(slots.get(inn) ?? []), { edge: item.edge, other: item.from }]);
  }

  function anchor(node: Laid, side: Side, edge: FlowEdge): Anchor {
    const group = slots.get(slotKey(node.id, side)) ?? [];
    const vertical = side === "left" || side === "right";
    const sorted = [...group].sort((a, b) =>
      vertical
        ? a.other.y + a.other.h / 2 - (b.other.y + b.other.h / 2)
        : a.other.x + a.other.w / 2 - (b.other.x + b.other.w / 2),
    );
    const index = Math.max(0, sorted.findIndex((entry) => entry.edge === edge));
    const t = sorted.length > 1 ? 0.15 + (0.7 * index) / (sorted.length - 1) : 0.5;

    if (side === "right") return { x: node.x + node.w, y: node.y + node.h * t };
    if (side === "left") return { x: node.x, y: node.y + node.h * t };
    if (side === "bottom") return { x: node.x + node.w * t, y: node.y + node.h };
    return { x: node.x + node.w * t, y: node.y };
  }

  const routes: Route[] = pending.map(({ edge, from, to, outSide, inSide }) => ({
    edge,
    start: anchor(from, outSide, edge),
    end: anchor(to, inSide, edge),
  }));

  // ---- edge-label pills ----
  const pills = routes
    .filter(({ edge }) => edge.label)
    .map(({ edge, start, end }) => {
      const text = edge.label as string;
      const w = Math.ceil(textWidth(text, EDGE_LABEL_SIZE, true)) + 14;
      const h = 18;
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      return { key: `${edge.from}->${edge.to}`, text, x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
    });

  // ---- viewBox from everything drawn ----
  const xs: number[] = [];
  const ys: number[] = [];

  for (const node of laid) {
    xs.push(node.x, node.x + node.w);
    ys.push(node.y, node.y + node.h);
  }
  for (const pill of pills) {
    xs.push(pill.x, pill.x + pill.w);
    ys.push(pill.y, pill.y + pill.h);
  }

  const minX = Math.min(...xs) - VIEW_PAD;
  const minY = Math.min(...ys) - VIEW_PAD;
  const vbW = Math.max(...xs) + VIEW_PAD - minX;
  const vbH = Math.max(...ys) + VIEW_PAD - minY;

  const diagram = (
    <svg
      viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
      role="img"
      aria-label={title ?? "Flow diagram"}
      className="block w-full"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "rgb(var(--ink))" }} />
        </marker>
      </defs>

      {routes.map(({ edge, start, end }) => {
        // Stop a hair short so the arrow tip lands on the node border.
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.hypot(dx, dy) || 1;
        const tipX = end.x - (dx / len) * 5;
        const tipY = end.y - (dy / len) * 5;

        return (
          <line
            key={`${edge.from}->${edge.to}`}
            x1={start.x}
            y1={start.y}
            x2={tipX}
            y2={tipY}
            style={{ stroke: "rgb(var(--ink))" }}
            strokeWidth={2}
            strokeDasharray={edge.dashed ? "5 4" : undefined}
            markerEnd={`url(#${markerId})`}
          />
        );
      })}

      {laid.map((node, nodeIndex) => {
        const cx = node.x + node.w / 2;
        const cy = node.y + node.h / 2;
        const blockH =
          node.labelLines.length * LABEL_LH +
          (node.subLines.length ? BLOCK_GAP + node.subLines.length * SUB_LH : 0);
        const top = cy - blockH / 2;
        const subTop = top + node.labelLines.length * LABEL_LH + BLOCK_GAP;

        return (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx={6}
              style={{
                fill: node.accent ? "rgb(var(--accent))" : "rgb(var(--surface))",
                stroke: "rgb(var(--ink))",
              }}
              strokeWidth={2}
            />

            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={LABEL_SIZE}
              fontWeight={700}
              style={{ fill: node.accent ? "rgb(var(--on-accent))" : "rgb(var(--ink))" }}
            >
              {node.labelLines.map((line, index) => (
                <tspan key={index} x={cx} y={top + LABEL_LH * (index + 0.5)}>
                  {line}
                </tspan>
              ))}
            </text>

            {node.subLines.length > 0 && (
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={SUB_SIZE}
                style={{ fill: node.accent ? "rgb(var(--on-accent))" : "rgb(var(--muted))" }}
              >
                {node.subLines.map((line, index) => (
                  <tspan key={index} x={cx} y={subTop + SUB_LH * (index + 0.5)}>
                    {line}
                  </tspan>
                ))}
              </text>
            )}
            <g aria-hidden="true">
              <circle
                cx={node.x}
                cy={node.y}
                r={11}
                style={{ fill: "rgb(var(--surface))", stroke: "rgb(var(--accent))" }}
                strokeWidth={2}
              />
              <text
                x={node.x}
                y={node.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={800}
                style={{ fill: "rgb(var(--accent))" }}
              >
                {nodeIndex + 1}
              </text>
            </g>
          </g>
        );
      })}

      {pills.map((pill) => (
        <g key={pill.key}>
          <rect
            x={pill.x}
            y={pill.y}
            width={pill.w}
            height={pill.h}
            rx={4}
            style={{ fill: "rgb(var(--surface))", stroke: "rgb(var(--ink))" }}
            strokeWidth={1.25}
          />
          <text
            x={pill.cx}
            y={pill.cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={EDGE_LABEL_SIZE}
            fontWeight={700}
            style={{ fill: "rgb(var(--muted))" }}
          >
            {pill.text}
          </text>
        </g>
      ))}
    </svg>
  );
  const { open, element } = useLightbox();
  const fullWidth = Math.max(vbW * 1.4, 1400);

  return (
    <figure data-eng-diagram="" className="clear-both relative rounded border-[2px] border-gray-900 bg-white">
      <div className="flex items-center justify-between gap-3 border-b-[2px] border-gray-900 bg-surface px-3 py-1.5">
        <figcaption className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
          {title ?? "Diagram"}
        </figcaption>
        <button
          type="button"
          onClick={(event) =>
            open([{ title: title ?? "Diagram", node: diagram, nodeWidth: fullWidth }], 0, event.currentTarget)
          }
          aria-label="Full screen"
          title="Full screen"
          className="inline-flex items-center rounded border-2 border-gray-900 bg-white px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-ink transition-colors pixel-ease hover:bg-accentSoft"
        >
          <ResponsiveLabel icon={Maximize2} iconClassName="h-3.5 w-3.5 shrink-0">⤢ Full screen</ResponsiveLabel>
        </button>
      </div>

      {/* Scrolls in both directions; click to open it full screen. */}
      <div
        className="max-h-[340px] cursor-zoom-in overflow-auto p-3"
        onClick={(event) =>
          open([{ title: title ?? "Diagram", node: diagram, nodeWidth: fullWidth }], 0, event.currentTarget)
        }
        title="Scroll to pan, click to view full screen"
      >
        <div style={{ minWidth: Math.round(vbW * 0.75) }}>{diagram}</div>
      </div>
      <ol aria-label="Callouts" className="eng-legend">
        {laid.map((node, nodeIndex) => (
          <li key={node.id}>
            <span className="eng-pin">{nodeIndex + 1}</span>
            <span>
              <strong>{node.label}</strong>
              {node.sub ? <em>{node.sub}</em> : null}
            </span>
          </li>
        ))}
      </ol>
      {element}
    </figure>
  );
}

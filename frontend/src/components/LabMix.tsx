/**
 * The Lab bench's instruments: a graduated dial per signal, a stacked bar
 * showing the blend, and a small triangle that marks where the blend sits
 * between the three signals (the same triangle the Sweep draws in full).
 */

import { useRef, type CSSProperties, type PointerEvent } from "react";

import { blendFromPoint } from "../utils/blend.ts";

export type Mix = { tfidf: number; sbert: number; metadata: number };

const SIGNALS = ["tfidf", "sbert", "metadata"] as const;
const NAMES: Record<(typeof SIGNALS)[number], string> = {
  tfidf: "TF-IDF",
  sbert: "S-BERT",
  metadata: "Metadata",
};
// Signal colours for the dial fill (RGB triplets the stylesheet reads).
const FILL: Record<(typeof SIGNALS)[number], string> = {
  tfidf: "var(--gray-900)",
  sbert: "var(--accent)",
  metadata: "var(--gray-500)",
};

export function LabDial({
  signal,
  value,
  onChange,
}: {
  signal: (typeof SIGNALS)[number];
  value: number;
  onChange: (value: number) => void;
}) {
  const id = `lab-${signal}`;

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink">
          <span aria-hidden="true" className={`inline-block h-3 w-3 border-2 border-gray-900 lab-sig-${signal}`} />
          {NAMES[signal]}
        </label>
        <output htmlFor={id} className="lab-readout">
          {value}%
        </output>
      </div>
      <div className="lab-dial">
        <div className="lab-dial-ticks" aria-hidden="true" />
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="lab-range"
          style={{ "--fill": `${value}%`, "--signal": FILL[signal] } as CSSProperties}
        />
      </div>
    </div>
  );
}

/** The blend as one bar: how the 100% is divided. */
export function MixBar({ mix }: { mix: Mix }) {
  const total = mix.tfidf + mix.sbert + mix.metadata || 1;

  return (
    <div>
      <div
        role="img"
        aria-label={SIGNALS.map((s) => `${NAMES[s]} ${Math.round((mix[s] / total) * 100)}%`).join(", ")}
        className="flex h-4 overflow-hidden border-2 border-gray-900"
      >
        {SIGNALS.map((signal) => (
          <div
            key={signal}
            className={`lab-sig-${signal} transition-[width]`}
            style={{ width: `${(mix[signal] / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

const W = 132;
const H = 118;
const CORNER = { tfidf: [W / 2, 18], sbert: [10, H - 14], metadata: [W - 10, H - 14] } as const;

/**
 * A dot on the blend triangle. With `onChange` the triangle is a control:
 * press or drag anywhere on it to set the blend (the dials beside it do
 * the same for keyboard users).
 */
export function TriangleLocator({
  mix,
  onChange,
  width = 104,
}: {
  mix: Mix;
  onChange?: (mix: Mix) => void;
  width?: number;
}) {
  const svg = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  const total = mix.tfidf + mix.sbert + mix.metadata || 1;
  const [t, s, m] = [mix.tfidf / total, mix.sbert / total, mix.metadata / total];
  const x = t * CORNER.tfidf[0] + s * CORNER.sbert[0] + m * CORNER.metadata[0];
  const y = t * CORNER.tfidf[1] + s * CORNER.sbert[1] + m * CORNER.metadata[1];

  function pick(event: PointerEvent<SVGSVGElement>) {
    const box = svg.current?.getBoundingClientRect();

    if (!box || !onChange) return;

    const point = [
      ((event.clientX - box.left) / box.width) * W,
      ((event.clientY - box.top) / box.height) * H,
    ] as const;

    onChange(blendFromPoint(point, CORNER.tfidf, CORNER.sbert, CORNER.metadata));
  }

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width, touchAction: onChange ? "none" : undefined, cursor: onChange ? "crosshair" : undefined }}
      role="img"
      aria-label={`Blend position: ${Math.round(t * 100)} / ${Math.round(s * 100)} / ${Math.round(m * 100)}${onChange ? ". Drag to change; the dials do the same." : ""}`}
      onPointerDown={(event) => {
        if (!onChange) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) pick(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <polygon
        points={`${CORNER.tfidf.join(",")} ${CORNER.sbert.join(",")} ${CORNER.metadata.join(",")}`}
        fill="rgb(var(--gray-900) / 0.05)"
        stroke="rgb(var(--gray-900))"
        strokeWidth={2}
      />
      <line x1={x} y1={y} x2={CORNER.tfidf[0]} y2={CORNER.tfidf[1]} stroke="rgb(var(--gray-900) / 0.25)" strokeDasharray="3 3" />
      <line x1={x} y1={y} x2={CORNER.sbert[0]} y2={CORNER.sbert[1]} stroke="rgb(var(--gray-900) / 0.25)" strokeDasharray="3 3" />
      <line x1={x} y1={y} x2={CORNER.metadata[0]} y2={CORNER.metadata[1]} stroke="rgb(var(--gray-900) / 0.25)" strokeDasharray="3 3" />
      <circle cx={x} cy={y} r={onChange ? 7 : 6} fill="rgb(var(--accent))" stroke="rgb(var(--gray-900))" strokeWidth={2} />
      <text x={CORNER.tfidf[0]} y={10} textAnchor="middle" className="fill-current font-mono text-[8px] font-bold text-muted">T</text>
      <text x={CORNER.sbert[0] - 4} y={H - 1} className="fill-current font-mono text-[8px] font-bold text-muted">S</text>
      <text x={CORNER.metadata[0] + 4} y={H - 1} textAnchor="end" className="fill-current font-mono text-[8px] font-bold text-muted">M</text>
    </svg>
  );
}

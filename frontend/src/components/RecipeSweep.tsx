/**
 * Lab · Sweep: an experimental fork of the tournament for recipes.
 *
 * Instead of six fixed pipelines on many queries, it scores a whole grid
 * of TF-IDF / S-BERT / metadata blends on leave-one-out queries and draws
 * the result on the blend triangle. The heat map is for exploring; the
 * "honest check" (pick on one half of the queries, confirm on the other,
 * compare with the presets) is the only part that is a finding.
 */

import { useRef, useState } from "react";

import {
  runRecipeSweep,
  type SweepCell,
  type SweepResult,
  type SweepWeights,
} from "../api";
import PixelProgress from "./retro/PixelProgress";
import { readSweep, recipeText } from "../utils/sweepReading.ts";

interface Props {
  presetName: (id: string) => string;
  /** Put a blend on the Lab bench. */
  onLoad: (weights: SweepWeights) => void;
}

// Triangle corners: TF-IDF top, S-BERT bottom left, metadata bottom right.
const W = 360;
const H = 330;
const CORNER = {
  tfidf: [W / 2, 26],
  sbert: [34, H - 38],
  metadata: [W - 34, H - 38],
} as const;

function project(w: SweepWeights): [number, number] {
  const sum = w.tfidf + w.sbert + w.metadata || 1;
  const t = w.tfidf / sum;
  const s = w.sbert / sum;
  const m = w.metadata / sum;

  return [
    t * CORNER.tfidf[0] + s * CORNER.sbert[0] + m * CORNER.metadata[0],
    t * CORNER.tfidf[1] + s * CORNER.sbert[1] + m * CORNER.metadata[1],
  ];
}

const PRESET_WEIGHTS: Record<string, SweepWeights> = {
  tfidf: { tfidf: 100, sbert: 0, metadata: 0 },
  sbert: { tfidf: 0, sbert: 100, metadata: 0 },
  tfidf_sbert: { tfidf: 50, sbert: 50, metadata: 0 },
  tfidf_metadata: { tfidf: 67, sbert: 0, metadata: 33 },
  sbert_metadata: { tfidf: 0, sbert: 67, metadata: 33 },
  tfidf_sbert_metadata: { tfidf: 40, sbert: 40, metadata: 20 },
};

const field =
  "ui-input !w-24 !py-1 font-mono text-xs";

export default function RecipeSweep({ presetName, onLoad }: Props) {
  const [nQueries, setNQueries] = useState(30);
  const [k, setK] = useState(10);
  const [step, setStep] = useState(10);
  const [minRefs, setMinRefs] = useState(3);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<SweepCell | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function start() {
    abort.current?.abort();
    const controller = new AbortController();

    abort.current = controller;
    setRunning(true);
    setError("");
    setResult(null);
    setPicked(null);
    setProgress(null);

    try {
      const done = await runRecipeSweep(
        { nQueries, k, step, minRefs, seed: Math.floor(Math.random() * 1_000_000) },
        (event) => {
          if (event.event === "progress") setProgress({ done: event.done, total: event.total });
        },
        controller.signal,
      );

      setResult(done);
      setPicked(done.top[0] ?? null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "The sweep failed.");
    } finally {
      if (abort.current === controller) setRunning(false);
    }
  }

  const means = result?.grid.map((c) => c.mean) ?? [];
  const lo = means.length ? Math.min(...means) : 0;
  const hi = means.length ? Math.max(...means) : 1;
  const radius = step <= 5 ? 5 : step <= 10 ? 9 : step <= 20 ? 14 : 17;
  const best = result?.top[0];

  return (
    <div className="space-y-4">
      <section className="lab-card">
        <p className="lab-label lab-label--hot">Recipe sweep · experimental</p>
        <h2 className="font-pixelify text-lg font-bold text-ink">Where does quality live on the blend triangle?</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          Scores a grid of blends on papers whose references are known, and draws where on the triangle the
          quality is. Each query is searched once and every blend is re-ranked from the same component scores, so
          it is fast. Nothing is saved.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            Queries
            <input
              type="number"
              min={4}
              max={100}
              value={nQueries}
              disabled={running}
              onChange={(e) => setNQueries(Math.min(100, Math.max(4, Number(e.target.value) || 4)))}
              className={`${field} mt-1 block`}
            />
          </label>
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            Depth
            <select value={k} disabled={running} onChange={(e) => setK(Number(e.target.value))} className={`${field} mt-1 block`}>
              <option value={5}>nDCG@5</option>
              <option value={10}>nDCG@10</option>
              <option value={20}>nDCG@20</option>
            </select>
          </label>
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            Grid step
            <select value={step} disabled={running} onChange={(e) => setStep(Number(e.target.value))} className={`${field} mt-1 block`}>
              <option value={25}>25% (15 blends)</option>
              <option value={20}>20% (21)</option>
              <option value={10}>10% (66)</option>
              <option value={5}>5% (231)</option>
            </select>
          </label>
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            Min refs
            <input
              type="number"
              min={1}
              max={20}
              value={minRefs}
              disabled={running}
              onChange={(e) => setMinRefs(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              className={`${field} mt-1 block`}
            />
          </label>
          {running ? (
            <button type="button" className="ui-button ui-button-danger" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          ) : (
            <button type="button" className="ui-button ui-button-primary" onClick={() => void start()}>
              Run sweep
            </button>
          )}
        </div>

        {running && (
          <div className="mt-3" aria-live="polite">
            <PixelProgress
              value={progress ? progress.done / progress.total : null}
              stage={progress ? `QUERY ${progress.done} OF ${progress.total}` : "PREPARING QUERIES"}
            />
          </div>
        )}
        {error && <p className="status-error mt-3">{error}</p>}
      </section>

      {result && (
        <>
          <section className="lab-card">
            <p className="lab-label">Reading</p>
            <h3 className="sr-only">What it says</h3>
            <div className="mt-2 space-y-2 text-sm leading-6 text-ink">
              {readSweep(result, presetName).map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
            {result.skipped > 0 && (
              <p className="mt-2 text-xs text-muted">{result.skipped} queries could not be scored and were left out.</p>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
            <div className="lab-card">
              <p className="lab-label">Blend triangle · {result.metric}</p>
              <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" role="group" aria-label="Quality by blend">
                <polygon
                  points={`${CORNER.tfidf.join(",")} ${CORNER.sbert.join(",")} ${CORNER.metadata.join(",")}`}
                  fill="none"
                  stroke="rgb(var(--gray-900))"
                  strokeWidth={2}
                />
                {result.grid.map((cell) => {
                  const [x, y] = project(cell.weights);
                  const norm = hi > lo ? (cell.mean - lo) / (hi - lo) : 0.5;
                  const isBest = best && recipeText(best.weights) === recipeText(cell.weights);
                  const isPicked = picked && recipeText(picked.weights) === recipeText(cell.weights);

                  return (
                    <circle
                      key={recipeText(cell.weights)}
                      cx={x}
                      cy={y}
                      r={radius}
                      fill="rgb(var(--accent))"
                      fillOpacity={0.12 + 0.88 * norm}
                      stroke="rgb(var(--gray-900))"
                      strokeWidth={isPicked ? 3 : isBest ? 2 : 0.5}
                      className="cursor-pointer"
                      onClick={() => setPicked(cell)}
                    >
                      <title>{`${recipeText(cell.weights)} → ${cell.mean.toFixed(3)}`}</title>
                    </circle>
                  );
                })}
                {Object.entries(PRESET_WEIGHTS).map(([id, w]) => {
                  const [x, y] = project(w);

                  return (
                    <g key={id} pointerEvents="none">
                      <rect x={x - 3} y={y - 3} width={6} height={6} transform={`rotate(45 ${x} ${y})`} fill="rgb(var(--gray-900))" />
                    </g>
                  );
                })}
                <text x={CORNER.tfidf[0]} y={14} textAnchor="middle" className="fill-current font-mono text-[11px] font-bold text-ink">
                  TF-IDF
                </text>
                <text x={CORNER.sbert[0]} y={H - 14} textAnchor="start" className="fill-current font-mono text-[11px] font-bold text-ink">
                  S-BERT
                </text>
                <text x={CORNER.metadata[0]} y={H - 14} textAnchor="end" className="fill-current font-mono text-[11px] font-bold text-ink">
                  Metadata
                </text>
              </svg>
              <p className="text-[11px] leading-4 text-muted">
                Darker is better. Corners are single signals. ◆ marks the six presets. Click a blend to inspect it.
              </p>
              {picked && (
                <div className="mt-2 rounded border-[2px] border-gray-900 bg-canvas p-2 font-mono text-xs text-ink">
                  <p className="font-bold">
                    {recipeText(picked.weights)} · {picked.mean.toFixed(3)}
                  </p>
                  <button
                    type="button"
                    className="mt-1 rounded border-[2px] border-gray-900 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] hover:bg-accentSoft"
                    onClick={() => onLoad(picked.weights)}
                  >
                    Load on the bench
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="lab-card">
                <p className="lab-label">Best blends · exploratory</p>
                <table className="mt-1 w-full border-collapse text-left font-mono text-xs">
                  <thead>
                    <tr className="border-b-[3px] border-gray-900 text-[10px] uppercase tracking-[0.12em] text-muted">
                      <th className="py-1">TF-IDF / S-BERT / meta</th>
                      <th className="text-right">{result.metric}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.top.map((cell) => (
                      <tr key={recipeText(cell.weights)} className="border-b border-gray-300 text-ink">
                        <td className="py-1 font-bold">{recipeText(cell.weights)}</td>
                        <td className="text-right">{cell.mean.toFixed(3)}</td>
                        <td className="text-right">
                          <button type="button" className="px-1 font-bold underline hover:text-accent" onClick={() => onLoad(cell.weights)}>
                            load
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.preset_means && (
                  <p className="mt-2 text-[11px] leading-4 text-muted">
                    Presets on all queries:{" "}
                    {Object.entries(result.preset_means)
                      .sort((a, b) => b[1] - a[1])
                      .map(([id, mean]) => `${presetName(id)} ${mean.toFixed(3)}`)
                      .join(" · ")}
                  </p>
                )}
              </div>

              {result.heldout && (
                <div className="lab-card">
                  <p className="lab-label lab-label--hot">Honest check · chosen on {result.heldout.n_select}, scored on {result.heldout.n_confirm}</p>
                  <p className="mt-1 text-sm text-ink">
                    <strong>{recipeText(result.heldout.chosen)}</strong> reached{" "}
                    {result.heldout.chosen_confirm.mean.toFixed(3)} on the confirmation queries (95% CI{" "}
                    {result.heldout.chosen_confirm.lo.toFixed(3)} to {result.heldout.chosen_confirm.hi.toFixed(3)}).
                  </p>
                  <table className="mt-2 w-full border-collapse text-left font-mono text-xs">
                    <thead>
                      <tr className="border-b-[3px] border-gray-900 text-[10px] uppercase tracking-[0.12em] text-muted">
                        <th className="py-1">vs preset</th>
                        <th className="text-right">Preset</th>
                        <th className="text-right">Difference</th>
                        <th className="text-right">95% CI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.heldout.comparisons]
                        .sort((a, b) => b.preset_mean - a.preset_mean)
                        .map((row) => (
                          <tr key={row.preset} className="border-b border-gray-300 text-ink">
                            <td className="py-1 font-bold">
                              {presetName(row.preset)}
                              {row.clear && " ✓"}
                              {row.worse && " ✗"}
                            </td>
                            <td className="text-right">{row.preset_mean.toFixed(3)}</td>
                            <td className="text-right">
                              {row.mean_diff >= 0 ? "+" : ""}
                              {row.mean_diff.toFixed(3)}
                            </td>
                            <td className="text-right text-muted">
                              {row.lo.toFixed(3)} to {row.hi.toFixed(3)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[11px] leading-4 text-muted">
                    ✓ means the interval is entirely above zero (the blend is better); ✗ entirely below. Six
                    comparisons are shown without correction, so treat a single ✓ with care.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

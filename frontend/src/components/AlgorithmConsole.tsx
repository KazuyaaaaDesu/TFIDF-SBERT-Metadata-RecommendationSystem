/**
 * ALGORITHM CONSOLE — the always-visible algorithm controls for the
 * Repository page (the top-bar MODE chip's home).
 *
 * The six pipeline presets, and — while the Recommend scope is
 * active — Top-K and the Diversify (MMR) toggle. Choosing CUSTOM
 * opens the dial mix as a floating pop-up, so the console itself
 * never grows or disturbs the layout. Shared state means the same
 * choice applies to similarity ranking, Recommend results, and the
 * Arena.
 */

import { useEffect, useRef, useState } from "react";
import { Cpu } from "lucide-react";

import {
  pipelineName,
  pipelineConfigs,
  customPipelineConfig,
  adjustDialAllocation,
} from "../data/pipelineConfigs";
import { usePipelineMode } from "../state/pipelineMode";
import WeightBar from "./WeightBar";
import { LabDial, MixBar, TriangleLocator } from "./LabMix";

interface AlgorithmConsoleProps {
  /** True while the Recommend scope is active (Top-K + Diversify). */
  recommendMode: boolean;
  /** True while the Web scope is active: the console opens, and each
   *  algorithm re-ranks the web hits. */
  webMode?: boolean;
  topK: number;
  onTopKChange: (value: number) => void;
  diversify: boolean;
  onDiversifyChange: (value: boolean) => void;
}

function DialPopover({
  onClose,
}: {
  onClose: () => void;
}) {
  const { customWeights, setCustomWeights } = usePipelineMode();
  const popoverRef = useRef<HTMLDivElement | null>(null);

  function setDial(key: "tfidf" | "sbert" | "metadata", value: number) {
    setCustomWeights(adjustDialAllocation(customWeights, key, value));
  }

  // Close on outside click and on Escape.
  useEffect(() => {
    function handleDown(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const formulaTerms = (
    [
      ["tfidf", "s'_tfidf(d)"],
      ["sbert", "s'_sbert(d)"],
      ["metadata", "s'_meta(d)"],
    ] as const
  )
    .filter(([key]) => customWeights[key] > 0)
    .map(([key, term]) => `${customWeights[key] / 100} · ${term}`);

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Custom algorithm blend"
      className="absolute right-0 top-full z-20 mt-3 w-[340px] max-w-[calc(100vw-2rem)]"
    >
      <div className="lab-card">
        <p className="lab-label lab-label--hot">Custom blend</p>

        <div className="mb-3 flex items-center gap-3">
          <TriangleLocator
            mix={customWeights}
            width={132}
            onChange={(mix) => setCustomWeights(mix)}
          />
          <p className="text-[11px] leading-4 text-muted">
            Drag the dot toward a corner to lean on that signal, or use the dials below.
          </p>
        </div>

        <div className="mb-3">
          <MixBar mix={customWeights} />
        </div>

        {(["tfidf", "sbert", "metadata"] as const).map((key) => (
          <LabDial key={key} signal={key} value={customWeights[key]} onChange={(value) => setDial(key, value)} />
        ))}

        <p className="rounded-sm border-[2px] border-dashed border-gray-900 bg-canvas p-2 font-mono text-[11px] leading-5 text-ink">
          <span className="font-bold text-accent">S(d) =</span> {formulaTerms.join(" + ")}
        </p>
        <p className="mt-1.5 text-[11px] leading-4 text-muted">
          Dials normalize to 100% as they move; on a tie the leftover goes to Metadata.
        </p>
      </div>
    </div>
  );
}

export default function AlgorithmConsole({
  recommendMode,
  webMode = false,
  topK,
  onTopKChange,
  diversify,
  onDiversifyChange,
}: AlgorithmConsoleProps) {
  const { pipelineId, setPipelineId, customWeights } = usePipelineMode();
  const [dialsOpen, setDialsOpen] = useState(false);
  /* The full console opens by itself while ranking recommendations, and
     otherwise rests as a one-line summary so it does not take a row. */
  const [open, setOpen] = useState(recommendMode || webMode);

  useEffect(() => {
    if (recommendMode || webMode) setOpen(true);
  }, [recommendMode, webMode]);

  const activeConfig =
    pipelineId === "custom"
      ? customPipelineConfig(customWeights)
      : pipelineConfigs.find((config) => config.id === pipelineId) ??
        pipelineConfigs[pipelineConfigs.length - 1];

  if (!open) {
    return (
      <div data-algorithm-console="summary" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border-[3px] border-gray-900 bg-white px-3 py-2">
        <p className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
          <Cpu className="h-3.5 w-3.5" />
          Algorithm
        </p>
        <div className="flex items-center gap-1.5">
          <WeightBar weights={activeConfig.weights} />
          <span className="whitespace-nowrap font-mono text-xs font-bold text-ink">{pipelineName(activeConfig)}</span>
        </div>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className="ml-auto rounded border-[2px] border-gray-900 bg-surface px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink transition-colors pixel-ease hover:bg-accentSoft"
        >
          Change ▾
        </button>
      </div>
    );
  }

  return (
    <div data-algorithm-console="open" className="relative rounded border-[3px] border-gray-900 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-[0.15em] text-muted">
            <Cpu className="h-3.5 w-3.5" />
            Algorithm
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {pipelineConfigs.map((config) => {
              const active = config.id === pipelineId;

              return (
                <button
                  key={config.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setPipelineId(config.id);
                    setDialsOpen(false);
                  }}
                  title={config.label}
                  className={`rounded border-[2px] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                    active
                      ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-2px_0_rgba(0,0,0,0.3)]"
                      : "border-gray-900 bg-surface text-muted hover:text-ink"
                  }`}
                >
                  {pipelineName(config)}
                </button>
              );
            })}

            <button
              type="button"
              aria-pressed={pipelineId === "custom"}
              onClick={() => {
                setPipelineId("custom");
                setDialsOpen((value) => !value);
              }}
              title="Custom dial weights — open the dial mix"
              className={`rounded border-[2px] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                pipelineId === "custom"
                  ? "border-gray-900 bg-accent text-onAccent shadow-[inset_0_-2px_0_rgba(0,0,0,0.3)]"
                  : "border-gray-900 bg-surface text-muted hover:text-ink"
              }`}
            >
              CUSTOM {dialsOpen ? "▴" : "▾"}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <WeightBar weights={activeConfig.weights} />
            <span className="font-mono text-xs font-bold text-ink">
              {pipelineName(activeConfig)}
            </span>
          </div>

          {!recommendMode && (
            <button
              type="button"
              aria-expanded
              onClick={() => {
                setOpen(false);
                setDialsOpen(false);
              }}
              className="rounded border-[2px] border-gray-900 bg-surface px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink transition-colors pixel-ease hover:bg-accentSoft"
            >
              Hide ▴
            </button>
          )}

          {recommendMode && (
            <>
              <div className="flex items-center gap-1.5">
                <label
                  className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-muted"
                  htmlFor="algorithm-topk"
                >
                  Top K
                </label>
                <select
                  id="algorithm-topk"
                  value={topK}
                  onChange={(event) =>
                    onTopKChange(Number(event.target.value))
                  }
                  className="min-h-8 w-20 rounded border-[2px] border-gray-900 bg-field px-1 text-xs font-medium text-ink"
                >
                  {[5, 10, 15, 20, 30, 50].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                aria-pressed={diversify}
                onClick={() => onDiversifyChange(!diversify)}
                title="Spread near-duplicate papers apart (MMR re-ranking)"
                className={`rounded border-[2px] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors pixel-ease ${
                  diversify
                    ? "border-gray-900 bg-accent text-onAccent"
                    : "border-gray-900 bg-surface text-muted hover:text-ink"
                }`}
              >
                Diversify
              </button>
            </>
          )}
        </div>
      </div>

      {pipelineId === "custom" && dialsOpen && (
        <DialPopover onClose={() => setDialsOpen(false)} />
      )}
    </div>
  );
}
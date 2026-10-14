/**
 * Battle series: run a list of queries (or sampled seed papers) one after
 * another under one run label, then read them as a single board.
 *
 * One battle is one sample. A series gives the pooled answer: agreement
 * per pipeline with an interval, decisive versus too-close counts, and,
 * when seed papers are used, real quality against their references.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import TournamentInterpretation from "./TournamentInterpretation";
import { interpretSeries } from "../utils/battleInterpretation.ts";
import {
  cleanSeriesQueries,
  comparePipelines,
  getSeriesLabels,
  getSeriesSummary,
  sampleSeriesSeeds,
  type SeriesLabel,
  type SeriesSeedPaper,
  type SeriesSummary,
} from "../api";

interface Item {
  key: string;
  text: string;
  seedId?: number;
}

type ItemState = "waiting" | "running" | "done" | "failed";

interface Props {
  topK: number;
  name: (id: string) => string;
  /** Called when a battle in the series has been recorded. */
  onBattle: () => void;
}

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

export default function BattleSeries({ topK, name, onBattle }: Props) {
  const [mode, setMode] = useState<"queries" | "seeds">("queries");
  const [text, setText] = useState("");
  const [count, setCount] = useState(10);
  const [sampled, setSampled] = useState<SeriesSeedPaper[]>([]);
  const [eligible, setEligible] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [states, setStates] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<SeriesSummary | null>(null);
  const [labels, setLabels] = useState<SeriesLabel[]>([]);
  const cancel = useRef(false);
  // Collapsed until wanted; a running or finished series keeps it open.
  const [open, setOpen] = useState(false);
  const generate = useCallback(
    (style: Parameters<typeof interpretSeries>[1]) =>
      summary ? interpretSeries(summary, style, name) : "",
    // `name` is stable for the page; the summary is what changes the text
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary],
  );

  useEffect(() => {
    getSeriesLabels().then(setLabels).catch(() => undefined);
  }, [running]);

  async function sample() {
    setError("");

    try {
      const result = await sampleSeriesSeeds(count, Math.floor(Math.random() * 1_000_000));

      setSampled(result.papers);
      setEligible(result.eligible);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sample papers.");
    }
  }

  async function loadSummary(forLabel: string) {
    try {
      setSummary(await getSeriesSummary(forLabel));
      setOpen(true);
    } catch {
      /* the board is best-effort */
    }
  }

  async function start() {
    setError("");
    setNotice("");
    let list: Item[] = [];

    if (mode === "queries") {
      const cleaned = await cleanSeriesQueries(text).catch(() => null);

      if (!cleaned || cleaned.queries.length === 0) {
        setError("Add at least one query, one per line.");
        return;
      }

      const notes = [
        cleaned.duplicates_dropped > 0 && `${cleaned.duplicates_dropped} repeated`,
        cleaned.over_limit > 0 && `${cleaned.over_limit} over the ${cleaned.limit} limit`,
        cleaned.truncated > 0 && `${cleaned.truncated} shortened`,
      ].filter(Boolean);

      if (notes.length) setNotice(`Cleaned the list: ${notes.join(", ")}.`);
      list = cleaned.queries.map((q) => ({ key: q, text: q }));
    } else {
      if (sampled.length === 0) {
        setError("Sample some seed papers first.");
        return;
      }

      list = sampled.map((p) => ({ key: String(p.id), text: p.title, seedId: p.id }));
    }

    const runLabel =
      label.trim() || `series-${mode === "seeds" ? "seeds" : slug(list[0].text) || "queries"}-${stamp()}`;

    setLabel(runLabel);
    setItems(list);
    setStates(list.map(() => "waiting"));
    setSummary(null);
    setOpen(true);
    setRunning(true);
    cancel.current = false;

    for (let i = 0; i < list.length; i++) {
      if (cancel.current) break;
      setStates((s) => s.map((v, j) => (j === i ? "running" : v)));

      try {
        await comparePipelines({
          query: list[i].seedId ? undefined : list[i].text,
          seedPaperId: list[i].seedId,
          topK,
          runLabel,
        });
        setStates((s) => s.map((v, j) => (j === i ? "done" : v)));
        onBattle();
      } catch {
        setStates((s) => s.map((v, j) => (j === i ? "failed" : v)));
      }
    }

    setRunning(false);
    await loadSummary(runLabel);
  }

  const finished = states.filter((s) => s === "done" || s === "failed").length;

  return (
    <section
      aria-label="Battle series"
      className="rounded border-[3px] border-gray-900 bg-surface"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block font-pixelify text-lg font-bold text-ink">Battle series</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted">
            Run many queries under one label and read them as one board.
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 rounded border-[2px] border-gray-900 bg-white px-2 py-0.5 font-mono text-[11px] font-bold text-ink"
        >
          {open ? "Hide" : "Open"}
        </span>
      </button>

      {open && (
      <div className="space-y-4 border-t-[3px] border-gray-900 px-4 py-4">
      <p className="text-xs leading-5 text-muted">
        Pasted queries give pooled agreement; sampled seed papers are also scored against their own references,
        which is real quality.
      </p>

      <div className="mt-2 flex gap-1.5" role="tablist" aria-label="Series source">
        {(["queries", "seeds"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            disabled={running}
            onClick={() => setMode(value)}
            className={`rounded border-[2px] border-gray-900 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em] ${
              mode === value ? "bg-accent text-onAccent" : "bg-surface text-ink hover:bg-accentSoft"
            }`}
          >
            {value === "queries" ? "Paste queries" : "Sample library papers"}
          </button>
        ))}
      </div>

      {mode === "queries" ? (
        <textarea
          aria-label="Queries, one per line"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={running}
          rows={5}
          placeholder={"One query per line, up to 50.\nneural network text similarity\ngraph-based recommendation"}
          className="ui-input mt-2 font-mono text-xs"
        />
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
              Papers
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                disabled={running}
                onChange={(event) => setCount(Math.min(50, Math.max(1, Number(event.target.value) || 1)))}
                className="ui-input !w-20 !py-1"
              />
            </label>
            <button type="button" className="ui-button ui-button-secondary" disabled={running} onClick={() => void sample()}>
              {sampled.length ? "Resample" : "Sample"}
            </button>
            {eligible !== null && (
              <span className="text-xs text-muted">{eligible} library papers have resolved references.</span>
            )}
          </div>
          {sampled.length > 0 && (
            <ol className="max-h-40 list-decimal space-y-0.5 overflow-y-auto pl-6 text-xs text-ink">
              {sampled.map((paper) => (
                <li key={paper.id}>
                  {paper.title}
                  <span className="text-muted">
                    {" "}
                    · {paper.year ?? "n.d."} · {paper.n_refs} refs
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
          Label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={running}
            maxLength={200}
            placeholder="auto"
            className="ui-input !py-1"
          />
        </label>
        {running ? (
          <button type="button" className="ui-button ui-button-danger" onClick={() => (cancel.current = true)}>
            Stop after this one
          </button>
        ) : (
          <button type="button" className="ui-button ui-button-primary" onClick={() => void start()}>
            Run series
          </button>
        )}
      </div>

      {notice && <p className="mt-2 text-xs text-muted">{notice}</p>}
      {error && <p className="status-error mt-2">{error}</p>}

      {items.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink" aria-live="polite">
            {running ? `Battle ${Math.min(finished + 1, items.length)} of ${items.length}` : `${finished} of ${items.length} finished`}
          </p>
          <div
            className="mt-1 h-2 overflow-hidden border-[2px] border-gray-900"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={finished}
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${(finished / items.length) * 100}%` }} />
          </div>
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {items.map((item, index) => (
              <li key={item.key} className="flex gap-2 text-ink">
                <span className="w-14 shrink-0 font-mono text-[10px] font-bold uppercase text-muted">{states[index]}</span>
                <span className="min-w-0 truncate">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {labels.length > 0 && !running && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em]">Earlier series</span>
          {labels.slice(0, 6).map((entry) => (
            <button
              key={entry.label}
              type="button"
              onClick={() => void loadSummary(entry.label)}
              className="rounded border-[2px] border-gray-300 px-1.5 py-0.5 text-ink hover:border-gray-900"
            >
              {entry.label} ({entry.battles})
            </button>
          ))}
        </div>
      )}

      {summary && summary.n_battles > 0 && (
        <div className="mt-3 border-t-2 border-dashed border-gray-300 pt-3">
          <h3 className="font-pixelify text-base font-bold text-ink">Series board · {summary.label}</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            {summary.n_battles} battles over {summary.n_queries} distinct queries: {summary.decisive} decisive,{" "}
            {summary.too_close} too close to call
            {summary.unscored > 0 ? `, ${summary.unscored} without a margin` : ""}. Agreement is mean consensus
            share with a 95% interval; it says who the pipelines agree with, not who is right.
          </p>
          <ol className="mt-2 space-y-1 font-mono text-xs text-ink">
            {summary.agreement.map((row, index) => (
              <li key={row.pipeline} className="flex items-baseline gap-2">
                <span className="w-4 text-right text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate font-bold">{name(row.pipeline)}</span>
                <span>{(row.mean * 100).toFixed(1)}%</span>
                <span className="text-muted">
                  [{(row.lo * 100).toFixed(1)}, {(row.hi * 100).toFixed(1)}]
                </span>
                <span className="w-16 text-right text-muted">{row.decisive_wins} won</span>
              </li>
            ))}
          </ol>

          {summary.judged.n_judged > 0 && (
            <div className="mt-3">
              <p className="text-xs font-bold text-ink">
                Quality against references · {summary.judged.n_judged} judged battles (mean nDCG)
              </p>
              <ol className="mt-1 space-y-1 font-mono text-xs text-ink">
                {summary.judged.pipelines.map((row, index) => (
                  <li key={row.pipeline} className="flex items-baseline gap-2">
                    <span className="w-4 text-right text-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-bold">{name(row.pipeline)}</span>
                    <span>{row.mean.toFixed(3)}</span>
                    <span className="text-muted">
                      [{row.lo.toFixed(2)}, {row.hi.toFixed(2)}]
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-xs leading-5 text-ink">
                {summary.judged.verdict
                  ? summary.judged.verdict.winner
                    ? `Verdict: ${name(summary.judged.verdict.winner)} is significantly better than every other pipeline.`
                    : "Verdict: no pipeline is significantly better than all the others on this series."
                  : `No verdict until ${summary.judged.min_for_verdict} battles are judged.`}
              </p>
            </div>
          )}

          <div className="mt-3">
            <TournamentInterpretation
              nameOf={name}
              generate={generate}
              resetKey={`${summary.label}:${summary.n_battles}:${summary.judged.n_judged}`}
              storageKey="paperrec_series_interpretation_style"
              filenameStem={`battle-series-${slug(summary.label) || "board"}`}
            />
          </div>
        </div>
      )}
      </div>
      )}
    </section>
  );
}

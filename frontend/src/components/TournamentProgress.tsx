import type { TournamentRunStatus } from "../api";
import { pipelineConfigs, pipelineName } from "../data/pipelineConfigs";
import PixelProgress from "./retro/PixelProgress";

/* ============================================================
   TOURNAMENT PROGRESS
   The live view of a tournament running on the server: the pixel
   meter, counters, the provisional standings as bars that move as
   queries finish, and the paper being scored right now.

   The run does not depend on this page. It is safe to close the tab or
   let the laptop sleep; the run carries on (or stops where it was) and
   is picked up again here, from the next unscored query.
   ============================================================ */

const configById = new Map(pipelineConfigs.map((c) => [c.id, c]));
const name = (id: string) => {
  const config = configById.get(id);
  return config ? pipelineName(config) : id;
};

const METRIC: Record<string, string> = {
  ndcg: "nDCG",
  mrr: "MRR",
  recall: "Recall@20",
  hit: "Hit",
};

function clock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function eta(seconds: number | null): string {
  if (seconds == null) return "…";
  if (seconds < 5) return "a moment";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border-[2px] border-onInk/30 bg-gray-950 px-2 py-1.5">
      <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-onInk/60">
        {label}
      </p>
      <p className="font-pixelify text-lg font-bold leading-tight text-onInk tabular-nums">
        {value}
      </p>
    </div>
  );
}

const SMALL_BTN =
  "rounded border-[2px] border-onInk/40 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onInk/80 transition-colors pixel-ease hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50";

export default function TournamentProgress({
  run,
  disconnected,
  busy,
  onStop,
  onResume,
  onDiscard,
}: {
  run: TournamentRunStatus;
  /** The last status poll failed (offline, or the laptop just woke). */
  disconnected: boolean;
  busy: boolean;
  onStop: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const running = run.status === "running";
  const failed = run.status === "error";
  const pct = run.total > 0 ? run.done / run.total : 0;
  const metric = METRIC[run.primary_metric] ?? run.primary_metric;

  const standings = Object.entries(run.partial_means).sort(
    (a, b) => b[1] - a[1],
  );
  const top = Math.max(0.0001, ...standings.map(([, value]) => value));

  const stage = failed
    ? "STOPPED WITH AN ERROR"
    : running
      ? `QUERY ${Math.min(run.total, run.done + 1)} OF ${run.total} · ${Math.round(
          pct * 100,
        )}% · ABOUT ${eta(run.eta_seconds).toUpperCase()} LEFT`
      : `PAUSED AT ${run.done} OF ${run.total} · NOTHING IS LOST`;

  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-onInk">
          {running
            ? `Scoring ${run.total} queries across ${run.pipelines.length} pipelines`
            : failed
              ? "Tournament stopped"
              : "Tournament paused"}
        </p>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              type="button"
              className={SMALL_BTN}
              onClick={onStop}
              disabled={busy}
            >
              Pause
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`${SMALL_BTN} !border-accent !text-accent`}
                onClick={onResume}
                disabled={busy}
              >
                Resume
              </button>
              <button
                type="button"
                className={SMALL_BTN}
                onClick={onDiscard}
                disabled={busy}
                title="Delete this unfinished run and its saved scores"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-2">
        <PixelProgress
          value={Math.max(0.02, pct)}
          stage={stage}
          done={false}
        />
      </div>

      {failed && run.error && (
        <p role="alert" className="mt-1 text-xs font-bold text-red-300">
          {run.error}
        </p>
      )}

      {disconnected && (
        <p
          role="status"
          className="mt-2 rounded border-[2px] border-accent/60 px-2 py-1 font-mono text-[11px] text-accent"
        >
          Connection lost, retrying. The tournament keeps running on the
          server.
        </p>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Queries done" value={`${run.done}/${run.total}`} />
        <Tile label="Dropped" value={run.dropped} />
        <Tile label="Scoring time" value={clock(run.busy_seconds)} />
        <Tile
          label="Per query"
          value={
            run.seconds_per_query != null
              ? `${run.seconds_per_query.toFixed(1)} s`
              : "…"
          }
        />
      </div>

      {standings.length > 0 && (
        <div className="mt-2 border-t-2 border-dashed border-onInk/25 pt-2">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-onInk/70">
            Live · mean {metric}@{run.top_k} so far (provisional)
          </p>
          <ol className="mt-1.5 space-y-1.5">
            {standings.map(([id, value], index) => (
              <li
                key={id}
                className="grid grid-cols-[1.25rem_minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-2 font-mono text-xs"
              >
                <span className="text-right text-onInk/70">{index + 1}</span>
                <span className="truncate font-bold text-onInk">
                  {name(id)}
                </span>
                <span className="h-2 overflow-hidden rounded-sm bg-onInk/15">
                  <span
                    className="block h-full bg-accent transition-[width] duration-700 ease-out"
                    style={{ width: `${(value / top) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums text-onInk">
                  {value.toFixed(3)}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 text-[11px] leading-4 text-onInk/60">
            These move as queries finish and settle as the sample grows. The
            verdict only comes from the statistical tests at the end.
          </p>
        </div>
      )}

      {running && run.current && (
        <p
          className="mt-2 truncate border-t-2 border-dashed border-onInk/25 pt-2 font-mono text-xs text-onInk/80"
          title={run.current.title}
        >
          <span className="mr-2 font-bold text-accent">NOW</span>
          {run.current.title}
        </p>
      )}

      <p className="mt-2 text-[11px] leading-4 text-onInk/60">
        {running
          ? "Safe to close this tab or let the laptop sleep: the run lives on the server and every finished query is saved."
          : "Resume continues from the next unscored query; queries already scored are not repeated."}
      </p>
    </div>
  );
}

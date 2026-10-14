import { GatherJob } from "../api";
import PixelProgress from "./retro/PixelProgress";

/* ============================================================
   GATHER PROGRESS
   The live view of "Gather literature", drawn for the cabinet's
   screen: three stages (fetch, add, index), the pixel meter, a row
   of counters and a feed of the papers being added right now.
   ============================================================ */

const STAGES = [
  { id: "references", label: "1 · Refs" },
  { id: "fetching", label: "2 · Fetch" },
  { id: "adding", label: "3 · Add" },
  { id: "indexing", label: "4 · Index" },
] as const;

function activeStage(job: GatherJob): number {
  if (job.state === "done") return STAGES.length;
  if (job.phase === "indexing") return 3;
  if (job.phase === "references" || job.phase === "linking") return 0;
  return (job.added ?? 0) > 0 ? 2 : 1;
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

function clock(seconds: number | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

export default function GatherProgress({ job }: { job: GatherJob }) {
  const stage = activeStage(job);
  const limit = job.limit ?? 300;
  const added = job.added ?? 0;
  const done = job.state === "done";
  const failed = job.state === "error";
  const indexing = job.phase === "indexing" && !done;

  const total = job.batches_total ?? 0;
  const byBatches = total > 0 ? (job.batches_done ?? 0) / total : 0;
  const fetchShare = Math.min(1, Math.max(added / limit, byBatches));

  const refTotal = job.ref_batches_total ?? 0;
  const refShare = refTotal > 0 ? (job.ref_batches_done ?? 0) / refTotal : 0;
  const referencing = job.phase === "references" || job.phase === "linking";

  // Reference lists fill the first 35% of the bar, fetching the next
  // 50%; the index rebuild has no measurable length, so it scans.
  const value = indexing
    ? null
    : done
      ? 1
      : referencing
        ? 0.02 + refShare * 0.33
        : 0.35 + fetchShare * 0.5;

  const stageLabel = failed
    ? "FAILED"
    : done
      ? null
      : indexing
        ? "REBUILDING THE RECOMMENDATION INDEX"
        : job.phase === "linking"
          ? "LINKING REFERENCES TO YOUR LIBRARY"
          : referencing
            ? refTotal > 0
              ? `REFERENCE LISTS · BATCH ${Math.min(refTotal, (job.ref_batches_done ?? 0) + 1)} OF ${refTotal} · ${job.papers_expanded ?? 0} PAPERS`
              : "LOOKING FOR PAPERS WITHOUT REFERENCES"
            : total > 0
              ? `BATCH ${Math.min(total, (job.batches_done ?? 0) + 1)} OF ${total} · ${added}/${limit} ADDED`
              : "PLANNING THE FETCH";

  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-[0.15em] text-onInk">
          Gathering literature
        </p>
        <ol className="flex flex-wrap gap-1.5">
          {STAGES.map((item, index) => {
            const state =
              index < stage ? "done" : index === stage ? "active" : "todo";
            return (
              <li
                key={item.id}
                className={`rounded border-[2px] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.15em] ${
                  state === "active"
                    ? "border-accent bg-accent text-onAccent"
                    : state === "done"
                      ? "border-accent/60 text-accent"
                      : "border-onInk/30 text-onInk/50"
                }`}
              >
                {state === "done" ? "✓ " : ""}
                {item.label}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-2">
        <PixelProgress
          value={failed ? 0.02 : value}
          done={done}
          stage={stageLabel}
        />
        {failed && (
          <p role="alert" className="mt-1 text-xs font-bold text-red-300">
            {job.error ?? "The gather failed."}
          </p>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Expanded" value={job.papers_expanded ?? 0} />
        <Tile label="Added" value={`${added}/${limit}`} />
        <Tile label="Refs linked" value={job.rows_linked ?? 0} />
        <Tile label="Already had" value={job.already_in_library ?? 0} />
        <Tile label="No abstract" value={job.skipped_no_abstract ?? 0} />
        <Tile label="Elapsed" value={clock(job.elapsed)} />
      </div>

      {(job.recent?.length ?? 0) > 0 && (
        <ul className="mt-2 space-y-1 border-t-2 border-dashed border-onInk/25 pt-2">
          {[...(job.recent ?? [])].reverse().map((title, index) => (
            <li
              key={`${title}-${index}`}
              className="truncate font-mono text-xs text-onInk"
              style={{ opacity: 1 - index * 0.18 }}
              title={title}
            >
              <span className="mr-2 font-bold text-accent">+</span>
              {title}
            </li>
          ))}
        </ul>
      )}

      {done && job.summary && !job.summary.index_rebuilt && added > 0 && (
        <p className="mt-2 text-xs font-bold text-red-300">
          The index was not rebuilt. Rebuild it before running a tournament.
        </p>
      )}
    </div>
  );
}

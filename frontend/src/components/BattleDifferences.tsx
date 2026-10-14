/**
 * "Why did they differ?" for one battle: the papers the pipelines split
 * on, the papers only one pipeline found, and which signal (TF-IDF,
 * S-BERT, metadata) is behind each list. All of it is read off the lists
 * the battle already returned.
 */

import type { BattleDifferences, DifferencePaper, SignalName } from "../api";

const SIGNAL_LABEL: Record<SignalName, string> = {
  tfidf: "TF-IDF",
  sbert: "S-BERT",
  metadata: "Metadata",
};

const SIGNAL_CLASS: Record<SignalName, string> = {
  tfidf: "bg-gray-900 text-onInk",
  sbert: "bg-accent text-onAccent",
  metadata: "border-[2px] border-gray-900 bg-surface text-ink",
};

function SignalChip({ signal }: { signal: SignalName }) {
  return (
    <span
      className={`rounded px-1 py-px font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${SIGNAL_CLASS[signal]}`}
    >
      {SIGNAL_LABEL[signal]}
    </span>
  );
}

function PaperLine({ paper, name }: { paper: DifferencePaper; name: (id: string) => string }) {
  return (
    <li className="rounded border-[2px] border-gray-300 bg-canvas px-2 py-1.5">
      <p className="text-sm font-bold leading-5 text-ink">
        {paper.title ?? `Paper ${paper.paper_id}`}
        {paper.year ? <span className="font-normal text-muted"> · {paper.year}</span> : null}
      </p>
      <p className="mt-0.5 text-xs leading-5 text-muted">
        {paper.out.length > 0 && (
          <>
            <strong className="text-ink">Found by:</strong>{" "}
            {paper.in.map((id) => `${name(id)} #${paper.ranks[id]}`).join(", ")}.{" "}
            <strong className="text-ink">Missed by:</strong> {paper.out.map(name).join(", ")}.
          </>
        )}
        {paper.out.length === 0 && <>All pipelines, mean rank #{paper.mean_rank}.</>}
      </p>
      {Object.keys(paper.drivers).length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          Driven by
          {paper.in.map(
            (id) =>
              paper.drivers[id] && (
                <span key={id} className="inline-flex items-center gap-1">
                  {name(id)} <SignalChip signal={paper.drivers[id]} />
                </span>
              ),
          )}
        </p>
      )}
    </li>
  );
}

export default function BattleDifferencesPanel({
  differences,
  name,
}: {
  differences: BattleDifferences | null | undefined;
  name: (id: string) => string;
}) {
  if (!differences) {
    return (
      <section className="rounded border-[3px] border-gray-900 bg-surface p-3 text-sm leading-6 text-muted">
        No difference breakdown for this battle. Battles recorded before this existed, and web battles, do not
        carry the per-signal data it needs.
      </section>
    );
  }

  const { contested, unanimous, pipelines } = differences;

  return (
    <div className="space-y-3">
      <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
        <h3 className="font-pixelify text-base font-bold text-ink">Where they agree and split</h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          {differences.union} different papers came back across {differences.n_pipelines} pipelines.{" "}
          {differences.shared_by_all} were returned by all of them; {differences.contested_count} were returned
          by some and missed by others.
        </p>
      </section>

      <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
        <h3 className="font-pixelify text-base font-bold text-ink">What each pipeline leans on</h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          Share of each list's score that came from each signal. A pipeline built from one signal shows 100% of
          it; the hybrids show their blend.
        </p>
        <ul className="mt-2 space-y-2">
          {pipelines.map((pipeline) => (
            <li key={pipeline.id} className="font-mono text-xs text-ink">
              <div className="flex items-baseline gap-2">
                <span className="w-40 shrink-0 truncate font-bold">{name(pipeline.id)}</span>
                {pipeline.signal_mix ? (
                  <div
                    className="flex h-3 min-w-0 flex-1 overflow-hidden border-[2px] border-gray-900"
                    role="img"
                    aria-label={(Object.keys(SIGNAL_LABEL) as SignalName[])
                      .map((s) => `${SIGNAL_LABEL[s]} ${Math.round(pipeline.signal_mix![s] * 100)}%`)
                      .join(", ")}
                  >
                    {(Object.keys(SIGNAL_LABEL) as SignalName[]).map((signal) => (
                      <div
                        key={signal}
                        className={signal === "tfidf" ? "bg-gray-900" : signal === "sbert" ? "bg-accent" : "bg-gray-400"}
                        style={{ width: `${pipeline.signal_mix![signal] * 100}%` }}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="text-muted">no signal data</span>
                )}
              </div>
              {pipeline.signal_mix && (
                <p className="ml-0 mt-0.5 text-[10px] text-muted sm:ml-[10.5rem]">
                  {(Object.keys(SIGNAL_LABEL) as SignalName[])
                    .filter((s) => pipeline.signal_mix![s] > 0)
                    .map((s) => `${SIGNAL_LABEL[s]} ${Math.round(pipeline.signal_mix![s] * 100)}%`)
                    .join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
        <h3 className="font-pixelify text-base font-bold text-ink">Most contested papers</h3>
        <p className="mt-1 text-xs leading-5 text-muted">The most evenly split first.</p>
        {contested.length === 0 ? (
          <p className="mt-2 text-sm text-ink">Every pipeline returned the same papers.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {contested.map((paper) => (
              <PaperLine key={paper.paper_id} paper={paper} name={name} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
        <h3 className="font-pixelify text-base font-bold text-ink">Found by only one pipeline</h3>
        {pipelines.every((p) => p.unique_count === 0) ? (
          <p className="mt-2 text-sm text-ink">No pipeline found anything the others did not.</p>
        ) : (
          <div className="mt-2 space-y-3">
            {pipelines
              .filter((p) => p.unique_count > 0)
              .map((pipeline) => (
                <div key={pipeline.id}>
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
                    {name(pipeline.id)} · {pipeline.unique_count}
                  </p>
                  <ul className="mt-1 space-y-1.5">
                    {pipeline.unique.map((paper) => (
                      <PaperLine key={paper.paper_id} paper={paper} name={name} />
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>

      {unanimous.length > 0 && (
        <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
          <h3 className="font-pixelify text-base font-bold text-ink">Agreed by every pipeline</h3>
          <ul className="mt-2 space-y-1.5">
            {unanimous.map((paper) => (
              <PaperLine key={paper.paper_id} paper={paper} name={name} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

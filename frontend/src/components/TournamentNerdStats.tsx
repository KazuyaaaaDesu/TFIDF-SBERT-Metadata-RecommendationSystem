import { useEffect, useState } from "react";

import { getTournament, getTournamentHistory, TournamentResult } from "../api";
import { pipelineConfigs, pipelineName } from "../data/pipelineConfigs";

/* ============================================================
   TOURNAMENT — STATS FOR NERDS
   The full inferential output of the latest recorded tournament:
   the omnibus test, mean ranks, every pairwise test with raw and
   Holm-adjusted p, CI on the difference, effect sizes, and the
   exact settings needed to reproduce the run.
   ============================================================ */

const byId = new Map(pipelineConfigs.map((c) => [c.id, c]));
const name = (id: string) => {
  const c = byId.get(id);
  return c ? pipelineName(c) : id;
};

const f = (v: number, d = 3) => v.toFixed(d);
const p = (v: number) => (v < 0.0001 ? "<0.0001" : v.toFixed(4));

export default function TournamentNerdStats() {
  const [run, setRun] = useState<TournamentResult | null>(null);
  const [state, setState] = useState<
    "loading" | "empty" | "error" | "ok"
  >("loading");
  const [unfinished, setUnfinished] = useState(false);

  useEffect(() => {
    let cancelled = false;

    /* The newest run can still be going (it has no verdict yet), so look
       back for the newest FINISHED one. A run is only shown if it really
       carries a verdict; anything else is treated as "nothing to show"
       instead of being drawn half-empty. */
    getTournamentHistory(1, 20)
      .then(async (history) => {
        if (cancelled) return;

        const finished = history.runs.find(
          (r) => !r.status || r.status === "done",
        );

        setUnfinished(history.runs.some((r) => r.status && r.status !== "done"));

        if (!finished) return setState("empty");

        const full = await getTournament(finished.id);
        if (cancelled) return;

        if (!full?.verdict || !Array.isArray(full.verdict.ranking)) {
          return setState("empty");
        }

        setRun(full);
        setState("ok");
      })
      .catch(() => !cancelled && setState("error"));

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-3 rounded border-[3px] border-gray-900 bg-surface p-3">
      <p className="font-mono text-xs font-bold tracking-[0.2em] text-ink">
        TOURNAMENT STATISTICS · LATEST RUN
      </p>

      {state === "loading" && <p className="text-xs text-muted">Loading…</p>}
      {state === "error" && (
        <p className="text-xs text-muted">Could not load tournaments.</p>
      )}
      {state === "empty" && (
        <p className="text-xs text-muted">
          {unfinished
            ? "A tournament is still running. Its statistics appear here when it finishes."
            : "No finished tournament yet. Run one from the Tournament tab and its full statistics will appear here."}
        </p>
      )}
      {state === "ok" && unfinished && (
        <p className="text-xs text-muted">
          A newer tournament is still running; this shows the latest finished
          one.
        </p>
      )}

      {run && state === "ok" && <Body run={run} />}

      <details className="text-xs leading-5 text-muted">
        <summary className="cursor-pointer font-mono font-bold text-ink">
          Method
        </summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            Per-query score x<sub>p</sub>[q] for pipeline p on query q; the
            design is paired (every pipeline sees the same queries).
          </li>
          <li>
            Mean ± 95% percentile bootstrap CI, resampling <em>queries</em>.
          </li>
          <li>
            Friedman: Q = 12·Σ(R<sub>j</sub> − n(k+1)/2)² / (nk(k+1) −
            Σ(t³−t)/(k−1)), compared with χ²<sub>k−1</sub>.
          </li>
          <li>
            Pairs: two-sided Wilcoxon signed-rank (exact up to 50 non-zero
            pairs), Holm-adjusted across all pairs.
          </li>
          <li>
            Cliff&apos;s δ = P(a&gt;b) − P(a&lt;b); d<sub>z</sub> = mean(diff) /
            sd(diff).
          </li>
          <li>
            Required n = ((z<sub>1−α/2</sub> + z<sub>power</sub>)·sd /
            effect)², with sd the observed spread of leader − runner-up.
          </li>
        </ul>
      </details>
    </section>
  );
}

function Body({ run }: { run: TournamentResult }) {
  const v = run.verdict;

  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
        <Item k="run" v={run.run_id != null ? `#${run.run_id}` : "unsaved"} />
        <Item k="outcome" v={v.outcome} />
        <Item k="winner" v={v.winner ? name(v.winner) : "none"} />
        <Item k="queries" v={`${run.n_queries} (${run.dropped.length} dropped)`} />
        <Item k="primary metric" v={`${run.primary_metric}@${run.top_k}`} />
        <Item k="min refs" v={String(run.min_refs)} />
        <Item k="seed" v={String(run.seed)} />
        <Item k="resamples" v={String(v.resamples ?? "—")} />
        <Item k="alpha" v={String(v.alpha ?? "—")} />
        <Item
          k="required n"
          v={
            v.required_n != null
              ? `${v.required_n} @ Δ${v.min_effect ?? 0.05}`
              : "—"
          }
        />
      </dl>

      {v.omnibus && (
        <p className="font-mono text-xs">
          Friedman χ²({v.omnibus.df}) = {f(v.omnibus.statistic, 3)}, p ={" "}
          {p(v.omnibus.p_value)}, n = {v.omnibus.n_queries}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left font-mono text-xs">
          <thead>
            <tr>
              <th>Pipeline</th>
              <th>Mean</th>
              <th>95% CI</th>
              <th>Mean rank</th>
            </tr>
          </thead>
          <tbody>
            {v.ranking.map((row) => (
              <tr key={row.pipeline}>
                <td className="py-0.5 font-bold">{name(row.pipeline)}</td>
                <td>{f(row.mean)}</td>
                <td>
                  [{f(row.lo)}, {f(row.hi)}]
                </td>
                <td>
                  {v.omnibus
                    ? f(v.omnibus.mean_ranks[row.pipeline] ?? 0, 2)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-[11px] text-muted">
        Pairwise test: {v.pairwise_test ?? "Wilcoxon signed-rank"}, Holm-adjusted.
        Effect: {v.binary ? "Cohen's h (0.1 very small, 0.2 small, 0.5 medium, 0.8 large); a/b = queries where only the first / only the second pipeline hit" : "paired Cliff's δ = P(first wins a query) − P(second wins) (0.15 small, 0.33 medium, 0.47 large)"}.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left font-mono text-xs">
          <thead>
            <tr>
              <th>Pair (a vs b)</th>
              <th>Δ mean</th>
              <th>95% CI of Δ</th>
              <th>p</th>
              <th>Holm p</th>
              <th>Effect</th>
              <th>d<sub>z</sub></th>
              <th>Sig.</th>
            </tr>
          </thead>
          <tbody>
            {v.pairwise.map((pair) => (
              <tr key={`${pair.a}|${pair.b}`}>
                <td className="py-0.5">
                  {name(pair.a)} vs {name(pair.b)}
                </td>
                <td>{f(pair.mean_diff)}</td>
                <td>
                  [{f(pair.lo)}, {f(pair.hi)}]
                </td>
                <td>{p(pair.p_value)}</td>
                <td>{p(pair.p_adjusted)}</td>
                <td>
                  {pair.effect_kind === "h"
                    ? `h ${f(pair.effect_size ?? pair.cohens_h ?? 0, 2)}`
                    : `δ${pair.paired_delta !== undefined ? "p" : ""} ${f(pair.effect_size ?? pair.paired_delta ?? pair.cliffs_delta, 2)}`}
                  {pair.effect_label ? ` (${pair.effect_label})` : ""}
                  {pair.test === "mcnemar" &&
                    ` · ${pair.a_only ?? 0}/${pair.b_only ?? 0}`}
                </td>
                <td>
                  {pair.cohens_dz == null ? "n/a" : f(pair.cohens_dz, 2)}
                </td>
                <td className="font-bold">{pair.significant ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-xs">
        Tie groups:{" "}
        {v.tie_groups.map((g) => `{${g.map(name).join(", ")}}`).join(" > ")}
      </p>
    </>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd className="font-bold">{v}</dd>
    </div>
  );
}

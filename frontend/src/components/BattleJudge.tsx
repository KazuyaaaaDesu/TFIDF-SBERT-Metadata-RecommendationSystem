/**
 * The Judge tab of an Arena battle: quality instead of agreement.
 *
 * A battle's consensus winner says which pipeline most others agree with,
 * not which one is right. Two ways to get a real signal from one battle:
 *
 *   - seed-paper battles are scored automatically against the seed's own
 *     references (and the papers citing it);
 *   - text battles are judged by the person: the union of every list is
 *     shown shuffled, with no pipeline names, and they tick what is
 *     relevant. Names are revealed only after the judgement is saved.
 *
 * One battle is one sample, so a leader here is a data point. The board at
 * the bottom pools judged battles and only states a verdict once there are
 * enough of them.
 */

import { useEffect, useMemo, useState } from "react";

import {
  getJudgedBattles,
  judgeBattle,
  type BattleJudgement,
  type CompareResponse,
  type JudgedBoard,
} from "../api";

interface Props {
  battle: CompareResponse;
  name: (id: string) => string;
  /** Called after a judgement is saved, so the page can refresh its tallies. */
  onJudged?: () => void;
}

/** Small deterministic PRNG so a battle always shuffles the same way. */
function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffledPapers(battle: CompareResponse) {
  const seen = new Map<number, { paper_id: number; title: string | null; year: number | null }>();

  for (const pipeline of battle.pipelines) {
    for (const paper of pipeline.results) {
      if (!seen.has(paper.paper_id)) {
        seen.set(paper.paper_id, { paper_id: paper.paper_id, title: paper.title, year: paper.year });
      }
    }
  }

  const papers = [...seen.values()].sort((a, b) => a.paper_id - b.paper_id);
  const random = mulberry32(battle.battle_id ?? 1);

  for (let i = papers.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));

    [papers[i], papers[j]] = [papers[j], papers[i]];
  }

  return papers;
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

function ScoreTable({ judgement, name }: { judgement: BattleJudgement; name: Props["name"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-left font-mono text-xs">
        <thead>
          <tr className="border-b-[3px] border-gray-900 text-[10px] uppercase tracking-[0.15em] text-muted">
            <th className="py-1.5 pr-2">Pipeline</th>
            <th className="px-2 text-right">nDCG@{judgement.k}</th>
            <th className="px-2 text-right">Relevant found</th>
            <th className="px-2 text-right">First hit (MRR)</th>
          </tr>
        </thead>
        <tbody>
          {judgement.ranking.map((id) => {
            const score = judgement.scores[id];
            const leads = judgement.leaders.includes(id);

            return (
              <tr key={id} className="border-b border-gray-300">
                <td className="py-1.5 pr-2 font-bold text-ink">
                  {name(id)}
                  {leads && judgement.separated && <span className="ml-1.5 text-accent">★</span>}
                </td>
                <td className="px-2 text-right text-ink">{score.ndcg.toFixed(3)}</td>
                <td className="px-2 text-right text-ink">
                  {score.hits} / {judgement.n_relevant}
                </td>
                <td className="px-2 text-right text-ink">{score.mrr.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Verdict({ judgement, name }: { judgement: BattleJudgement; name: Props["name"] }) {
  if (judgement.nothing_relevant_found) {
    return (
      <p className="text-sm leading-6 text-ink">
        <strong>Nothing relevant was found by any pipeline</strong>, so this battle says nothing about which is
        better and is left out of the board.
      </p>
    );
  }

  if (judgement.separated && judgement.leader) {
    return (
      <p className="text-sm leading-6 text-ink">
        <strong>{name(judgement.leader)}</strong> found the relevant papers best on this query (nDCG lead{" "}
        {judgement.margin.toFixed(2)}). That is one query: it counts as one data point on the board below.
      </p>
    );
  }

  return (
    <p className="text-sm leading-6 text-ink">
      <strong>No clear leader.</strong>{" "}
      {judgement.leaders.length > 1
        ? `${judgement.leaders.map(name).join(", ")} tie at the top.`
        : `${name(judgement.leaders[0] ?? "")} is ahead by only ${judgement.margin.toFixed(2)} nDCG.`}{" "}
      A gap under 0.1 on a single query is noise.
    </p>
  );
}

function Board({ board, name }: { board: JudgedBoard | null; name: Props["name"] }) {
  if (!board) return null;

  return (
    <section aria-label="Judged battles" className="rounded border-[3px] border-gray-900 bg-surface p-3">
      <h3 className="font-pixelify text-base font-bold text-ink">Judged battles so far</h3>
      {board.n_judged === 0 ? (
        <p className="mt-1 text-xs leading-5 text-muted">
          None yet. Judge a text battle, or run a seed-paper battle from Recommendations, to start the board.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs leading-5 text-muted">
            {board.n_judged} judged {board.n_judged === 1 ? "battle" : "battles"}
            {Object.entries(board.by_basis).length > 0 &&
              ` (${Object.entries(board.by_basis)
                .map(([basis, n]) => `${n} ${basis === "human" ? "by you" : "against references"}`)
                .join(", ")})`}
            . Mean nDCG with a 95% interval.
          </p>
          <ol className="mt-2 space-y-1 font-mono text-xs text-ink">
            {board.pipelines.map((row, index) => (
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
          <p className="mt-2 text-xs leading-5 text-ink">
            {board.verdict
              ? board.verdict.winner
                ? `Verdict: ${name(board.verdict.winner)} is significantly better than every other pipeline.`
                : "Verdict: no pipeline is significantly better than all the others on these battles."
              : `No verdict until ${board.min_for_verdict} battles are judged (${board.n_judged} so far). Fewer than that cannot separate pipelines.`}
          </p>
        </>
      )}
    </section>
  );
}

export default function BattleJudge({ battle, name, onJudged }: Props) {
  const [judgement, setJudgement] = useState<BattleJudgement | null>(battle.judgement ?? null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [board, setBoard] = useState<JudgedBoard | null>(null);
  const papers = useMemo(() => shuffledPapers(battle), [battle]);

  useEffect(() => {
    let live = true;

    if (battle.battle_id != null) {
      getJudgedBattles()
        .then((value) => live && setBoard(value))
        .catch(() => undefined);
    }

    return () => {
      live = false;
    };
  }, [judgement]);

  async function submit() {
    setBusy(true);
    setError("");

    try {
      // A recorded battle is judged from its stored lists; an unrecorded one
      // (the Lab's) from the lists on screen, and is not added to the board.
      setJudgement(
        await judgeBattle(
          battle.battle_id != null
            ? { battleId: battle.battle_id, relevant: [...ticked] }
            : {
                lists: Object.fromEntries(
                  battle.pipelines.map((p) => [p.id, p.results.map((r) => r.paper_id)]),
                ),
                topK: battle.top_k,
                relevant: [...ticked],
              },
        ),
      );
      onJudged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the judgement.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: number) {
    setTicked((current) => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }

  const byReferences = judgement?.basis === "references";
  const canJudge = !battle.seed_paper_id && battle.pipelines.length > 0;
  const recorded = battle.battle_id != null;

  return (
    <div className="space-y-3">
      <section className="rounded border-[3px] border-gray-900 bg-surface p-3">
        <h3 className="font-pixelify text-base font-bold text-ink">
          {judgement
            ? byReferences
              ? "Scored against the seed paper's own references"
              : "Scored by your relevance ticks"
            : "Which of these are relevant?"}
        </h3>

        {judgement ? (
          <div className="mt-2 space-y-3">
            <Verdict judgement={judgement} name={name} />
            <ScoreTable judgement={judgement} name={name} />
            {byReferences && (
              <p className="text-xs leading-5 text-muted">
                Relevant = papers the seed cites (and papers that cite it) that exist in the repository.{" "}
                {judgement.n_relevant} found. The seed itself is never counted.
              </p>
            )}
          </div>
        ) : canJudge ? (
          <>
            <p className="mt-1 text-xs leading-5 text-muted">
              Every paper any pipeline returned, shuffled, with no pipeline names. Tick the ones relevant to “
              {battle.query}”. The pipelines are revealed once you save.
            </p>
            <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
              {papers.map((paper) => (
                <li key={paper.paper_id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded border-[2px] border-gray-300 bg-canvas px-2 py-1.5 text-sm text-ink hover:border-gray-900">
                    <input
                      type="checkbox"
                      checked={ticked.has(paper.paper_id)}
                      onChange={() => toggle(paper.paper_id)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      {paper.title ?? `Paper ${paper.paper_id}`}
                      {paper.year ? <span className="text-muted"> · {paper.year}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="ui-button ui-button-primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : `Save judgement (${ticked.size} relevant)`}
              </button>
              {ticked.size === 0 && (
                <span className="text-xs text-muted">Saving with none ticked records “nothing relevant”.</span>
              )}
            </div>
            {error && <p className="status-error mt-2">{error}</p>}
          </>
        ) : (
          <p className="mt-1 text-xs leading-5 text-muted">
            {battle.seed_paper_id
              ? "This seed paper has no resolved references or citers in the repository, so there is nothing to score against."
              : "This battle was not recorded, so it cannot be judged. Run it with recording on."}
          </p>
        )}
      </section>

      {recorded ? (
        <Board board={board} name={name} />
      ) : (
        <p className="text-xs leading-5 text-muted">
          This battle was not recorded, so its judgement is shown here but not added to the judged board.
        </p>
      )}
    </div>
  );
}

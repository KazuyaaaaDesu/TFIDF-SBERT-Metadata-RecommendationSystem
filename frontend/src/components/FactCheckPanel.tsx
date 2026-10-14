import { useState } from "react";

import type { ClaimCheck, ClaimVerdict, FactCheckReport } from "../api";

/* ============================================================
   FACT-CHECK PANEL
   Under an answer: how many of its claims the cited sources actually
   back, then each claim with its verdict, the source sentence that
   supports (or fails to support) it, and why.

   Colour is never the only signal: every verdict has a label and a
   symbol, so the panel reads the same in greyscale or for colour-blind
   readers.
   ============================================================ */

const VERDICT: Record<
  ClaimVerdict,
  { label: string; mark: string; tone: string; help: string }
> = {
  supported: {
    label: "Supported",
    mark: "✓",
    tone: "bg-emerald-100 text-emerald-900 border-emerald-900",
    help: "The cited source says this.",
  },
  partial: {
    label: "Partly supported",
    mark: "≈",
    tone: "bg-amber-100 text-amber-900 border-amber-900",
    help: "Related, but a figure, a qualifier or part of the claim isn't backed.",
  },
  unsupported: {
    label: "Not supported",
    mark: "✕",
    tone: "bg-red-100 text-red-900 border-red-900",
    help: "The cited source doesn't say this.",
  },
  contradicted: {
    label: "Contradicted",
    mark: "⚠",
    tone: "bg-red-200 text-red-950 border-red-950",
    help: "The cited source says the opposite.",
  },
  uncited: {
    label: "No citation",
    mark: "?",
    tone: "bg-slate-100 text-slate-800 border-slate-700",
    help: "A factual claim with no source cited.",
  },
  invalid_citation: {
    label: "Bad citation",
    mark: "!",
    tone: "bg-red-100 text-red-900 border-red-900",
    help: "Cites a source number that doesn't exist.",
  },
  unverifiable: {
    label: "Can't verify",
    mark: "–",
    tone: "bg-slate-100 text-slate-800 border-slate-700",
    help: "The cited source has no abstract text to check against.",
  },
};

/** Order the summary chips from good to bad. */
const ORDER: ClaimVerdict[] = [
  "supported",
  "partial",
  "unsupported",
  "contradicted",
  "invalid_citation",
  "uncited",
  "unverifiable",
];

const METHOD: Record<FactCheckReport["method"], string> = {
  model: "Judged by the language model, then verified against the source text",
  semantic: "Checked by wording, figures and sentence similarity",
  lexical: "Checked by wording and figures",
};

function Badge({ verdict }: { verdict: ClaimVerdict }) {
  const v = VERDICT[verdict];
  return (
    <span
      title={v.help}
      className={`inline-flex shrink-0 items-center gap-1 rounded border-[2px] px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-[0.08em] ${v.tone}`}
    >
      <span aria-hidden="true">{v.mark}</span>
      {v.label}
    </span>
  );
}

function Claim({
  claim,
  onCite,
}: {
  claim: ClaimCheck;
  onCite?: (n: number) => void;
}) {
  const [open, setOpen] = useState(
    claim.verdict === "unsupported" ||
      claim.verdict === "contradicted" ||
      claim.verdict === "invalid_citation",
  );
  const hasDetail = claim.notes.length > 0 || claim.evidence != null;

  return (
    <li className="border-t border-gray-900/20 py-2 first:border-t-0">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Badge verdict={claim.verdict} />
        <p className="min-w-0 flex-1 basis-56 text-xs leading-5 text-ink [overflow-wrap:anywhere]">
          {claim.text}
          {claim.cites.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onCite?.(n)}
              title={`Go to source ${n}`}
              className="ml-1 inline-flex h-[1.4em] min-w-[1.4em] items-center justify-center rounded border-[2px] border-gray-900 bg-white px-1 font-mono text-[10px] font-bold text-ink hover:bg-accentSoft"
            >
              {n}
            </button>
          ))}
        </p>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted underline decoration-2 underline-offset-2 hover:text-ink"
          >
            {open ? "Hide" : "Why"}
          </button>
        )}
      </div>

      {open && hasDetail && (
        <div className="mt-1.5 space-y-1.5 pl-1 text-[11px] leading-4 text-muted">
          {claim.notes.map((note, i) => (
            <p key={i} className="[overflow-wrap:anywhere]">
              {note}
            </p>
          ))}
          {claim.evidence && (
            <blockquote className="border-l-[3px] border-gray-900 bg-canvas px-2 py-1 italic text-ink [overflow-wrap:anywhere]">
              “{claim.evidence.quote}”
              <span className="ml-1 not-italic text-muted">
                — source {claim.evidence.source}
              </span>
            </blockquote>
          )}
        </div>
      )}
    </li>
  );
}

export default function FactCheckPanel({
  report,
  onCite,
}: {
  report: FactCheckReport;
  onCite?: (n: number) => void;
}) {
  const { summary } = report;
  const rate = summary.support_rate;
  const issues =
    summary.unsupported + summary.contradicted + summary.invalid_citation;
  const [open, setOpen] = useState(issues > 0);

  const headline =
    rate == null
      ? "Nothing could be verified against the sources"
      : `${Math.round(rate * 100)}% of checkable claims are backed by their sources`;

  return (
    <section
      aria-label="Fact check"
      className="max-w-[min(720px,100%)] rounded border-[3px] border-gray-900 bg-white"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
          Fact check
        </span>
        <span className="min-w-0 flex-1 basis-48 text-xs font-bold text-ink">
          {headline}
        </span>
        <span className="flex flex-wrap gap-1">
          {ORDER.filter((k) => summary[k] > 0).map((k) => (
            <span
              key={k}
              title={VERDICT[k].help}
              className={`inline-flex items-center gap-1 rounded border-[2px] px-1.5 py-px font-mono text-[10px] font-bold ${VERDICT[k].tone}`}
            >
              <span aria-hidden="true">{VERDICT[k].mark}</span>
              {summary[k]}
              <span className="sr-only"> {VERDICT[k].label}</span>
            </span>
          ))}
        </span>
        <span aria-hidden="true" className="font-mono text-xs text-muted">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {rate != null && (
        <div
          className="mx-3 mb-2 h-1.5 overflow-hidden rounded-sm bg-gray-900/15"
          role="img"
          aria-label={`${Math.round(rate * 100)} percent supported`}
        >
          <div
            className="h-full bg-emerald-600 transition-[width] duration-500"
            style={{ width: `${Math.round(rate * 100)}%` }}
          />
        </div>
      )}

      {open && (
        <div className="border-t-[3px] border-gray-900 px-3 pb-2">
          <ul>
            {report.claims.map((claim) => (
              <Claim key={claim.id} claim={claim} onCite={onCite} />
            ))}
          </ul>
          <p className="border-t border-gray-900/20 pt-1.5 text-[10px] leading-4 text-muted">
            {METHOD[report.method]}. An automated check against the retrieved
            abstracts: it can miss subtle errors and can't see beyond what a
            source's abstract says, so treat it as a second opinion, not proof.
          </p>
        </div>
      )}
    </section>
  );
}

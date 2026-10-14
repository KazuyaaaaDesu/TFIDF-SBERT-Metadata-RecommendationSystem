import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

import {
  parseChatMarkdown,
  type Align,
  type Block,
  type Inline,
} from "../utils/chatMarkdown.ts";

/* ============================================================
   CHAT MARKDOWN
   Renders a research-chat answer: GitHub-style tables, nested and
   numbered lists, task lists, fenced code (with copy), block quotes,
   KaTeX math (inline and display), links, source markers as clickable
   chips, and the appended reference list.

   The parser (utils/chatMarkdown.ts) produces a plain data tree and
   has no HTML node, so nothing in a model's reply can inject markup.
   The only raw HTML here is KaTeX's own output for a formula, rendered
   with `trust: false`.

   Layout rules this component owns, because chat answers broke them:
   long words and URLs wrap instead of widening the bubble; tables and
   formulas scroll sideways inside it; code never wraps mid-token.
   ============================================================ */

const MATH_CACHE = new Map<string, string>();

function typeset(source: string, display: boolean): string {
  const key = `${display ? "D" : "I"}:${source}`;
  const hit = MATH_CACHE.get(key);
  if (hit !== undefined) return hit;

  let html: string;
  try {
    html = katex.renderToString(source, {
      displayMode: display,
      // A model's LaTeX is often slightly off: show what rendered, with
      // the broken part in red, rather than the raw source or an error.
      throwOnError: false,
      errorColor: "#c0392b",
      strict: "ignore",
      trust: false,
      maxExpand: 1000,
      maxSize: 40,
    });
  } catch {
    html = "";
  }

  if (MATH_CACHE.size > 500) MATH_CACHE.clear();
  MATH_CACHE.set(key, html);
  return html;
}

function Tex({ source, display }: { source: string; display: boolean }) {
  const html = typeset(source, display);

  if (!html) {
    return <code className="font-mono text-[0.9em]">{source}</code>;
  }

  return display ? (
    <div
      className="my-1 max-w-full overflow-x-auto overflow-y-hidden py-1 text-center"
      // KaTeX output for a formula, produced with trust: false
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span
      className="inline-block max-w-full align-middle"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const WRAP = "[overflow-wrap:anywhere]";

function Inlines({
  nodes,
  onCite,
}: {
  nodes: Inline[];
  onCite?: (n: number) => void;
}) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.t) {
          case "text":
            return <Fragment key={i}>{node.v}</Fragment>;
          case "br":
            return <br key={i} />;
          case "code":
            return (
              <code
                key={i}
                className="rounded border border-gray-900/40 bg-canvas px-1 py-px font-mono text-[0.88em] [overflow-wrap:anywhere]"
              >
                {node.v}
              </code>
            );
          case "math":
            return <Tex key={i} source={node.v} display={false} />;
          case "strong":
            return (
              <strong key={i} className="font-bold">
                <Inlines nodes={node.c} onCite={onCite} />
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                <Inlines nodes={node.c} onCite={onCite} />
              </em>
            );
          case "del":
            return (
              <del key={i} className="opacity-70">
                <Inlines nodes={node.c} onCite={onCite} />
              </del>
            );
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={`font-semibold underline decoration-2 underline-offset-2 hover:bg-accentSoft ${WRAP}`}
              >
                <Inlines nodes={node.c} onCite={onCite} />
              </a>
            );
          case "cite":
            return (
              <span key={i} className="whitespace-nowrap">
                {node.nums.map((n, k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onCite?.(n)}
                    disabled={!onCite}
                    title={`Go to source ${n}`}
                    aria-label={`Source ${n}`}
                    className="mx-px inline-flex h-[1.35em] min-w-[1.35em] -translate-y-[0.15em] items-center justify-center rounded border-[2px] border-gray-900 bg-white px-1 align-baseline font-mono text-[0.7em] font-bold leading-none text-ink transition-colors hover:bg-accentSoft disabled:cursor-default disabled:hover:bg-white"
                  >
                    {n}
                  </button>
                ))}
              </span>
            );
        }
      })}
    </>
  );
}

const ALIGN: Record<NonNullable<Align>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function CodeBlock({ lang, source }: { lang: string; source: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context): leave the text selectable */
    }
  }

  return (
    <div className="overflow-hidden rounded border-[3px] border-gray-900">
      <div className="flex items-center justify-between gap-2 border-b-[2px] border-gray-900 bg-canvas px-2 py-1">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border-[2px] border-gray-900 bg-white px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink hover:bg-accentSoft"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto bg-white p-3 font-mono text-xs leading-5 text-ink">
        <code>{source}</code>
      </pre>
    </div>
  );
}

function Blocks({
  blocks,
  onCite,
  tight = false,
}: {
  blocks: Block[];
  onCite?: (n: number) => void;
  /** Inside a list item: the first paragraph carries no top margin. */
  tight?: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        const gap = i === 0 && tight ? "" : "mt-2";

        switch (block.t) {
          case "p":
            return (
              <p key={i} className={`${gap} ${WRAP}`}>
                <Inlines nodes={block.c} onCite={onCite} />
              </p>
            );

          case "h": {
            const size =
              block.level <= 1
                ? "text-base"
                : block.level === 2
                  ? "text-[15px]"
                  : "text-sm";
            return (
              <p
                key={i}
                role="heading"
                aria-level={block.level}
                className={`${i === 0 ? "" : "mt-3"} ${size} font-bold ${WRAP}`}
              >
                <Inlines nodes={block.c} onCite={onCite} />
              </p>
            );
          }

          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List
                key={i}
                start={block.ordered ? block.start : undefined}
                className={`${gap} space-y-1 pl-5 ${
                  block.ordered ? "list-decimal" : "list-disc"
                } marker:text-muted`}
              >
                {block.items.map((item, k) => (
                  <li
                    key={k}
                    className={`${WRAP} ${
                      item.checked !== null ? "list-none -ml-5 flex gap-2" : ""
                    }`}
                  >
                    {item.checked !== null && (
                      <input
                        type="checkbox"
                        checked={item.checked}
                        readOnly
                        disabled
                        aria-label={item.checked ? "Done" : "Not done"}
                        className="mt-1.5 h-3.5 w-3.5 shrink-0 accent-gray-900"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <Blocks blocks={item.c} onCite={onCite} tight />
                    </div>
                  </li>
                ))}
              </List>
            );
          }

          case "quote":
            return (
              <blockquote
                key={i}
                className={`${gap} border-l-[4px] border-accent pl-3 text-muted`}
              >
                <Blocks blocks={block.c} onCite={onCite} tight />
              </blockquote>
            );

          case "code":
            return (
              <div key={i} className={gap}>
                <CodeBlock lang={block.lang} source={block.v} />
              </div>
            );

          case "math":
            return (
              <div key={i} className={gap}>
                <Tex source={block.v} display />
              </div>
            );

          case "hr":
            return (
              <hr
                key={i}
                className="my-3 border-0 border-t-[3px] border-dashed border-gray-900/30"
              />
            );

          case "table":
            return (
              <div
                key={i}
                className={`${gap} max-w-full overflow-x-auto rounded border-[3px] border-gray-900`}
              >
                <table className="w-max min-w-full border-collapse text-xs leading-5">
                  <thead>
                    <tr className="bg-canvas">
                      {block.head.map((cell, c) => (
                        <th
                          key={c}
                          scope="col"
                          className={`border-b-[3px] border-gray-900 px-2.5 py-1.5 font-bold ${
                            block.align[c] ? ALIGN[block.align[c]!] : "text-left"
                          }`}
                        >
                          <Inlines nodes={cell} onCite={onCite} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr
                        key={r}
                        className={r % 2 === 1 ? "bg-canvas/60" : undefined}
                      >
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className={`border-t border-gray-900/25 px-2.5 py-1.5 align-top ${
                              block.align[c] ? ALIGN[block.align[c]!] : "text-left"
                            } ${c > 0 && block.align[c] === "right" ? "tabular-nums" : ""}`}
                          >
                            <Inlines nodes={cell} onCite={onCite} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case "refs":
            return (
              <div
                key={i}
                className="mt-3 border-t-[3px] border-dashed border-gray-900/30 pt-2"
              >
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted">
                  {block.title}
                </p>
                <ol className="mt-1.5 space-y-1.5 text-xs leading-5 text-muted">
                  {block.items.map((entry, k) => (
                    <li
                      key={k}
                      className={`pl-4 -indent-4 ${WRAP}`}
                    >
                      <Inlines nodes={entry} onCite={onCite} />
                    </li>
                  ))}
                </ol>
              </div>
            );
        }
      })}
    </>
  );
}

function ChatMarkdown({
  content,
  onCite,
}: {
  content: string;
  /** Click on a [n] marker: the caller scrolls to source n. */
  onCite?: (n: number) => void;
}): ReactNode {
  const blocks = useMemo(() => parseChatMarkdown(content), [content]);

  return (
    <div className="min-w-0 max-w-full [&_.katex]:text-[1.04em]">
      <Blocks blocks={blocks} onCite={onCite} tight />
    </div>
  );
}

export default memo(ChatMarkdown);

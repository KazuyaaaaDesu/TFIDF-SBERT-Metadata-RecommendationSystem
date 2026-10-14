/**
 * CHAT MARKDOWN — a small, safe Markdown parser for the research chat.
 *
 * The chat's answers come from a language model and are Markdown with
 * LaTeX: GitHub-style tables, nested and numbered lists, task lists,
 * fenced code, block quotes, `$...$` / `$$...$$` math, links, and the
 * `[1]` source markers the chat adds. This turns that text into a plain
 * data tree (no HTML, nothing executable) that ChatMarkdown.tsx renders,
 * so every rule here is unit-testable without a browser.
 *
 * It is deliberately forgiving: model output is rarely perfect Markdown
 * (a table with no outer pipes, a list indented by three spaces, an
 * unclosed code fence, a stray `$` in "$5 and $10"), and anything that
 * does not parse cleanly falls back to plain text rather than breaking
 * the message.
 */

// ---------------------------------------------------------------
// Tree
// ---------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "math"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "cite"; nums: number[]; raw: string }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** null: a normal item; true/false: a task item ([x] / [ ]). */
  checked: boolean | null;
  c: Block[];
}

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; c: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "math"; v: string }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "refs"; title: string; items: Inline[][] };

// ---------------------------------------------------------------
// Inline
// ---------------------------------------------------------------

const PUNCT = /[!-/:-@[-`{-~]/;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const REFERENCE_TITLES = new Set([
  "references",
  "works cited",
  "bibliography",
  "reference list",
]);

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Index of the matching `close` for an opener at `from`, or -1. */
function findClose(
  text: string,
  from: number,
  close: string,
  ok: (at: number) => boolean,
): number {
  let at = from;

  while (true) {
    at = text.indexOf(close, at);
    if (at === -1) return -1;

    // A backslash-escaped delimiter does not close.
    if (text[at - 1] !== "\\" && ok(at)) return at;

    at += close.length;
  }
}

/** Closing `$` of an inline formula, honouring the "$5 and $10" rule. */
function findMathClose(text: string, from: number): number {
  let at = from;

  while (true) {
    at = text.indexOf("$", at);
    if (at === -1) return -1;

    const content = text.slice(from, at);

    if (
      text[at - 1] !== "\\" &&
      content.length > 0 &&
      !content.includes("\n") &&
      !isSpace(content[0]) &&
      !isSpace(content[content.length - 1]) &&
      // "$5 and $10": a closing $ is never followed by a digit
      !/\d/.test(text[at + 1] ?? "")
    ) {
      return at;
    }

    if (content.includes("\n")) return -1;
    at += 1;
  }
}

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

function parseCite(raw: string): number[] | null {
  const inner = raw.slice(1, -1);
  if (!/^\d+(\s*[,–-]\s*\d+)*$/.test(inner)) return null;

  const nums: number[] = [];
  for (const piece of inner.split(/\s*,\s*/)) {
    const range = piece.split(/\s*[–-]\s*/);
    if (range.length === 2) {
      const [a, b] = range.map(Number);
      if (b >= a && b - a < 50) for (let n = a; n <= b; n++) nums.push(n);
      else nums.push(a, b);
    } else nums.push(Number(range[0]));
  }

  return nums;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    pushText(out, buf);
    buf = "";
  };

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    // line break
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i += 1;
      continue;
    }

    // \( ... \) and \[ ... \] inline math (before generic escapes)
    if (rest.startsWith("\\(")) {
      const end = text.indexOf("\\)", i + 2);
      if (end !== -1) {
        flush();
        out.push({ t: "math", v: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("\\[")) {
      const end = text.indexOf("\\]", i + 2);
      if (end !== -1) {
        flush();
        out.push({ t: "math", v: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // backslash escape
    if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // code span
    if (ch === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end !== -1 && end > i + ticks.length) {
        flush();
        out.push({
          t: "code",
          v: text.slice(i + ticks.length, end).replace(/^ (.*) $/s, "$1"),
        });
        i = end + ticks.length;
        continue;
      }
      buf += ticks;
      i += ticks.length;
      continue;
    }

    // $$ ... $$ and $ ... $ math
    if (ch === "$") {
      if (rest.startsWith("$$")) {
        const end = text.indexOf("$$", i + 2);
        if (end !== -1 && end > i + 2) {
          flush();
          out.push({ t: "math", v: text.slice(i + 2, end).trim() });
          i = end + 2;
          continue;
        }
      }
      const end = findMathClose(text, i + 1);
      if (end !== -1) {
        flush();
        out.push({ t: "math", v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    // bare URL (before emphasis, so underscores in it survive)
    if (ch === "h" && /^https?:\/\//i.test(rest) && !isWord(text[i - 1])) {
      const match = /^https?:\/\/[^\s<>"'`]+/i.exec(rest)!;
      let url = match[0];
      // trailing punctuation belongs to the sentence, not the link
      while (/[.,;:!?)\]]$/.test(url)) {
        if (url.endsWith(")") && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break;
        url = url.slice(0, -1);
      }
      flush();
      out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
      i += url.length;
      continue;
    }

    // [text](url) link, or a [1] / [2, 3] source marker
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);

      if (close !== -1) {
        const label = text.slice(i + 1, close);

        if (text[close + 1] === "(") {
          const paren = text.indexOf(")", close + 2);
          if (paren !== -1) {
            const href = text.slice(close + 2, paren).trim().split(/\s+/)[0];
            if (SAFE_URL.test(href)) {
              flush();
              out.push({ t: "link", href, c: parseInline(label) });
              i = paren + 1;
              continue;
            }
          }
        }

        const nums = parseCite(text.slice(i, close + 1));
        if (nums) {
          flush();
          out.push({ t: "cite", nums, raw: text.slice(i, close + 1) });
          i = close + 1;
          continue;
        }
      }
    }

    // strikethrough
    if (rest.startsWith("~~")) {
      const end = findClose(text, i + 2, "~~", (at) => at > i + 2 && !isSpace(text[at - 1]));
      if (end !== -1 && !isSpace(text[i + 2])) {
        flush();
        out.push({ t: "del", c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // emphasis: ***x***, **x**, __x__, *x*, _x_
    if (ch === "*" || ch === "_") {
      const run = /^[*_]+/.exec(rest)![0];
      const mark = run[0];
      const size = Math.min(run.length, 3);
      const delim = mark.repeat(size);
      const open = i + size;
      // flanking: the opener must touch text, and `_` must not be mid-word
      const canOpen =
        !isSpace(text[open]) && (mark === "*" || !isWord(text[i - 1]));

      if (canOpen) {
        const end = findClose(text, open, delim, (at) => {
          if (at <= open || isSpace(text[at - 1])) return false;
          return mark === "*" || !isWord(text[at + size]);
        });

        if (end !== -1) {
          const inner = parseInline(text.slice(open, end));
          flush();
          out.push(
            size === 3
              ? { t: "strong", c: [{ t: "em", c: inner }] }
              : size === 2
                ? { t: "strong", c: inner }
                : { t: "em", c: inner },
          );
          i = end + size;
          continue;
        }
      }

      buf += run;
      i += run.length;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

// ---------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const ENV_OPEN = /^\s*\\begin\{([a-zA-Z*]+)\}/;

/** Split a table row on unescaped pipes, trimming the outer ones. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let inCode = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    // A pipe inside a $...$ formula (|x|, \|v\|) is math, not a column.
    if (ch === "$" && !inCode && text[i - 1] !== "\\") {
      const end = findMathClose(text, i + 1);
      if (end !== -1) {
        cell += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }

  cells.push(cell.trim());
  return cells;
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^\s*\\\[/.test(line) ||
    ENV_OPEN.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("|"))
  );
}

function countIndent(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function dedent(line: string, by: number): string {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < by) {
    if (line[i] === " ") removed += 1;
    else if (line[i] === "\t") removed += 4;
    else break;
    i += 1;
  }
  return line.slice(i);
}

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // fenced code (an unclosed fence runs to the end: safe for cut-off text)
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const size = fence[1].length;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closing = new RegExp(`^\\s{0,3}\\${marker}{${size},}\\s*$`);
        if (closing.test(lines[i])) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }

    // display math: $$ ... $$ (one or many lines), \[ ... \], \begin{env}
    const trimmed = line.trim();
    if (trimmed.startsWith("$$")) {
      const after = trimmed.slice(2);
      const sameLine = after.indexOf("$$");
      if (sameLine !== -1) {
        blocks.push({ t: "math", v: after.slice(0, sameLine).trim() });
        i += 1;
        continue;
      }
      const body: string[] = after.trim() ? [after] : [];
      i += 1;
      while (i < lines.length && !lines[i].includes("$$")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        body.push(lines[i].slice(0, lines[i].indexOf("$$")));
        i += 1;
      }
      blocks.push({ t: "math", v: body.join("\n").trim() });
      continue;
    }
    if (trimmed.startsWith("\\[")) {
      const after = trimmed.slice(2);
      const sameLine = after.indexOf("\\]");
      if (sameLine !== -1) {
        blocks.push({ t: "math", v: after.slice(0, sameLine).trim() });
        i += 1;
        continue;
      }
      const body: string[] = after.trim() ? [after] : [];
      i += 1;
      while (i < lines.length && !lines[i].includes("\\]")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        body.push(lines[i].slice(0, lines[i].indexOf("\\]")));
        i += 1;
      }
      blocks.push({ t: "math", v: body.join("\n").trim() });
      continue;
    }
    const env = ENV_OPEN.exec(line);
    if (env) {
      const end = `\\end{${env[1]}}`;
      const body: string[] = [line];
      let closed = line.includes(end);
      i += 1;
      while (!closed && i < lines.length) {
        body.push(lines[i]);
        closed = lines[i].includes(end);
        i += 1;
      }
      blocks.push({ t: "math", v: body.join("\n").trim() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        t: "h",
        level: heading[1].length,
        c: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    // A thematic break wins over a list item ("- - -" is a rule).
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    // table: a header row, then a separator row
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("|") &&
      TABLE_SEPARATOR.test(lines[i + 1])
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(parseAlign);

      if (head.length === align.length || head.length > 0) {
        const width = head.length;
        const rows: Inline[][][] = [];
        i += 2;

        while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
          const cells = splitRow(lines[i]);
          // Ragged rows are padded or trimmed to the header width.
          const fixed = Array.from({ length: width }, (_, n) => cells[n] ?? "");
          rows.push(fixed.map(parseInline));
          i += 1;
        }

        blocks.push({
          t: "table",
          align: Array.from({ length: width }, (_, n) => align[n] ?? null),
          head: head.map(parseInline),
          rows,
        });
        continue;
      }
    }

    // block quote
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }

    // list (nested by indentation)
    const marker = LIST_ITEM.exec(line);
    if (marker) {
      const baseIndent = countIndent(marker[1]);
      const ordered = /\d/.test(marker[2]);
      const start = ordered ? parseInt(marker[2], 10) : 1;
      const items: ListItem[] = [];

      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || countIndent(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;

        const contentIndent = baseIndent + m[2].length + m[3].length;
        const body: string[] = [m[4]];
        i += 1;

        while (i < lines.length) {
          const next = lines[i];

          if (next.trim() === "") {
            // a blank line continues the item only if what follows is indented
            let peek = i + 1;
            while (peek < lines.length && lines[peek].trim() === "") peek += 1;
            if (peek < lines.length && countIndent(lines[peek]) > baseIndent) {
              body.push("");
              i += 1;
              continue;
            }
            break;
          }

          const sibling = LIST_ITEM.exec(next);
          if (countIndent(next) > baseIndent) {
            body.push(dedent(next, Math.min(contentIndent, countIndent(next))));
            i += 1;
            continue;
          }
          if (sibling) break;
          if (startsBlock(next, lines[i + 1])) break;
          // lazy continuation of the item's paragraph
          body.push(next.trim());
          i += 1;
        }

        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+(.*)$/s.exec(body[0]);
        if (task) {
          checked = task[1].toLowerCase() === "x";
          body[0] = task[2];
        }

        items.push({ checked, c: parseBlocks(body) });
      }

      blocks.push({ t: "list", ordered, start, items });
      continue;
    }

    // paragraph (soft line breaks stay breaks: chat style)
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !startsBlock(lines[i], lines[i + 1])
    ) {
      para.push(lines[i]);
      i += 1;
    }

    // The chat appends "References" + one entry per line: a list, not prose.
    if (para.length > 1 && REFERENCE_TITLES.has(para[0].trim().toLowerCase())) {
      blocks.push({
        t: "refs",
        title: para[0].trim(),
        items: para.slice(1).map((entry) => parseInline(entry.trim())),
      });
      continue;
    }

    blocks.push({
      t: "p",
      c: parseInline(para.map((l) => l.trim()).join("\n")),
    });
  }

  return blocks;
}

/** Parse a whole chat answer. `【1】` markers are treated as `[1]`. */
export function parseChatMarkdown(source: string): Block[] {
  const text = source
    .replace(/\r\n?/g, "\n")
    .replace(/【(\d+)】/g, "[$1]")
    // a model sometimes wraps its whole answer in a fence labelled markdown
    .replace(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i, "$1");

  return parseBlocks(text.split("\n"));
}

/** Plain-text rendering of a tree, for "copy answer". */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
        case "code":
          return n.v;
        case "math":
          return `$${n.v}$`;
        case "br":
          return "\n";
        case "cite":
          return n.raw;
        case "link":
        case "strong":
        case "em":
        case "del":
          return inlineText(n.c);
      }
    })
    .join("");
}

// ---------------------------------------------------------------
// Export: HTML (for Word / Docs) and plain text (for anything)
// ---------------------------------------------------------------

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(n.v);
        case "code":
          return `<code>${escapeHtml(n.v)}</code>`;
        case "math":
          return `<i>${escapeHtml(n.v)}</i>`;
        case "br":
          return "<br>";
        case "cite":
          return `<sup>${escapeHtml(n.raw)}</sup>`;
        case "strong":
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.c)}</em>`;
        case "del":
          return `<del>${inlineHtml(n.c)}</del>`;
        case "link":
          return `<a href="${escapeHtml(n.href)}">${inlineHtml(n.c)}</a>`;
      }
    })
    .join("");
}

/**
 * Standards-clean HTML for the clipboard: tables stay tables when pasted
 * into Word, Google Docs or Outlook. Every text node is escaped; there is
 * no way for the source to inject markup.
 */
export function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b): string => {
      switch (b.t) {
        case "p":
          return `<p>${inlineHtml(b.c)}</p>`;
        case "h": {
          const level = Math.min(6, Math.max(1, b.level));
          return `<h${level}>${inlineHtml(b.c)}</h${level}>`;
        }
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
          const items = b.items
            .map(
              (item) =>
                `<li>${
                  item.checked === null ? "" : item.checked ? "&#9745; " : "&#9744; "
                }${blocksToHtml(item.c).replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`,
            )
            .join("");
          return `<${tag}${start}>${items}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${blocksToHtml(b.c)}</blockquote>`;
        case "code":
          return `<pre><code>${escapeHtml(b.v)}</code></pre>`;
        case "math":
          return `<p><i>${escapeHtml(b.v)}</i></p>`;
        case "hr":
          return "<hr>";
        case "table": {
          const style = (a: Align) => (a ? ` style="text-align:${a}"` : "");
          const head = b.head
            .map((c, i) => `<th${style(b.align[i])}>${inlineHtml(c)}</th>`)
            .join("");
          const rows = b.rows
            .map(
              (row) =>
                `<tr>${row
                  .map((c, i) => `<td${style(b.align[i])}>${inlineHtml(c)}</td>`)
                  .join("")}</tr>`,
            )
            .join("");
          return `<table border="1" cellpadding="4" cellspacing="0"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
        }
        case "refs":
          return `<p><strong>${escapeHtml(b.title)}</strong></p><ol>${b.items
            .map((entry) => `<li>${inlineHtml(entry)}</li>`)
            .join("")}</ol>`;
      }
    })
    .join("\n");
}

/**
 * Plain text: paragraphs and "- " bullets as written, tables as
 * tab-separated rows (pastes into a spreadsheet as cells).
 */
export function blocksToPlainText(blocks: Block[], indent = ""): string {
  return blocks
    .map((b): string => {
      switch (b.t) {
        case "p":
          return indent + inlineText(b.c);
        case "h":
          return `${indent}${inlineText(b.c).toUpperCase()}`;
        case "list":
          return b.items
            .map((item, i) => {
              const mark = b.ordered ? `${b.start + i}.` : "-";
              const box = item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
              const [first, ...rest] = item.c;
              const head = first ? blocksToPlainText([first]).replace(/\n/g, " ") : "";
              const tail = rest.length
                ? "\n" + blocksToPlainText(rest, indent + "  ")
                : "";
              return `${indent}${mark} ${box}${head}${tail}`;
            })
            .join("\n");
        case "quote":
          return blocksToPlainText(b.c)
            .split("\n")
            .map((line) => `${indent}> ${line}`)
            .join("\n");
        case "code":
          return b.v;
        case "math":
          return indent + b.v;
        case "hr":
          return `${indent}---`;
        case "table":
          return [b.head, ...b.rows]
            .map((row) => row.map((c) => inlineText(c)).join("\t"))
            .join("\n");
        case "refs":
          return [b.title, ...b.items.map((e, i) => `${i + 1}. ${inlineText(e)}`)].join("\n");
      }
    })
    .join("\n\n");
}

/**
 * Unit tests for the research chat's Markdown + LaTeX parser.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  inlineText,
  parseBlocks,
  parseChatMarkdown,
  parseInline,
  splitRow,
} from "../src/utils/chatMarkdown.ts";

const kinds = (nodes) => nodes.map((n) => n.t);
const first = (src) => parseChatMarkdown(src)[0];

test("inline emphasis, code, strike and nesting", () => {
  assert.deepEqual(kinds(parseInline("a **b** *c* `d` ~~e~~")), [
    "text", "strong", "text", "em", "text", "code", "text", "del",
  ]);
  const nested = parseInline("**bold with *italic* inside**")[0];
  assert.equal(nested.t, "strong");
  assert.deepEqual(kinds(nested.c), ["text", "em", "text"]);
  assert.equal(parseInline("***both***")[0].c[0].t, "em");
});

test("underscores inside words and identifiers are not italics", () => {
  assert.deepEqual(parseInline("use snake_case_name here"), [
    { t: "text", v: "use snake_case_name here" },
  ]);
  assert.equal(parseInline("an _emphasised_ word")[1].t, "em");
  // a lone asterisk (multiplication, footnote) stays text
  assert.equal(inlineText(parseInline("2 * 3 = 6 and 4 * 5")), "2 * 3 = 6 and 4 * 5");
});

test("escapes", () => {
  assert.equal(inlineText(parseInline("\\*not italic\\* and \\$5")), "*not italic* and $5");
});

test("inline math: dollars, parens, and the currency rule", () => {
  assert.deepEqual(parseInline("energy $E = mc^2$ here")[1], { t: "math", v: "E = mc^2" });
  assert.deepEqual(parseInline("so \\(x_i\\) holds")[1], { t: "math", v: "x_i" });
  assert.deepEqual(parseInline("$$a+b$$")[0], { t: "math", v: "a+b" });
  // currency is never math
  for (const money of ["it costs $5 and $10 total", "$5", "paid $100 or $200.", "US$ 5 to $ 7"]) {
    assert.ok(!parseInline(money).some((n) => n.t === "math"), money);
  }
  // spaces inside the dollars are not math either
  assert.ok(!parseInline("a $ x $ b").some((n) => n.t === "math"));
});

test("code spans keep dollars, stars and underscores literal", () => {
  const nodes = parseInline("run `a_b * $c$` now");
  assert.deepEqual(nodes[1], { t: "code", v: "a_b * $c$" });
});

test("links: markdown, bare urls with trailing punctuation, unsafe schemes", () => {
  const link = parseInline("see [the paper](https://doi.org/10.1/x_y) now")[1];
  assert.equal(link.t, "link");
  assert.equal(link.href, "https://doi.org/10.1/x_y");
  const bare = parseInline("at https://example.com/a_b_c.")[1];
  assert.equal(bare.href, "https://example.com/a_b_c");
  assert.ok(!parseInline("[x](javascript:alert(1))").some((n) => n.t === "link"));
});

test("source markers become citations, ranges expand", () => {
  assert.deepEqual(parseInline("claim [1][3].").filter((n) => n.t === "cite").map((n) => n.nums), [[1], [3]]);
  assert.deepEqual(parseInline("[2, 4]")[0].nums, [2, 4]);
  assert.deepEqual(parseInline("[2-4]")[0].nums, [2, 3, 4]);
  assert.deepEqual(parseChatMarkdown("fullwidth 【7】")[0].c.filter((n) => n.t === "cite")[0].nums, [7]);
  // a markdown link is not a citation
  assert.ok(!parseInline("[1](https://x.org)").some((n) => n.t === "cite"));
});

test("headings, rules, quotes", () => {
  assert.deepEqual(first("## Title ##"), { t: "h", level: 2, c: [{ t: "text", v: "Title" }] });
  assert.equal(parseChatMarkdown("a\n\n---\n\nb")[1].t, "hr");
  const quote = first("> one\n> two\n>\n> three");
  assert.equal(quote.t, "quote");
  assert.ok(quote.c.length >= 1);
});

test("paragraph soft breaks are kept as line breaks", () => {
  const p = first("line one\nline two");
  assert.deepEqual(kinds(p.c), ["text", "br", "text"]);
});

test("unordered, ordered, nested and task lists", () => {
  const ul = first("- a\n- b\n  - b1\n  - b2\n- c");
  assert.equal(ul.t, "list");
  assert.equal(ul.items.length, 3);
  assert.equal(ul.items[1].c[1].t, "list");
  assert.equal(ul.items[1].c[1].items.length, 2);

  const ol = first("3. three\n4. four");
  assert.deepEqual([ol.ordered, ol.start, ol.items.length], [true, 3, 2]);

  const tasks = first("- [x] done\n- [ ] todo");
  assert.deepEqual(tasks.items.map((i) => i.checked), [true, false]);

  // numbered list with indented continuation paragraph and sub-bullets
  const mixed = first("1. First\n   - sub a\n   - sub b\n2. Second");
  assert.equal(mixed.items.length, 2);
  assert.equal(mixed.items[0].c[1].t, "list");
});

test("a bullet is not mistaken for emphasis or a rule", () => {
  assert.equal(first("* item").t, "list");
  assert.equal(first("- - -").t, "hr");
});

test("tables: standard, no outer pipes, alignment, ragged rows, escaped pipes", () => {
  const t = first("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x | y |");
  assert.equal(t.t, "table");
  assert.deepEqual(t.align, ["left", "center", "right"]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1].length, 3); // padded
  assert.equal(inlineText(t.rows[1][2]), "");

  const bare = first("Name | Value\n--- | ---\nfoo | 1");
  assert.equal(bare.t, "table");
  assert.equal(inlineText(bare.rows[0][0]), "foo");

  assert.deepEqual(splitRow("| a \\| b | `c|d` | e |"), ["a | b", "`c|d`", "e"]);

  // a pipe inside math belongs to the formula, not to the column layout
  assert.deepEqual(splitRow("| norm | $|x|$ | $\\|v\\|$ |"), ["norm", "$|x|$", "$\\|v\\|$"]);
  assert.equal(first("| a | b |\n|---|---|\n| $|x|$ | y |").rows[0].length, 2);
  // currency does not swallow a column boundary
  assert.deepEqual(splitRow("| $5 | $10 |"), ["$5", "$10"]);

  // inline markdown and math inside cells
  const rich = first("| m | f |\n|---|---|\n| **bold** | $x^2$ |");
  assert.equal(rich.rows[0][0][0].t, "strong");
  assert.equal(rich.rows[0][1][0].t, "math");
});

test("a pipe without a separator row is just text", () => {
  assert.equal(first("a | b | c").t, "p");
});

test("fenced code: language, tilde fences, unclosed fence, nothing parsed inside", () => {
  const code = first("```python\nx = **2**\n$y$\n```");
  assert.deepEqual([code.t, code.lang, code.v], ["code", "python", "x = **2**\n$y$"]);
  assert.equal(first("~~~\nplain\n~~~").v, "plain");
  assert.equal(first("```js\nunfinished()").v, "unfinished()");
});

test("display math in all its spellings", () => {
  assert.deepEqual(first("$$\\int_0^1 x\\,dx$$"), { t: "math", v: "\\int_0^1 x\\,dx" });
  assert.deepEqual(first("$$\na = b\n$$"), { t: "math", v: "a = b" });
  assert.deepEqual(first("\\[ y = mx + b \\]"), { t: "math", v: "y = mx + b" });
  const env = first("\\begin{aligned}\na &= 1 \\\\\nb &= 2\n\\end{aligned}");
  assert.equal(env.t, "math");
  assert.ok(env.v.includes("\\end{aligned}"));
});

test("the chat's appended reference list becomes a list of entries", () => {
  const refs = parseChatMarkdown("Body text [1].\n\nReferences\nSmith, J. (2020). A title. https://doi.org/10.1/a_b\nDoe, A. (2019). Another.")[1];
  assert.equal(refs.t, "refs");
  assert.equal(refs.items.length, 2);
  // underscores in the DOI did not become italics
  assert.ok(refs.items[0].some((n) => n.t === "link" && n.href.endsWith("a_b")));
  assert.equal(parseChatMarkdown("IEEE\n\nReferences\n[1] A. B, \"T,\" 2020.")[1].items[0][0].t, "cite");
});

test("a model that wraps everything in a markdown fence is unwrapped", () => {
  const blocks = parseChatMarkdown("```markdown\n# Hi\n\n- a\n```");
  assert.equal(blocks[0].t, "h");
});

test("hostile or broken input never throws and stays text", () => {
  const nasty = [
    "<script>alert(1)</script>", "[x](javascript:evil)", "**unclosed", "$$ never closed",
    "| a |\n|---", "```", "> ", "1.", "- ", "\\", "$", "[", "[]()", "__", "***", "~~", "\u0000",
    "a".repeat(5000), "* ".repeat(500), "$".repeat(300), "[".repeat(200),
  ];
  for (const src of nasty) {
    assert.doesNotThrow(() => parseChatMarkdown(src), src.slice(0, 30));
  }
  // raw HTML is plain text: there is no HTML node type to render
  const html = first("<img src=x onerror=alert(1)>");
  assert.equal(html.t, "p");
  assert.equal(inlineText(html.c), "<img src=x onerror=alert(1)>");
});

test("empty and whitespace input", () => {
  assert.deepEqual(parseChatMarkdown(""), []);
  assert.deepEqual(parseChatMarkdown("  \n\n  "), []);
  assert.deepEqual(parseBlocks([]), []);
});

test("a realistic mixed answer", () => {
  const src = [
    "## Findings",
    "",
    "Retrieval improves with *hybrid* ranking [1][2]. For $k=10$, nDCG is $0.42$.",
    "",
    "| Pipeline | nDCG@10 |",
    "|---|--:|",
    "| TF-IDF | 0.31 |",
    "| Hybrid | 0.42 |",
    "",
    "$$\\mathrm{nDCG} = \\frac{DCG}{IDCG}$$",
    "",
    "1. Compare lists",
    "2. Test the gap",
    "   - paired Wilcoxon",
    "",
    "> Caveat: small sample.",
    "",
    "References",
    "[1] Smith (2020).",
  ].join("\n");
  assert.deepEqual(kinds(parseChatMarkdown(src)), [
    "h", "p", "table", "math", "list", "quote", "refs",
  ]);
});

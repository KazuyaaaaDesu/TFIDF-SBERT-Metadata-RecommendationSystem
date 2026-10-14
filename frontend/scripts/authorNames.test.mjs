/**
 * Unit tests for the structured author-name helpers. They mirror
 * test/test_author_names.py (the Python counterpart) case for case, so
 * the two implementations cannot drift apart.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  displayString,
  familyNames,
  formatApa,
  formatBibtex,
  formatChicago,
  formatIeee,
  formatMla,
  initials,
  paperAuthors,
  parseAuthor,
  parseAuthorList,
} from "../src/utils/authorNames.ts";
import { citationParts } from "../src/utils/citationStyles.ts";
import { citationKey, paperToBibtex, paperToRis } from "../src/utils/exportCitations.ts";

const P = (text) => {
  const n = parseAuthor(text);
  return [n.given, n.middle, n.family, n.suffix];
};
const N = (given, middle, family, suffix = "") => ({ given, middle, family, suffix });

test("parses first-last, middle names, inverted, particles, suffixes", () => {
  assert.deepEqual(P("John Smith"), ["John", "", "Smith", ""]);
  assert.deepEqual(P("John Ronald Reuel Tolkien"), ["John", "Ronald Reuel", "Tolkien", ""]);
  assert.deepEqual(P("J. R. R. Tolkien"), ["J.", "R. R.", "Tolkien", ""]);
  assert.deepEqual(P("Smith, John Michael"), ["John", "Michael", "Smith", ""]);
  assert.deepEqual(P("Ludwig van Beethoven"), ["Ludwig", "", "van Beethoven", ""]);
  assert.deepEqual(P("van der Berg, Jan"), ["Jan", "", "van der Berg", ""]);
  assert.deepEqual(P("Martin Luther King Jr."), ["Martin", "Luther", "King", "Jr."]);
  assert.deepEqual(P("King, Jr., Martin Luther"), ["Martin", "Luther", "King", "Jr."]);
  assert.deepEqual(P("Smith JR"), ["J", "R", "Smith", ""]);
  assert.deepEqual(P("SMITH, John"), ["John", "", "Smith", ""]);
});

test("single tokens, placeholders and corporate authors", () => {
  assert.deepEqual(P("Plato"), ["", "", "Plato", ""]);
  assert.equal(parseAuthor(""), null);
  assert.equal(parseAuthor("Unknown"), null);
  assert.equal(parseAuthor("et al."), null);
  assert.equal(parseAuthor("ATLAS Collaboration").family, "ATLAS Collaboration");
});

test("splits whole author strings", () => {
  const fams = (t) => parseAuthorList(t).map((n) => n.family);
  assert.deepEqual(fams("Smith, John; Doe, Jane A."), ["Smith", "Doe"]);
  assert.deepEqual(fams("John Smith and Jane Doe"), ["Smith", "Doe"]);
  assert.deepEqual(fams("John Smith, Jane Doe and Bob Roe"), ["Smith", "Doe", "Roe"]);
  assert.deepEqual(fams("John Smith, Jane Doe, Bob Roe"), ["Smith", "Doe", "Roe"]);
  assert.deepEqual(fams("Smith, John, Doe, Jane"), ["Smith", "Doe"]);
  assert.equal(parseAuthorList("Smith, John").length, 1);
  assert.deepEqual(fams(""), []);
  assert.equal(displayString(parseAuthorList("Smith, John M.; Doe, Jane")), "John M. Smith; Jane Doe");
});

test("initials", () => {
  assert.equal(initials(N("John", "Ronald", "T")), "J. R.");
  assert.equal(initials(N("J.", "R.", "T")), "J. R.");
  assert.equal(initials(N("JR", "", "T")), "J. R.");
  assert.equal(initials(N("Jean-Paul", "", "Sartre")), "J.-P.");
  assert.equal(initials(N("Hye‐Jin", "", "Paek")), "H.-J.");
});

const A = N("John", "Michael", "Smith");
const B = N("Jane", "", "Doe");
const C = N("Bob", "A.", "Roe");

test("style renderings match the Python formatter", () => {
  assert.equal(formatApa([A, B, C]), "Smith, J. M., Doe, J., & Roe, B. A.");
  assert.equal(formatApa([A, B]), "Smith, J. M., & Doe, J.");
  assert.equal(formatMla([A]), "Smith, John Michael");
  assert.equal(formatMla([A, B]), "Smith, John Michael, and Jane Doe");
  assert.equal(formatMla([A, B, C]), "Smith, John Michael, et al.");
  assert.equal(formatChicago([A, B]), "Smith, John Michael, and Jane Doe");
  assert.equal(formatChicago([A, B, C]), "Smith, John Michael, Jane Doe, and Bob A. Roe");
  assert.equal(formatIeee([A, B, C]), "J. M. Smith, J. Doe, and B. A. Roe");
  assert.equal(formatBibtex([A, B]), "Smith, John Michael and Doe, Jane");
  assert.equal(formatBibtex([parseAuthor("ATLAS Collaboration")]), "{ATLAS Collaboration}");
});

test("et al. rules", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => N("A", "", `F${i}`));
  assert.ok(formatApa(many(25)).includes(". . ."));
  assert.ok(formatApa(many(25)).endsWith("F24, A."));
  assert.equal(formatIeee(many(7)), "A. F0 et al.");
  assert.ok(formatChicago(many(12)).endsWith(", et al."));
  assert.deepEqual(familyNames([A, B]), ["Smith", "Doe"]);
});

const PAPER = {
  id: 1,
  title: "Notes on the analytical engine",
  author: "Whatever Display String",
  authors: [N("Ada", "Augusta", "King"), N("Martin", "Luther", "King", "Jr.")],
  publication_year: 1843,
  doi: null,
  document_type: "Journal Article",
};

test("stored parts win over the display string; fall back when absent", () => {
  assert.equal(paperAuthors(PAPER).length, 2);
  const web = { author: "Jane Doe and John Roe", authors: [] };
  assert.deepEqual(familyNames(paperAuthors(web)), ["Doe", "Roe"]);
});

test("Copy-as uses each style's own author form", () => {
  assert.equal(
    citationParts(PAPER, "apa", false).text,
    "King, A. A., & King, M. L. Jr. (1843). Notes on the analytical engine.",
  );
  assert.equal(
    citationParts(PAPER, "ieee", false, 1).text,
    '[1] A. A. King and M. L. King, Jr., "Notes on the analytical engine," 1843.',
  );
  assert.equal(
    citationParts(PAPER, "mla", false).text,
    'King, Ada Augusta, and Martin Luther King Jr. "Notes on the analytical engine". 1843.',
  );
});

test("exports write one properly formed name per author", () => {
  const bib = paperToBibtex(PAPER);
  assert.ok(bib.includes("author = {King, Ada Augusta and King, Martin Luther, Jr.},"));
  assert.ok(bib.startsWith("@article{king1843,"));
  assert.equal(citationKey(PAPER), "king1843");

  const ris = paperToRis({ ...PAPER, author: "Smith, John" , authors: [N("John", "", "Smith")] });
  assert.ok(ris.includes("AU  - Smith, John\n"));
  // The old comma-splitting turned one inverted name into two authors.
  assert.equal((ris.match(/^AU {2}- /gm) ?? []).length, 1);
});

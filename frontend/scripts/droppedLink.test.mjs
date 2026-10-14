import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDroppedUrl,
  isScholarExportUrl,
} from "../src/utils/droppedLink.ts";

const dt = (map) => (t) => map[t] ?? "";

test("uri-list with comments and several urls", () => {
  const u = extractDroppedUrl(
    dt({ "text/uri-list": "# comment\r\nhttps://a.org/x?y=1\r\nhttps://b.org" }),
  );
  assert.equal(u, "https://a.org/x?y=1");
});

test("plain text with trailing words", () => {
  assert.equal(
    extractDroppedUrl(dt({ "text/plain": "BibTeX https://scholar.googleusercontent.com/scholar.bib?q=info:abc&output=citation extra" })),
    "https://scholar.googleusercontent.com/scholar.bib?q=info:abc&output=citation",
  );
});

test("html anchor only", () => {
  assert.equal(
    extractDroppedUrl(dt({ "text/html": '<a href="https://x.org/p?a=1&amp;b=2">BibTeX</a>' })),
    "https://x.org/p?a=1&b=2",
  );
});

test("moz url and nothing", () => {
  assert.equal(extractDroppedUrl(dt({ "text/x-moz-url": "https://m.org\nTitle" })), "https://m.org");
  assert.equal(extractDroppedUrl(dt({})), null);
});

test("scholar export detection", () => {
  assert.ok(isScholarExportUrl("https://scholar.googleusercontent.com/scholar.bib?q=info:x"));
  assert.ok(isScholarExportUrl("https://scholar.google.com/scholar.ris?q=1"));
  assert.ok(!isScholarExportUrl("https://example.org/scholar.bib"));
});

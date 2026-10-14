/**
 * Unit tests for the web-neighborhood provenance helpers.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  answeredSources,
  provenanceLabel,
  sourceLabel,
  unavailableNote,
  workUrl,
} from "../src/utils/webWorkSources.ts";

const WORK = (over = {}) => ({
  work_id: "W123",
  title: "Attention Is All You Need",
  doi: null,
  publication_year: 2017,
  cited_by_count: 100,
  author: "Vaswani",
  ...over,
});

test("a payload with no source list reads as OpenAlex alone", () => {
  assert.equal(answeredSources(null), "OpenAlex");
  assert.equal(answeredSources({ sources: undefined }), "OpenAlex");
  assert.equal(answeredSources({ sources: ["openalex"] }), "OpenAlex");
});

test("the answered-sources caption names every provider that replied", () => {
  assert.equal(
    answeredSources({ sources: ["openalex", "semantic_scholar", "crossref"] }),
    "OpenAlex + Semantic Scholar + Crossref"
  );
  assert.equal(
    answeredSources({ sources: ["openalex", "crossref"] }),
    "OpenAlex + Crossref"
  );
});

test("unknown providers still render readably", () => {
  assert.equal(sourceLabel("doaj"), "doaj");
  assert.equal(
    answeredSources({ sources: ["openalex", "doaj"] }),
    "OpenAlex + doaj"
  );
});

test("a DOI is the preferred link: every provider agrees on it", () => {
  assert.equal(
    workUrl(WORK({ doi: "10.0/x", work_id: "s2:abc" })),
    "https://doi.org/10.0/x"
  );
});

test("without a DOI, an OpenAlex id links to its work page", () => {
  assert.equal(
    workUrl(WORK({ work_id: "W123" })),
    "https://openalex.org/W123"
  );
});

test("a namespaced id is never pasted into an openalex.org URL", () => {
  // The old unconditional link did exactly this and 404'd every row
  // the extra providers contributed.
  const semantic = workUrl(
    WORK({ work_id: "s2:abc123", sources: ["semantic_scholar"] })
  );
  assert.ok(semantic);
  assert.ok(!semantic.includes("openalex.org"));
  assert.equal(
    semantic,
    "https://www.semanticscholar.org/paper/abc123"
  );

  const crossref = workUrl(
    WORK({
      work_id: "cr:some paper title",
      sources: ["crossref"],
    })
  );
  assert.ok(crossref);
  assert.ok(!crossref.includes("openalex.org"));
});

test("an unaddressable row with no DOI, no valid id and no title links nowhere", () => {
  assert.equal(
    workUrl(
      WORK({
        work_id: "cr:",
        title: null,
        sources: ["crossref"],
      })
    ),
    null
  );
});

test("provenance is only marked when a row is not plain OpenAlex", () => {
  assert.equal(provenanceLabel(WORK({ sources: ["openalex"] })), null);
  assert.equal(provenanceLabel(WORK({})), null);

  assert.equal(
    provenanceLabel(WORK({ sources: ["semantic_scholar"] })),
    "Semantic Scholar"
  );
  assert.equal(
    provenanceLabel(
      WORK({ sources: ["openalex", "semantic_scholar"] })
    ),
    "OpenAlex + Semantic Scholar"
  );
});
test("a provider that is down is called out; one with no record is not", () => {
  assert.equal(unavailableNote(null), null);
  assert.equal(unavailableNote({ sources_skipped: {} }), null);

  // Coverage is not a fault and must stay quiet.
  assert.equal(
    unavailableNote({ sources_skipped: { europe_pmc: "no_record" } }),
    null
  );

  assert.equal(
    unavailableNote({
      sources_skipped: {
        semantic_scholar: "unavailable",
        europe_pmc: "no_record",
      },
    }),
    "Semantic Scholar did not answer — the list is narrower than usual."
  );
});

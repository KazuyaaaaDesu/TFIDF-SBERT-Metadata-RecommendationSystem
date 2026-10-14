/**
 * Where a web-neighborhood work came from, and where to send the reader.
 *
 * The prior/derivative lists are a union of several providers
 * (see app/services/web_connections_extra.py), so a row's `work_id` is
 * namespaced by origin -- "W123" is OpenAlex, "s2:<paperId>" is Semantic
 * Scholar, "doi:<doi>" and "cr:<title>" are Crossref, "oc:<id>" is
 * OpenCitations, "epmc:<MED|PMC>:<id>" is Europe PMC. That means the
 * old unconditional `openalex.org/${work_id}` link produced a dead URL
 * for every non-OpenAlex row, and every row had to be treated as if a
 * single graph had produced it.
 *
 * These helpers turn the raw fields into the two things the UI needs:
 * a provenance label per row, and one honest link per row.
 */

import type { WebConnections, WebWork } from "../api";

/** Display names for the providers, keyed by the ids the API returns. */
export const SOURCE_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  semantic_scholar: "Semantic Scholar",
  crossref: "Crossref",
  open_citations: "OpenCitations",
  europe_pmc: "Europe PMC",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * "OpenAlex + Semantic Scholar" — the providers that actually answered,
 * for the caption above a list. Falls back to naming OpenAlex alone
 * when the payload predates multi-source neighborhoods.
 */
export function answeredSources(
  connections: Pick<WebConnections, "sources"> | null | undefined
): string {
  const sources = connections?.sources?.filter(
    (name) => name !== "openalex"
  );

  if (!sources || sources.length === 0) return "OpenAlex";

  return ["OpenAlex", ...sources].map(sourceLabel).join(" + ");
}

/**
 * A trailing note when a provider could not be reached.
 *
 * Only "unavailable" is worth saying out loud. A provider reporting
 * "no_record" is telling us something true about its coverage; one
 * reporting "unavailable" is broken right now, and without this the
 * list would quietly come back short with nothing to explain why.
 */
export function unavailableNote(
  connections:
    | Pick<WebConnections, "sources_skipped">
    | null
    | undefined
): string | null {
  const skipped = connections?.sources_skipped;

  if (!skipped) return null;

  const down = Object.entries(skipped)
    .filter(([, reason]) => reason === "unavailable")
    .map(([name]) => sourceLabel(name));

  if (down.length === 0) return null;

  return `${down.join(", ")} did not answer — the list is narrower than usual.`;
}

/**
 * Where this row should link to.
 *
 * A DOI is preferred: it is the one identifier every provider agrees
 * on, and it resolves regardless of which graph the row came from.
 * Without a DOI, each provider's own id is addressable only on its own
 * site, and Europe PMC and OpenCitations rows carry neither a DOI nor a
 * public URL -- for those a title search is the honest link rather than
 * a dead one.
 */
export function workUrl(work: WebWork): string | null {
  if (work.doi) {
    return `https://doi.org/${work.doi}`;
  }

  const sources = work.sources?.length ? work.sources : ["openalex"];

  if (sources.includes("openalex") && /^W\d+$/.test(work.work_id)) {
    return `https://openalex.org/${work.work_id}`;
  }

  if (sources.includes("semantic_scholar")) {
    const paperId = work.work_id.replace(/^s2:/, "");

    if (paperId) {
      return `https://www.semanticscholar.org/paper/${encodeURIComponent(
        paperId
      )}`;
    }
  }

  if (sources.includes("europe_pmc")) {
    const [, , identifier] = work.work_id.split(":");

    if (identifier) {
      return `https://europepmc.org/article/MED/${identifier}`;
    }
  }

  if (work.title) {
    return `https://search.crossref.org/?q=${encodeURIComponent(
      work.title
    )}`;
  }

  return null;
}

/**
 * A row's provenance, as a short label. OpenAlex leads the merge, so a
 * single-source row is bare and only corroborated or foreign rows are
 * worth marking.
 */
export function provenanceLabel(work: WebWork): string | null {
  const sources = work.sources?.length ? work.sources : ["openalex"];

  if (sources.length <= 1) {
    return sources[0] === "openalex" ? null : sourceLabel(sources[0]);
  }

  return sources.map(sourceLabel).join(" + ");
}
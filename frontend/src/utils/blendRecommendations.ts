/**
 * BLEND RECOMMENDATIONS — merge local (repository) and web
 * recommendation lists into one ranked list.
 *
 * Both lists come from the same pipeline weights, but each one min-max
 * normalises its TF-IDF / S-BERT signals across ITS OWN candidate set,
 * so a "1.0" in one list is not the same evidence as a "1.0" in the
 * other. To compare them, every list is rescaled by its own best score
 * (the top of each list becomes 1), which keeps each list's internal
 * order and ratios and interleaves the two by relative strength. The
 * pipeline's own score is still what the row displays.
 *
 * Pure and dependency free (types only) so it can be unit tested.
 */
import type { Paper, SearchResult, WebSearchResult } from "../api";

export type BlendRow =
  | {
      origin: "local";
      result: SearchResult;
      /** Score rescaled by the local list's best (0..1). */
      blendScore: number;
    }
  | {
      origin: "web";
      web: WebSearchResult;
      score: number;
      blendScore: number;
    };

export function normalizeDoi(doi: string | null | undefined): string {
  return (doi ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
}

export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when a web hit is the same work as a local paper. */
export function isSameWork(
  paper: Pick<Paper, "doi" | "title" | "publication_year">,
  web: Pick<WebSearchResult, "doi" | "title" | "publication_year">,
): boolean {
  const a = normalizeDoi(paper.doi);
  const b = normalizeDoi(web.doi);

  if (a && b) return a === b;

  const titleA = normalizeTitle(paper.title);

  if (!titleA || titleA !== normalizeTitle(web.title)) return false;

  // A missing year on either side does not veto an exact title match.
  return (
    paper.publication_year == null ||
    web.publication_year == null ||
    paper.publication_year === web.publication_year
  );
}

/** Rescale by the list's best score; never rises along the list. */
function rescale(scores: number[]): number[] {
  const best = Math.max(0, ...scores);
  let ceiling = 1;

  return scores.map((score) => {
    const value = best > 0 ? Math.max(0, score) / best : 0;
    ceiling = Math.min(ceiling, value);
    return ceiling;
  });
}

export function blendRecommendations({
  local,
  web,
  topK,
}: {
  local: SearchResult[];
  web: WebSearchResult[];
  topK: number;
}): BlendRow[] {
  const freshWeb = web.filter(
    (hit) => !local.some((row) => isSameWork(row.paper, hit)),
  );

  const localScaled = rescale(local.map((row) => row.score));
  const webScaled = rescale(freshWeb.map((hit) => hit.score ?? 0));

  const rows: { row: BlendRow; order: number }[] = [
    ...local.map((result, i) => ({
      row: {
        origin: "local" as const,
        result,
        blendScore: localScaled[i],
      },
      order: i,
    })),
    ...freshWeb.map((hit, i) => ({
      row: {
        origin: "web" as const,
        web: hit,
        score: hit.score ?? 0,
        blendScore: webScaled[i],
      },
      order: local.length + i,
    })),
  ];

  rows.sort(
    (a, b) =>
      b.row.blendScore - a.row.blendScore ||
      // Ties: the local paper wins, then original order.
      (a.row.origin === b.row.origin ? 0 : a.row.origin === "local" ? -1 : 1) ||
      a.order - b.order,
  );

  return rows.slice(0, Math.max(0, topK)).map((entry) => entry.row);
}

/** The web query for a seed-paper run: title plus a few keywords. */
export function seedWebQuery(
  paper: Pick<Paper, "title" | "keywords">,
): string {
  const keywords = (paper.keywords ?? "")
    .split(/[;,\n]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 4);

  return [paper.title?.trim() ?? "", ...keywords]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

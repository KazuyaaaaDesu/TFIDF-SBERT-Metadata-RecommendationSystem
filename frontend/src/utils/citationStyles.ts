/**
 * CITATION STYLES — single-paper formatted citations for the
 * "Copy as" context-menu actions, matching the styles offered in the
 * Settings tab (APA 7, MLA 9, Chicago, IEEE).
 *
 * The repository record has no journal/venue field, so these are
 * title-level citations. What gets italicized depends on the
 * document type, exactly like the manuals:
 *
 *   Journal Article / Conference Paper -> the title is plain (APA)
 *     or quoted (MLA / Chicago / IEEE); a venue would be italic but
 *     none is stored.
 *   Thesis / Technical Report -> the title is the standalone work,
 *     so it is italicized in every style.
 *
 * `citationParts()` returns both the plain text and the HTML flavor
 * (with <i> markup); the context menu puts the HTML on the clipboard
 * so Word and other rich editors keep the italics on paste.
 */

import type { Paper } from "../api";
import {
  formatApa,
  formatChicago,
  formatIeee,
  formatMla,
  paperAuthors,
} from "./authorNames.ts";
import type { CitationStyle } from "./preferences";

/**
 * The author block in the form `style` writes it, built from the
 * stored given / middle / family parts: APA "Smith, J. M., & Doe, J.",
 * MLA "Smith, John Michael, and Jane Doe", IEEE "J. M. Smith and
 * J. Doe". Each style applies its own et-al. rule.
 */
function author(paper: Paper, style: CitationStyle): string {
  const names = paperAuthors(paper);

  if (!names.length) return "Unknown author";

  switch (style) {
    case "apa":
      return formatApa(names);
    case "mla":
      return formatMla(names);
    case "chicago":
      return formatChicago(names);
    case "ieee":
      return formatIeee(names);
  }
}

/** A name block ends in exactly one full stop ("et al." keeps its own). */
function end(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function year(paper: Paper): string {
  return paper.publication_year
    ? String(paper.publication_year)
    : "n.d.";
}

function title(paper: Paper): string {
  return (paper.title ?? "").trim() || "Untitled";
}

/** Standalone works carry an italicized title in every style. */
export function isStandaloneWork(paper: Paper): boolean {
  const type = (paper.document_type ?? "").toLowerCase();

  return (
    type.includes("thesis") ||
    type.includes("dissertation") ||
    type.includes("report") ||
    type.includes("book")
  );
}

function doiSuffix(
  paper: Paper,
  includeDoi: boolean,
  style: CitationStyle
): string {
  const doi = (paper.doi ?? "").trim();

  if (!includeDoi || !doi) {
    return "";
  }

  switch (style) {
    case "apa":
      return ` https://doi.org/${doi}`;
    case "mla":
      return ` DOI: ${doi}.`;
    case "chicago":
      return ` https://doi.org/${doi}.`;
    case "ieee":
      return ` doi: ${doi}.`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface CitationParts {
  /** Plain-text citation (clipboard fallback, downloads). */
  text: string;
  /** HTML citation with <i> around the italicized segments. */
  html: string;
}

export function citationParts(
  paper: Paper,
  style: CitationStyle,
  includeDoi: boolean,
  index?: number
): CitationParts {
  const names = author(paper, style);
  const when = year(paper);
  const work = title(paper);
  const doi = doiSuffix(paper, includeDoi, style);
  const standalone = isStandaloneWork(paper);

  const quotedWork = `"${work}"`;
  const italic = `<i>${escapeHtml(work)}</i>`;

  const safeNames = escapeHtml(names);
  const safeDoi = escapeHtml(doi);

  switch (style) {
    case "apa":
      if (standalone) {
        return {
          text: `${names} (${when}). ${work}.${doi}`,
          html: `${safeNames} (${when}). ${italic}.${safeDoi}`,
        };
      }

      return {
        text: `${names} (${when}). ${work}.${doi}`,
        html: `${safeNames} (${when}). ${escapeHtml(work)}.${safeDoi}`,
      };

    case "mla":
      if (standalone) {
        return {
          text: `${end(names)} ${work}. ${when}.${doi}`,
          html: `${end(safeNames)} ${italic}. ${when}.${safeDoi}`,
        };
      }

      return {
        text: `${end(names)} ${quotedWork}. ${when}.${doi}`,
        html: `${end(safeNames)} ${escapeHtml(quotedWork)}. ${when}.${safeDoi}`,
      };

    case "chicago":
      if (standalone) {
        return {
          text: `${end(names)} ${work}. ${when}.${doi}`,
          html: `${end(safeNames)} ${italic}. ${when}.${safeDoi}`,
        };
      }

      return {
        text: `${end(names)} ${quotedWork}. ${when}.${doi}`,
        html: `${end(safeNames)} ${escapeHtml(quotedWork)}. ${when}.${safeDoi}`,
      };

    case "ieee": {
      const prefix = index !== undefined ? `[${index}] ` : "";

      if (standalone) {
        return {
          text: `${prefix}${names}, ${work}, ${when}.${doi}`,
          html: `${prefix}${safeNames}, ${italic}, ${when}.${safeDoi}`,
        };
      }

      return {
        text: `${prefix}${names}, "${work}," ${when}.${doi}`,
        html: `${prefix}${safeNames}, &quot;${escapeHtml(
          work
        )},&quot; ${when}.${safeDoi}`,
      };
    }
  }
}

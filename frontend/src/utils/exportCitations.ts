import type { Paper } from "../api";
import {
  familyNames,
  formatBibtex,
  invertedName,
  paperAuthors,
} from "./authorNames.ts";

/* ============================================================
   CITATION EXPORT — BibTeX, RIS, EndNote, and Reference
   Manager (RefNotes) strings for a stored paper or a batch of
   them (My Library's batch export), plus a download helper.
   The exported fields follow the record the repository actually
   stores.
   ============================================================ */

export type CitationFormat = "bibtex" | "ris" | "endnote" | "refman";

export const CITATION_FORMATS: { id: CitationFormat; label: string; ext: string; mime: string }[] = [
  { id: "bibtex", label: "BibTeX (.bib)", ext: "bib", mime: "application/x-bibtex" },
  { id: "ris", label: "RIS (.ris)", ext: "ris", mime: "application/x-research-info-systems" },
  { id: "endnote", label: "EndNote (.enw)", ext: "enw", mime: "application/x-endnote-refer" },
  { id: "refman", label: "Reference Manager (.txt)", ext: "txt", mime: "text/plain" },
];

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function cleanMulti(value: string | null | undefined): string[] {
  return clean(value)
    .split(/[|;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** First author's family name + year, for citation keys. */
export function citationKey(paper: Paper): string {
  const surname =
    familyNames(paperAuthors(paper))[0]
      ?.toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z]/g, "") || "paper";

  const year = paper.publication_year ?? "";

  return `${surname}${year}`;
}

function bibType(paper: Paper): string {
  const type = clean(paper.document_type).toLowerCase();

  if (type.includes("thesis")) return "phdthesis";
  if (type.includes("conference")) return "inproceedings";
  if (type.includes("report")) return "techreport";
  if (type.includes("book")) return "book";
  return "article";
}

function bibField(name: string, value: string | null | undefined): string {
  const text = clean(value);
  if (!text) return "";
  return `  ${name} = {${text}},`;
}

export function paperToBibtex(
  paper: Paper,
  options?: { includeAbstract?: boolean },
): string {
  const lines: string[] = [];

  lines.push(`@${bibType(paper)}{${citationKey(paper)},`);

  const fields: [string, string | null | undefined][] = [
    ["title", paper.title],
    ["author", formatBibtex(paperAuthors(paper))],
    ["year", paper.publication_year?.toString()],
    ...(options?.includeAbstract === false
      ? []
      : ([["abstract", paper.abstract]] as [
          string,
          string | null | undefined,
        ][])),
    ["keywords", paper.keywords],
    ["doi", paper.doi],
  ];

  for (const [name, value] of fields) {
    const line = bibField(name, value);
    if (line) lines.push(line);
  }

  if (clean(paper.subject_category)) {
    lines.push(`  note = {Subject category: ${clean(paper.subject_category)}},`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function risType(paper: Paper): string {
  const type = clean(paper.document_type).toLowerCase();

  if (type.includes("thesis")) return "THES";
  if (type.includes("conference")) return "CONF";
  if (type.includes("report")) return "RPRT";
  if (type.includes("book")) return "BOOK";
  return "JOUR";
}

export function paperToRis(paper: Paper): string {
  const lines: string[] = [`TY  - ${risType(paper)}`];

  for (const author of paperAuthors(paper)) {
    lines.push(`AU  - ${invertedName(author)}`);
  }

  if (clean(paper.title)) lines.push(`TI  - ${clean(paper.title)}`);
  if (clean(paper.abstract)) lines.push(`AB  - ${clean(paper.abstract)}`);
  if (paper.publication_year) lines.push(`PY  - ${paper.publication_year}`);

  for (const keyword of cleanMulti(paper.keywords)) {
    lines.push(`KW  - ${keyword}`);
  }

  if (clean(paper.doi)) lines.push(`DO  - ${clean(paper.doi)}`);
  if (clean(paper.subject_category)) {
    lines.push(`LA  - ${clean(paper.subject_category)}`);
  }

  lines.push("ER  - ");
  return lines.join("\n") + "\n";
}

function endnoteType(paper: Paper): string {
  const type = clean(paper.document_type).toLowerCase();

  if (type.includes("thesis")) return "Thesis";
  if (type.includes("conference")) return "Conference Paper";
  if (type.includes("report")) return "Report";
  if (type.includes("book")) return "Book";
  return "Journal Article";
}

export function paperToEndNote(paper: Paper): string {
  const lines: string[] = [`%0 ${endnoteType(paper)}`];

  for (const author of paperAuthors(paper)) {
    lines.push(`%A ${invertedName(author)}`);
  }

  if (clean(paper.title)) lines.push(`%T ${clean(paper.title)}`);
  if (paper.publication_year) lines.push(`%D ${paper.publication_year}`);
  if (clean(paper.abstract)) lines.push(`%X ${clean(paper.abstract)}`);

  for (const keyword of cleanMulti(paper.keywords)) {
    lines.push(`%K ${keyword}`);
  }

  if (clean(paper.doi)) lines.push(`%R ${clean(paper.doi)}`);
  if (clean(paper.subject_category)) {
    lines.push(`%9 ${clean(paper.subject_category)}`);
  }

  return lines.join("\n") + "\n";
}

function refmanType(paper: Paper): string {
  const type = clean(paper.document_type).toLowerCase();

  if (type.includes("thesis")) return "PT T";
  if (type.includes("conference")) return "PT C";
  if (type.includes("report")) return "PT R";
  if (type.includes("book")) return "PT B";
  return "PT J";
}

export function paperToRefMan(paper: Paper): string {
  const lines: string[] = [refmanType(paper)];

  for (const author of paperAuthors(paper)) {
    lines.push(`AU - ${invertedName(author)}`);
  }

  if (clean(paper.title)) lines.push(`TI - ${clean(paper.title)}`);
  if (clean(paper.abstract)) lines.push(`AB - ${clean(paper.abstract)}`);
  if (paper.publication_year) lines.push(`PY - ${paper.publication_year}`);

  for (const keyword of cleanMulti(paper.keywords)) {
    lines.push(`KW - ${keyword}`);
  }

  if (clean(paper.doi)) lines.push(`DO - ${clean(paper.doi)}`);

  lines.push("ER");
  return lines.join("\n") + "\n";
}

export function paperToCitation(paper: Paper, format: CitationFormat): string {
  switch (format) {
    case "bibtex":
      return paperToBibtex(paper);
    case "ris":
      return paperToRis(paper);
    case "endnote":
      return paperToEndNote(paper);
    case "refman":
      return paperToRefMan(paper);
  }
}

/** Several papers as one file's content — records separated by a
 *  blank line, the layout every one of the four formats expects. */
export function papersToCitation(
  papers: Paper[],
  format: CitationFormat,
): string {
  return papers.map((paper) => paperToCitation(paper, format)).join("\n");
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Download a paper's citation in the chosen format. */
export function downloadCitation(paper: Paper, format: CitationFormat): void {
  const meta = CITATION_FORMATS.find((item) => item.id === format);
  if (!meta) return;

  const slug =
    clean(paper.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `paper-${paper.id}`;

  downloadText(paperToCitation(paper, format), `${slug}.${meta.ext}`, meta.mime);
}

/** Download a batch of papers' citations as ONE file. */
export function downloadCitations(
  papers: Paper[],
  format: CitationFormat,
  filename?: string,
): void {
  const meta = CITATION_FORMATS.find((item) => item.id === format);
  if (!meta || papers.length === 0) return;

  const name =
    filename ?? `res-search-library-${papers.length}-papers.${meta.ext}`;

  downloadText(papersToCitation(papers, format), name, meta.mime);
}
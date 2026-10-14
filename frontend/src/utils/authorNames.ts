/**
 * AUTHOR NAMES — given / middle / family.
 *
 * A citation style needs the parts of a name, not a flat string:
 * APA "Family, G. M.", MLA "Family, Given Middle", IEEE "G. M. Family",
 * BibTeX "Family, Given Middle". The repository stores every author as
 * three parts (+ a suffix such as "Jr.") and sends them as
 * `paper.authors`; the legacy `paper.author` display string is derived.
 *
 * This file is the TypeScript counterpart of app/services/author_names.py
 * and follows it rule for rule (the unit tests mirror the Python ones).
 * `paperAuthors()` uses the stored parts and only parses the display
 * string for records that have none (web results).
 */

import type { AuthorPart } from "../api";

const CORPORATE =
  /\b(collaboration|consortium|group|team|committee|organi[sz]ation|association|institute|university|society|council|agency|commission)\b/i;

const PARTICLES = new Set([
  "van", "von", "de", "der", "den", "da", "di", "del", "della", "la",
  "le", "du", "dos", "das", "bin", "ibn", "al", "el", "ter", "ten",
  "op", "zu", "zur", "st", "st.",
]);

const SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v", "2nd", "3rd",
]);

const PLACEHOLDERS = new Set([
  "et al", "et al.", "unknown", "unknown author", "n/a", "none", "-",
]);

const HYPHENS = /[-‐‑‒–]/;

export type { AuthorPart };

const blank = (): AuthorPart => ({
  given: "",
  middle: "",
  family: "",
  suffix: "",
});

function join(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

export function isCorporate(name: AuthorPart): boolean {
  return !name.given && !name.middle && CORPORATE.test(name.family);
}

/** "Given Middle Family Suffix", the way the name is read. */
export function fullName(name: AuthorPart): string {
  return join(name.given, name.middle, name.family, name.suffix);
}

/** "Family, Given Middle, Suffix". */
export function invertedName(name: AuthorPart): string {
  const first = join(name.given, name.middle);
  if (!first) return name.family;
  return `${name.family}, ${name.suffix ? `${first}, ${name.suffix}` : first}`;
}

function initialsOf(text: string): string {
  const out: string[] = [];

  for (const token of text.split(/\s+/).filter(Boolean)) {
    const pieces: string[] = [];

    for (const piece of token.split(HYPHENS)) {
      const letters = piece.replace(/[^\p{L}\p{N}]/gu, "");
      if (!letters) continue;

      if (letters === letters.toUpperCase() && letters !== letters.toLowerCase() && letters.length <= 3) {
        pieces.push([...letters].map((c) => `${c}.`).join(" "));
      } else {
        pieces.push(`${letters[0].toUpperCase()}.`);
      }
    }

    if (pieces.length) out.push(pieces.join("-"));
  }

  return out.join(" ");
}

/** "G. M." from given + middle. */
export function initials(name: AuthorPart): string {
  return [initialsOf(name.given), initialsOf(name.middle)]
    .filter(Boolean)
    .join(" ");
}

function smartCase(text: string): string {
  if (text.length > 1 && text === text.toUpperCase() && text !== text.toLowerCase()) {
    return text.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
  }
  return text;
}

function givenMiddle(tokens: string[]): [string, string] {
  if (!tokens.length) return ["", ""];
  return [tokens[0], tokens.slice(1).join(" ")];
}

export function parseAuthor(text: string | null | undefined): AuthorPart | null {
  const value = (text ?? "").replace(/\s+/g, " ").trim().replace(/^[ ,;]+|[ ,;]+$/g, "");

  if (!value || PLACEHOLDERS.has(value.toLowerCase())) return null;

  if (CORPORATE.test(value)) return { ...blank(), family: value };

  let suffix = "";

  if (value.includes(",")) {
    const pieces = value.split(",").map((p) => p.trim()).filter(Boolean);
    const family = smartCase(pieces[0]);
    const kept: string[] = [];

    for (const piece of pieces.slice(1)) {
      if (SUFFIXES.has(piece.toLowerCase()) && !suffix) suffix = piece;
      else kept.push(piece);
    }

    const [given, middle] = givenMiddle(kept.join(" ").split(/\s+/).filter(Boolean));
    return { given, middle, family, suffix };
  }

  const tokens = value.split(" ");

  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && SUFFIXES.has(last.toLowerCase()) && last !== "JR" && last !== "SR") {
    suffix = tokens.pop() as string;
  }

  if (tokens.length === 1) return { ...blank(), family: smartCase(tokens[0]), suffix };

  // PubMed style "Smith JR": surname first, then bare initials.
  const tail = tokens[tokens.length - 1];
  if (
    tokens.length >= 2 &&
    /^[A-Z]{1,3}$/.test(tail) &&
    tokens[0] !== tokens[0].toUpperCase() &&
    !PARTICLES.has(tokens[tokens.length - 2].toLowerCase())
  ) {
    return {
      given: tail[0],
      middle: [...tail].slice(1).join(" "),
      family: smartCase(tokens.slice(0, -1).join(" ")),
      suffix,
    };
  }

  let index = tokens.length - 1;
  while (index > 0 && PARTICLES.has(tokens[index - 1].toLowerCase())) index -= 1;

  const [given, middle] = givenMiddle(tokens.slice(0, index));
  return { given, middle, family: smartCase(tokens.slice(index).join(" ")), suffix };
}

function splitCommaList(text: string): string[] {
  const segments = text.split(",").map((s) => s.trim()).filter(Boolean);

  if (segments.every((s) => s.split(/\s+/).length >= 2)) return segments;

  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 2) out.push(segments.slice(i, i + 2).join(", "));
  return out;
}

function expandChunk(chunk: string): string[] {
  const text = chunk.trim().replace(/^[ ,]+|[ ,]+$/g, "");
  const commas = (text.match(/,/g) ?? []).length;

  if (commas >= 2) return splitCommaList(text);

  if (commas === 1) {
    const [left, right] = text.split(",").map((side) => side.trim());
    if (
      left.split(/\s+/).length >= 2 &&
      right.split(/\s+/).length >= 2 &&
      !PARTICLES.has(left.split(/\s+/)[0].toLowerCase()) &&
      !SUFFIXES.has(right.toLowerCase())
    ) {
      return [left, right];
    }
  }

  return [text];
}

/** Raw author parts of a free-form author string. */
export function splitAuthors(author: string | null | undefined): string[] {
  const text = (author ?? "").replace(/\s+/g, " ").trim().replace(/^[ ,;]+|[ ,;]+$/g, "");
  if (!text) return [];

  let parts: string[];

  if (text.includes(";")) parts = text.split(";");
  else if (text.includes("|")) parts = text.split("|");
  else if (/\s(?:and|&)\s/.test(text)) {
    parts = text.split(/\s+(?:and|&)\s+/).flatMap(expandChunk);
  } else if ((text.match(/,/g) ?? []).length >= 2) parts = splitCommaList(text);
  else parts = expandChunk(text);

  return parts.map((p) => p.trim().replace(/^[ ,]+|[ ,]+$/g, "")).filter(Boolean);
}

export function parseAuthorList(author: string | null | undefined): AuthorPart[] {
  return splitAuthors(author)
    .map(parseAuthor)
    .filter((name): name is AuthorPart => name !== null);
}

/** The legacy `author` text: "Given Middle Family; ...". */
export function displayString(names: AuthorPart[]): string {
  return names.map(fullName).join("; ");
}

/** A record's authors: stored parts, else the parsed display string. */
export function paperAuthors(paper: {
  author?: string | null;
  authors?: AuthorPart[] | null;
}): AuthorPart[] {
  const stored = (paper.authors ?? []).filter((n) => n.family || n.given);
  return stored.length ? stored : parseAuthorList(paper.author);
}

export function familyNames(names: AuthorPart[]): string[] {
  return names.map((n) => n.family).filter(Boolean);
}

// ---------------------------------------------------------------
// Style renderings
// ---------------------------------------------------------------

function andList(items: string[], conj: string, oxford: boolean): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}${oxford ? "," : ""} ${conj} ${items[items.length - 1]}`;
}

/** APA 7: "Family, G. M., Family, G., & Family, G." (<= 20 listed). */
export function formatApa(names: AuthorPart[]): string {
  const one = (n: AuthorPart) => {
    if (isCorporate(n) || !(n.given || n.middle)) return n.family;
    return `${n.family}, ${initials(n)}${n.suffix ? ` ${n.suffix}` : ""}`;
  };
  const items = names.map(one);

  if (items.length > 20) return `${items.slice(0, 19).join(", ")}, . . . ${items[items.length - 1]}`;
  if (items.length === 2) return `${items[0]}, & ${items[1]}`;
  return andList(items, "&", true);
}

/** MLA 9: first name inverted; "and" for two; three or more -> et al. */
export function formatMla(names: AuthorPart[]): string {
  if (!names.length) return "";
  const first = isCorporate(names[0]) ? names[0].family : invertedName(names[0]);
  if (names.length === 1) return first;
  if (names.length === 2) return `${first}, and ${fullName(names[1])}`;
  return `${first}, et al.`;
}

/** Chicago bibliography: first inverted; more than ten -> first seven et al. */
export function formatChicago(names: AuthorPart[]): string {
  if (!names.length) return "";
  const shown = names.length > 10 ? names.slice(0, 7) : names;
  const items = [
    isCorporate(shown[0]) ? shown[0].family : invertedName(shown[0]),
    ...shown.slice(1).map(fullName),
  ];
  const text = items.length === 2 ? `${items[0]}, and ${items[1]}` : andList(items, "and", true);
  return names.length > 10 ? `${text}, et al.` : text;
}

/** IEEE: "G. M. Family"; more than six authors -> "G. Family et al.". */
export function formatIeee(names: AuthorPart[]): string {
  const one = (n: AuthorPart) => {
    if (isCorporate(n) || !(n.given || n.middle)) return n.family;
    return `${initials(n)} ${n.family}${n.suffix ? `, ${n.suffix}` : ""}`;
  };
  if (!names.length) return "";
  if (names.length > 6) return `${one(names[0])} et al.`;
  const items = names.map(one);
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return andList(items, "and", true);
}

/** BibTeX `author`: "Family, Given Middle and Family, Given". */
export function formatBibtex(names: AuthorPart[]): string {
  return names
    .map((n) => (isCorporate(n) ? `{${n.family}}` : invertedName(n)))
    .join(" and ");
}

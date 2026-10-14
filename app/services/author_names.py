"""
Structured author names: given / middle / family.

A citation style needs more than a display string. APA wants
"Family, G. M.", MLA "Family, Given Middle", IEEE "G. M. Family",
BibTeX "Family, Given Middle". Those cannot be derived reliably from
the free-form ``papers.author`` text once it has been flattened, so the
repository keeps each author as three parts (plus a suffix such as
"Jr."), and the display string becomes something *derived* from them.

This module is pure -- no database, no network. It has:

    parse_author(text)        one name -> AuthorName
    split_authors(text)       a whole author string -> raw name parts
    parse_author_list(text)   a whole author string -> [AuthorName]
    display_string(names)     [AuthorName] -> the legacy ``author`` text
    format_*(names, ...)      the per-style renderings

Parsing is best-effort over names written many ways ("Last, First M.",
"First M. Last", "Last FM", "van der Berg, Jan", corporate authors).
Anything that cannot be split safely is kept whole in ``family`` rather
than guessed at: a wrong given name in a citation is worse than a name
printed in one piece.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

# Corporate / collaboration "authors" are one unsplittable name.
CORPORATE = re.compile(
    r"\b(collaboration|consortium|group|team|committee|organi[sz]ation|"
    r"association|institute|university|society|council|agency|commission)\b",
    re.I,
)

# Lower-case family-name prefixes that belong to the family name.
PARTICLES = {
    "van", "von", "de", "der", "den", "da", "di", "del", "della", "la",
    "le", "du", "dos", "das", "bin", "ibn", "al", "el", "ter", "ten",
    "op", "zu", "zur", "st", "st.",
}

# Strings extraction leaves where no author was found.
PLACEHOLDERS = {
    "et al", "et al.", "unknown", "unknown author", "n/a", "none", "-",
}

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v", "2nd", "3rd"}


@dataclass(frozen=True)
class AuthorName:
    """One author as three parts, plus a generational suffix."""

    given: str = ""
    middle: str = ""
    family: str = ""
    suffix: str = ""

    @property
    def is_corporate(self) -> bool:
        return not self.given and not self.middle and bool(
            CORPORATE.search(self.family)
        )

    def full(self) -> str:
        """"Given Middle Family Suffix", the way the name is read."""

        return _join(self.given, self.middle, self.family, self.suffix)

    def inverted(self) -> str:
        """"Family, Given Middle, Suffix"."""

        first = _join(self.given, self.middle)

        if not first:
            return self.family

        tail = f"{first}, {self.suffix}" if self.suffix else first

        return f"{self.family}, {tail}"

    def initials(self) -> str:
        """"G. M." from given + middle (hyphenated names keep the hyphen)."""

        return " ".join(
            filter(None, (_initials(self.given), _initials(self.middle)))
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "given": self.given,
            "middle": self.middle,
            "family": self.family,
            "suffix": self.suffix,
        }


def _join(*parts: str) -> str:
    return " ".join(part for part in parts if part)


def _initials(text: str) -> str:
    """"John Ronald" -> "J. R."; "Jean-Paul" -> "J.-P."; "J.R." -> "J. R."."""

    out: list[str] = []

    for token in text.split():
        pieces = []

        for piece in re.split(r"[-\u2010\u2011\u2012\u2013]", token):
            letters = re.sub(r"[^\w]", "", piece, flags=re.UNICODE)

            if not letters:
                continue

            # "JR" / "J.R." are bare initials; "Anna" is a name.
            if letters.isupper() and len(letters) <= 3:
                pieces.append(" ".join(f"{c}." for c in letters))
            else:
                pieces.append(f"{letters[0].upper()}.")

        if pieces:
            out.append("-".join(pieces))

    return " ".join(out)


def _smart_case(text: str) -> str:
    """"SMITH" -> "Smith"; leaves mixed-case names alone."""

    if len(text) > 1 and text.isupper():
        return text.title()

    return text


def _split_family_prefix(tokens: list[str]) -> tuple[list[str], list[str]]:
    """(given/middle tokens, family tokens) for "First Middle Last"."""

    index = len(tokens) - 1

    while index > 0 and tokens[index - 1].lower() in PARTICLES:
        index -= 1

    return tokens[:index], tokens[index:]


def _given_middle(tokens: list[str]) -> tuple[str, str]:
    if not tokens:
        return "", ""

    return tokens[0], " ".join(tokens[1:])


def parse_author(text: str | None) -> AuthorName | None:
    """One name string -> AuthorName, or None when it is empty."""

    value = re.sub(r"\s+", " ", text or "").strip(" ,;")

    if not value or value.lower() in PLACEHOLDERS:
        return None

    if CORPORATE.search(value):
        return AuthorName(family=value)

    suffix = ""

    # "Last, First Middle" / "Last, First, Jr." / "Last, Jr., First"
    if "," in value:
        pieces = [p.strip() for p in value.split(",") if p.strip()]
        family = _smart_case(pieces[0])
        rest = pieces[1:]

        kept: list[str] = []

        for piece in rest:
            if piece.lower() in SUFFIXES and not suffix:
                suffix = piece
            else:
                kept.append(piece)

        given, middle = _given_middle(" ".join(kept).split())

        return AuthorName(given, middle, family, suffix)

    tokens = value.split()

    # "Smith JR" is PubMed initials, "Smith Jr" a suffix: all-caps
    # JR/SR are read as initials.
    if (
        len(tokens) > 1
        and tokens[-1].lower() in SUFFIXES
        and tokens[-1] not in {"JR", "SR"}
    ):
        suffix = tokens.pop()

    if len(tokens) == 1:
        return AuthorName(family=_smart_case(tokens[0]), suffix=suffix)

    # PubMed style "Smith JR": surname first, then bare initials.
    if (
        len(tokens) >= 2
        and re.fullmatch(r"[A-Z]{1,3}", tokens[-1])
        and not tokens[0].isupper()
        and tokens[-2].lower() not in PARTICLES
    ):
        letters = tokens[-1]
        family = " ".join(tokens[:-1])

        return AuthorName(
            letters[0], " ".join(letters[1:]), _smart_case(family), suffix
        )

    first, last = _split_family_prefix(tokens)
    given, middle = _given_middle(first)

    return AuthorName(given, middle, _smart_case(" ".join(last)), suffix)


# ------------------------------------------------------------------
# Whole author strings
# ------------------------------------------------------------------


def _split_comma_list(text: str) -> list[str]:
    """'A B, C D, E F' (first-last names) or 'Last, First, Last, First'."""

    segments = [s.strip() for s in text.split(",") if s.strip()]

    if all(len(s.split()) >= 2 for s in segments):
        return segments

    return [
        ", ".join(segments[i : i + 2]) for i in range(0, len(segments), 2)
    ]


def _expand_chunk(chunk: str) -> list[str]:
    """One piece of an author string may itself hold several names:
    "A B, C D" (first-last names) is two authors, while "Last, First M."
    is one inverted name."""

    chunk = chunk.strip(" ,")

    if chunk.count(",") >= 2:
        return _split_comma_list(chunk)

    if chunk.count(",") == 1:
        left, right = (side.strip() for side in chunk.split(","))

        if (
            len(left.split()) >= 2
            and len(right.split()) >= 2
            and left.split()[0].lower() not in PARTICLES
            and right.lower() not in SUFFIXES
        ):
            return [left, right]

    return [chunk]


def split_authors(author: str | None) -> tuple[list[str], str]:
    """Raw author parts plus the joiner that reassembles them."""

    text = re.sub(r"\s+", " ", author or "").strip().strip(",;")

    if not text:
        return [], ""

    if ";" in text:
        parts, joiner = text.split(";"), "; "
    elif "|" in text:
        parts, joiner = text.split("|"), " | "
    elif re.search(r"\s(?:and|&)\s", text):
        parts, joiner = [], " and "

        for chunk in re.split(r"\s+(?:and|&)\s+", text):
            parts.extend(_expand_chunk(chunk))
    elif text.count(",") >= 2:
        parts, joiner = _split_comma_list(text), ", "
    else:
        parts = _expand_chunk(text)
        joiner = ", " if len(parts) > 1 else ""

    return [part.strip(" ,") for part in parts if part.strip(" ,")], joiner


def parse_author_list(author: str | None) -> list[AuthorName]:
    """The legacy free-form author string -> structured names."""

    parts, _ = split_authors(author)

    return [name for name in map(parse_author, parts) if name]


def display_string(names: Sequence[AuthorName]) -> str:
    """The legacy ``papers.author`` text: "Given Middle Family; ..."."""

    return "; ".join(name.full() for name in names)


# ------------------------------------------------------------------
# Style renderings
# ------------------------------------------------------------------


def _and_list(items: list[str], conj: str, oxford: bool) -> str:
    if len(items) <= 1:
        return "".join(items)

    if len(items) == 2:
        return f"{items[0]} {conj} {items[1]}"

    lead = ", ".join(items[:-1])

    return f"{lead}{',' if oxford else ''} {conj} {items[-1]}"


def format_apa(names: Sequence[AuthorName]) -> str:
    """APA 7: "Family, G. M., Family, G., & Family, G." (<= 20 listed)."""

    def one(n: AuthorName) -> str:
        if n.is_corporate or not (n.given or n.middle):
            return n.family

        suffix = f" {n.suffix}" if n.suffix else ""

        return f"{n.family}, {n.initials()}{suffix}"

    items = [one(n) for n in names]

    if len(items) > 20:
        return ", ".join(items[:19]) + ", . . . " + items[-1]

    if len(items) == 2:
        return f"{items[0]}, & {items[1]}"

    return _and_list(items, "&", True)


def format_mla(names: Sequence[AuthorName]) -> str:
    """MLA 9: first name inverted; two authors joined by "and";
    three or more -> "Family, Given, et al."."""

    if not names:
        return ""

    first = names[0].family if names[0].is_corporate else names[0].inverted()

    if len(names) == 1:
        return first

    if len(names) == 2:
        return f"{first}, and {names[1].full()}"

    return f"{first}, et al."


def format_chicago(names: Sequence[AuthorName]) -> str:
    """Chicago bibliography: first inverted, others natural; more than
    ten authors -> the first seven and "et al."."""

    if not names:
        return ""

    shown = list(names[:7]) if len(names) > 10 else list(names)

    items = [
        shown[0].family if shown[0].is_corporate else shown[0].inverted(),
        *[n.full() for n in shown[1:]],
    ]

    if len(items) == 2:
        # The inverted first name already ends in a comma-separated
        # given name, so Chicago keeps the comma before "and".
        text = f"{items[0]}, and {items[1]}"
    else:
        text = _and_list(items, "and", True)

    return f"{text}, et al." if len(names) > 10 else text


def format_ieee(names: Sequence[AuthorName]) -> str:
    """IEEE: "G. M. Family"; more than six authors -> "G. Family et al."."""

    def one(n: AuthorName) -> str:
        if n.is_corporate or not (n.given or n.middle):
            return n.family

        suffix = f", {n.suffix}" if n.suffix else ""

        return f"{n.initials()} {n.family}{suffix}"

    if not names:
        return ""

    if len(names) > 6:
        return f"{one(names[0])} et al."

    items = [one(n) for n in names]

    if len(items) == 2:
        return f"{items[0]} and {items[1]}"

    return _and_list(items, "and", True)


def format_bibtex(names: Sequence[AuthorName]) -> str:
    """BibTeX ``author`` field: "Family, Given Middle and Family, Given"."""

    def one(n: AuthorName) -> str:
        # Braces keep a corporate name from being split into parts.
        return f"{{{n.family}}}" if n.is_corporate else n.inverted()

    return " and ".join(one(n) for n in names)


def family_names(names: Sequence[AuthorName]) -> list[str]:
    """Just the family names, for in-text citations and sorting."""

    return [n.family for n in names if n.family]

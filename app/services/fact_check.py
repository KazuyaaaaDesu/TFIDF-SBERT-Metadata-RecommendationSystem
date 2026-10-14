"""
Fact-check a research-chat answer against the sources it cited.

The chat is told to answer only from retrieved sources and to cite them
with bracket numbers. Nothing used to check that it did. This takes the
finished answer and, claim by claim, asks: do the sources the claim
cites actually say it?

Pipeline
--------
1. ``extract_claims`` splits the answer into checkable claims -- the
   sentences, bullets and table rows that assert something -- and notes
   which source numbers ([1], [2, 3]) each cites. Headings, code, formulas,
   questions and "the evidence is insufficient" hedges are not claims.

2. ``check_claim`` scores every claim against its cited sources' text
   (title + abstract) without any model:

     - wording overlap between the claim and the source's best sentence,
     - optional semantic similarity (sentence embeddings),
     - NUMBERS: every figure in the claim (42%, 0.31, 2019) must appear in
       the source, or a "supported" claim is downgraded,
     - POLARITY: a claim and its best-matching sentence that disagree on
       negation ("does not improve" vs "improves") are flagged.

3. Optionally a language model judges the claims in one batched call.
   Its verdicts are not taken on trust: a quote it offers as evidence must
   exist verbatim in the source, or the quote is replaced with the best
   sentence the checker found itself; and a "supported" verdict with
   almost no wording overlap is downgraded to "partial".

Verdicts
--------
    supported         the cited source(s) say this
    partial           related, but something is not backed (a figure, a
                      polarity, or only part of the claim)
    unsupported       the cited source(s) do not say this
    contradicted      the cited source(s) say the opposite (model-judged)
    uncited           a factual claim with no citation
    invalid_citation  cites a source number that does not exist
    unverifiable      the cited source has no text to check against

Pure functions over strings; the embedding and model calls are injected so
this has no dependency on either and is fully testable offline.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from typing import Literal

from pydantic import BaseModel

Verdict = Literal[
    "supported",
    "partial",
    "unsupported",
    "contradicted",
    "uncited",
    "invalid_citation",
    "unverifiable",
]

SUPPORTED_AT = 0.60
PARTIAL_AT = 0.35
MIN_CLAIM_WORDS = 5
MAX_CLAIMS = 40
EXCERPT_CHARS = 1200

EmbedFn = Callable[[list[str]], list[list[float]]]
LlmFn = Callable[[str], str]


# ------------------------------------------------------------
# Result models
# ------------------------------------------------------------


class Evidence(BaseModel):
    source: int
    quote: str
    verified: bool = True
    """False when a model-supplied quote could not be found in the source
    and was replaced by the checker's own best sentence."""


class ClaimCheck(BaseModel):
    id: int
    text: str
    cites: list[int]
    verdict: Verdict
    confidence: float
    evidence: Evidence | None = None
    notes: list[str] = []


class FactCheckSummary(BaseModel):
    total: int
    supported: int = 0
    partial: int = 0
    unsupported: int = 0
    contradicted: int = 0
    uncited: int = 0
    invalid_citation: int = 0
    unverifiable: int = 0
    # Share of verifiable (cited, with source text) claims that hold up;
    # a partial claim counts half. None when nothing could be verified.
    support_rate: float | None = None


class FactCheckReport(BaseModel):
    method: Literal["lexical", "semantic", "model"]
    claims: list[ClaimCheck]
    summary: FactCheckSummary


# ------------------------------------------------------------
# Claim extraction
# ------------------------------------------------------------

_ABBREVIATIONS = (
    "et al.", "e.g.", "i.e.", "etc.", "vs.", "fig.", "figs.", "eq.", "eqs.",
    "no.", "cf.", "approx.", "dr.", "prof.", "mr.", "ms.", "inc.", "ca.",
)
_MARK = re.compile(r"\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]")
_MARKS = re.compile(r"(?:\s*\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\])+")
_FENCE = re.compile(r"^\s*(```|~~~)")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?")
_REFERENCE_HEADS = {"references", "works cited", "bibliography", "reference list"}
_ADJ = r"(?:(?:available|retrieved|supplied|provided|given|cited|above|current|relevant|these|the|any|our)\s+)*"
_NOUN = r"(?:evidence|sources?|papers?|abstracts?|documents?|results?|excerpts?|passages?)"
_ABSENCE = (
    r"(?:insufficient|not enough|limited|lack(?:s|ing)?|does\s+not|do\s+not|did\s+not|"
    r"cannot|can't|could\s+not|couldn't|no\s+(?:information|evidence|mention|data|sources?)|"
    r"nothing|not\s+(?:contain|cover|mention|address|discuss|provide|include|support|enough|sufficient))"
)
# Honest hedges about the evidence itself assert nothing checkable.
_NON_CLAIM = re.compile(
    r"^(?:"
    rf"(?:based on|according to|from|given)\s+{_ADJ}{_NOUN}\b.*\b{_ABSENCE}"
    rf"|{_ADJ}{_NOUN}\b.*\b{_ABSENCE}"
    rf"|(?:none|neither|no)\s+of\s+{_ADJ}{_NOUN}\b.*"
    rf"|no\s+(?:relevant\s+)?{_NOUN}\b.*(?:found|available|retrieved|provided|given)"
    r"|i\s+(?:could not|cannot|can't|couldn't|am unable|was unable)\b.*"
    r"|(?:there is|there are)\s+(?:no|insufficient|not enough)\s+\w+.*"
    r"|(?:in summary|overall|to summari[sz]e|in short|in conclusion)\s*[:,]?\s*$"
    r"|here\s+(?:is|are)\b.*:\s*$"
    r")",
    re.I,
)


def _strip_inline(text: str) -> str:
    """Markdown and math out, plain words in."""

    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"\$\$.*?\$\$", " ", text, flags=re.S)
    text = re.sub(r"(?<![\\$\d])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)", " ", text)
    text = re.sub(r"\\\(.*?\\\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\((?:https?|mailto):[^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[*_~]{1,3}", "", text)
    text = re.sub(r"^\s*>+\s?", "", text)

    return re.sub(r"\s+", " ", text).strip()


def _cites(text: str) -> list[int]:
    numbers: list[int] = []

    for match in _MARK.finditer(text):
        for piece in re.split(r"\s*,\s*", match.group(0)[1:-1].strip()):
            bounds = re.split(r"\s*[–-]\s*", piece)

            if len(bounds) == 2 and 0 <= int(bounds[1]) - int(bounds[0]) < 50:
                numbers.extend(range(int(bounds[0]), int(bounds[1]) + 1))
            else:
                numbers.extend(int(b) for b in bounds)

    return list(dict.fromkeys(numbers))


def _split_sentences(text: str) -> list[str]:
    # A marker written after the full stop belongs to the sentence before.
    text = re.sub(r"([.!?])((?:\s*\[\s*\d[\d,\s–-]*\])+)", r"\2\1", text)

    protected = text

    for abbreviation in _ABBREVIATIONS:
        protected = re.sub(
            re.escape(abbreviation),
            abbreviation.replace(".", "\u2024"),
            protected,
            flags=re.I,
        )

    # Decimals and initials ("0.42", "J. Smith") are not sentence ends.
    protected = re.sub(r"(?<=\d)\.(?=\d)", "\u2024", protected)
    protected = re.sub(r"\b([A-Z])\.(?=\s[A-Z])", "\\1\u2024", protected)

    parts = re.split(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])", protected)

    return [part.replace("\u2024", ".").strip() for part in parts if part.strip()]


class _Claim(BaseModel):
    id: int
    text: str
    cites: list[int]


def extract_claims(answer: str) -> list[_Claim]:
    """The checkable assertions in ``answer``, in order."""

    claims: list[_Claim] = []
    in_code = False
    in_math = False
    in_refs = False
    table_header_seen = False
    lines = answer.replace("\r\n", "\n").split("\n")

    for index, raw in enumerate(lines):
        line = raw.rstrip()

        if _FENCE.match(line):
            in_code = not in_code
            continue

        if in_code:
            continue

        stripped = line.strip()

        if stripped.startswith("$$") or stripped.startswith("\\["):
            # one-line display math is skipped; a multi-line block toggles
            closed_here = stripped.count("$$") >= 2 or "\\]" in stripped
            if not closed_here:
                in_math = not in_math
            continue

        if in_math:
            if "$$" in stripped or "\\]" in stripped:
                in_math = False
            continue

        if stripped == "":
            table_header_seen = False
            continue

        if stripped.lower().rstrip(":") in _REFERENCE_HEADS:
            in_refs = True
            continue

        if in_refs:
            continue  # the appended reference list is not prose

        if re.match(r"^\s{0,3}#{1,6}\s", line) or re.match(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$", line):
            continue

        # A line that is nothing but bold text is a heading in disguise.
        if re.fullmatch(r"\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*", line):
            continue

        if _TABLE_SEP.match(line) and "|" in line:
            continue

        if "|" in line and index + 1 < len(lines) and _TABLE_SEP.match(lines[index + 1]) and "|" in lines[index + 1]:
            table_header_seen = True  # the header row labels columns; not a claim
            continue

        if "|" in line and table_header_seen:
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            text = "; ".join(c for c in cells if c)
            units = [text]
        else:
            body = _LIST_MARKER.sub("", line)
            units = _split_sentences(body)

        for unit in units:
            cites = _cites(unit)
            plain = _strip_inline(_MARKS.sub("", unit))

            # A question or a lead-in ("Here are the points:") asserts nothing.
            if plain.rstrip().endswith(("?", ":")):
                continue

            clean = plain.strip(" -–—:;")

            if len(clean.split()) < MIN_CLAIM_WORDS or _NON_CLAIM.match(clean):
                continue

            claims.append(_Claim(id=len(claims) + 1, text=clean, cites=cites))

            if len(claims) >= MAX_CLAIMS:
                return claims

    return claims


# ------------------------------------------------------------
# Deterministic checking
# ------------------------------------------------------------

_STOP = frozenset(
    """a an the and or but if then than that this these those of in on at to
    for from by with without within into onto over under between among about
    as is are was were be been being has have had do does did can could may
    might will would should must it its their there which who whom whose what
    when where how why not no nor also such both each other more most some
    any all one two several many much very than however thus therefore while
    whereas using used use based paper papers study studies source sources
    authors author report reports reported show shows showed shown find finds
    found result results""".split()
)
_NEGATION = frozenset(
    "not no never none neither nor without cannot fail fails failed unable "
    "lack lacks lacked lacking absence absent unlikely".split()
)
_NUMBER = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?%)?")
_SUFFIXES = ("ations", "ation", "ingly", "ments", "ment", "ings", "ing", "edly", "ies", "ied", "ed", "es", "ly", "s")


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]

    return word


def _tokens(text: str) -> set[str]:
    return {
        _stem(w)
        for w in re.findall(r"[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?", text.lower())
        if w not in _STOP
    }


def _numbers(text: str) -> list[str]:
    found = []

    for match in _NUMBER.finditer(text):
        number = match.group(1).replace(",", "")
        found.append(number + ("%" if match.group(2) else ""))

    return found


def _number_in(number: str, source: str) -> bool:
    plain = number.rstrip("%")
    haystack = source.replace(",", "")

    return re.search(rf"(?<![\d.]){re.escape(plain)}(?![\d]|\.\d)", haystack) is not None


def _has_negation(text: str) -> bool:
    words = set(re.findall(r"[a-z']+", text.lower()))

    return bool(words & _NEGATION) or any(w.endswith("n't") for w in words)


def _source_text(source) -> str:
    title = (getattr(source, "title", "") or "").strip()
    abstract = (getattr(source, "abstract", "") or "").strip()

    return f"{title}. {abstract}".strip(". ") if abstract else title


def _sentences_of(text: str) -> list[str]:
    return [s for s in _split_sentences(text) if len(s.split()) >= 3]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5

    return dot / (na * nb) if na and nb else 0.0


class _Best(BaseModel):
    source: int
    sentence: str
    score: float
    coverage: float
    semantic: float | None = None


def _best_support(
    claim: str,
    numbers_of: dict[int, str],
    embed: EmbedFn | None,
) -> _Best | None:
    """The source sentence that best backs ``claim`` among ``numbers_of``
    (source number -> source text)."""

    claim_tokens = _tokens(claim)

    if not claim_tokens:
        return None

    candidates: list[tuple[int, str, float]] = []

    for number, text in numbers_of.items():
        whole = _tokens(text)
        spread = len(claim_tokens & whole) / len(claim_tokens)

        for sentence in _sentences_of(text) or [text]:
            overlap = len(claim_tokens & _tokens(sentence)) / len(claim_tokens)
            # Synthesis spans sentences: blend in the whole-source coverage.
            candidates.append((number, sentence, max(overlap, 0.8 * spread)))

    if not candidates:
        return None

    semantic: dict[int, float] = {}

    if embed is not None:
        try:
            top = sorted(range(len(candidates)), key=lambda i: -candidates[i][2])[:12]
            vectors = embed([claim] + [candidates[i][1] for i in top])
            for rank, i in enumerate(top):
                semantic[i] = _cosine(vectors[0], vectors[rank + 1])
        except Exception:
            semantic = {}

    best: _Best | None = None

    for i, (number, sentence, coverage) in enumerate(candidates):
        sem = semantic.get(i)
        score = (
            0.5 * coverage + 0.5 * min(1.0, max(0.0, (sem - 0.25) / 0.5))
            if sem is not None
            else coverage
        )

        if best is None or score > best.score:
            best = _Best(
                source=number, sentence=sentence, score=score,
                coverage=coverage, semantic=sem,
            )

    return best


def _verdict_for(score: float) -> Verdict:
    if score >= SUPPORTED_AT:
        return "supported"

    if score >= PARTIAL_AT:
        return "partial"

    return "unsupported"


def check_claim(claim: _Claim, sources: Sequence, embed: EmbedFn | None) -> ClaimCheck:
    notes: list[str] = []
    count = len(sources)

    bad = [n for n in claim.cites if not 1 <= n <= count]
    valid = [n for n in claim.cites if 1 <= n <= count]

    if bad and not valid:
        return ClaimCheck(
            id=claim.id, text=claim.text, cites=claim.cites,
            verdict="invalid_citation", confidence=1.0,
            notes=[f"Cites source {', '.join(map(str, bad))}, but only {count} source{'s' if count != 1 else ''} were retrieved."],
        )

    if bad:
        notes.append(f"Also cites non-existent source {', '.join(map(str, bad))}.")

    if not valid:
        # No citation: is it at least backed by something we retrieved?
        pool = {i + 1: _source_text(s) for i, s in enumerate(sources)}
        best = _best_support(claim.text, pool, embed)
        notes_u = ["No source is cited for this claim."]

        if best and best.score >= SUPPORTED_AT:
            notes_u.append(f"Source {best.source} appears to support it; cite it.")
        elif best and best.score >= PARTIAL_AT:
            notes_u.append(f"Source {best.source} is related but does not clearly state it.")
        else:
            notes_u.append("No retrieved source clearly states it.")

        return ClaimCheck(
            id=claim.id, text=claim.text, cites=[], verdict="uncited",
            confidence=round(best.score, 2) if best else 0.0,
            evidence=Evidence(source=best.source, quote=best.sentence) if best and best.score >= PARTIAL_AT else None,
            notes=notes_u,
        )

    pool = {n: _source_text(sources[n - 1]) for n in valid}
    readable = {n: t for n, t in pool.items() if len(t.split()) >= 12}

    if not readable:
        return ClaimCheck(
            id=claim.id, text=claim.text, cites=claim.cites,
            verdict="unverifiable", confidence=0.0,
            notes=notes + ["The cited source has no abstract text to check against."],
        )

    best = _best_support(claim.text, readable, embed)
    score = best.score if best else 0.0
    verdict = _verdict_for(score)
    quote = best.sentence if best else None

    # Every figure in the claim has to be in the cited sources.
    joined = " ".join(readable.values())
    missing = [n for n in dict.fromkeys(_numbers(claim.text)) if not _number_in(n, joined)]

    if missing:
        notes.append(
            "Not found in the cited source: " + ", ".join(missing) + "."
        )
        if verdict == "supported":
            verdict = "partial"
        elif verdict == "partial" and len(missing) == len(set(_numbers(claim.text))):
            verdict = "unsupported"

    # Polarity: "does not improve" against "improves" is not support.
    if best and verdict in ("supported", "partial") and _has_negation(claim.text) != _has_negation(best.sentence):
        notes.append("The claim and the closest source sentence differ in polarity (negation); check it reads the same way.")
        if verdict == "supported":
            verdict = "partial"

    if len(valid) < len(readable) or len(readable) < len(valid):
        skipped = [n for n in valid if n not in readable]
        if skipped:
            notes.append(f"Source {', '.join(map(str, skipped))} has no abstract text to check.")

    return ClaimCheck(
        id=claim.id, text=claim.text, cites=claim.cites, verdict=verdict,
        confidence=round(min(1.0, score), 2),
        evidence=Evidence(source=best.source, quote=quote) if best and quote else None,
        notes=notes,
    )


# ------------------------------------------------------------
# Model verification (optional, batched)
# ------------------------------------------------------------

LLM_SYSTEM = (
    "You are a strict fact-checker for an academic research assistant. "
    "You judge whether sources support claims. Reply with JSON only."
)


def _llm_prompt(claims: Sequence[ClaimCheck], sources: Sequence) -> str:
    cited = sorted({n for c in claims for n in c.cites if 1 <= n <= len(sources)})
    blocks = [
        f"[{n}] {(_source_text(sources[n - 1]))[:EXCERPT_CHARS]}" for n in cited
    ]
    lines = [f'{c.id}. (cites {c.cites}) {c.text}' for c in claims]

    return f"""For each numbered claim, decide whether the SOURCES it cites support it.

Verdicts:
- "supported": the cited sources state this, including figures and direction.
- "partial": related, but a figure, a qualifier or part of the claim is not backed.
- "unsupported": the cited sources do not say this.
- "contradicted": the cited sources say the opposite.

Judge only from the source text below. Do not use outside knowledge.

Reply with a JSON array and nothing else, one object per claim:
[{{"id": 1, "verdict": "supported", "reason": "under 20 words", "quote": "exact words copied from a source, or empty"}}]

SOURCES:
{chr(10).join(blocks)}

CLAIMS:
{chr(10).join(lines)}
"""


def _parse_llm(reply: str) -> dict[int, dict]:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", reply.strip(), flags=re.I)
    start, end = text.find("["), text.rfind("]")

    if start == -1 or end <= start:
        return {}

    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return {}

    parsed: dict[int, dict] = {}

    for item in data if isinstance(data, list) else []:
        if (
            isinstance(item, dict)
            and isinstance(item.get("id"), int)
            and item.get("verdict") in ("supported", "partial", "unsupported", "contradicted")
        ):
            parsed[item["id"]] = item

    return parsed


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w%.]+", " ", text.lower())).strip()


def _find_quote(quote: str, sources: Sequence, cites: Sequence[int]) -> int | None:
    """The cited source number that really contains ``quote``, else None."""

    needle = _norm(quote)

    if len(needle) < 12:
        return None

    for n in cites:
        if 1 <= n <= len(sources) and needle in _norm(_source_text(sources[n - 1])):
            return n

    return None


def _apply_llm(checks: list[ClaimCheck], judged: dict[int, dict], sources: Sequence) -> None:
    for check in checks:
        item = judged.get(check.id)

        if item is None or check.verdict in ("invalid_citation", "unverifiable", "uncited"):
            continue

        verdict = item["verdict"]
        reason = str(item.get("reason") or "").strip()[:200]
        lexical = check.confidence

        # Do not trust "supported" that the text barely resembles.
        if verdict == "supported" and lexical < 0.2:
            verdict = "partial"
            check.notes.append(
                "The verifier judged this supported, but the wording barely overlaps the source; check it manually."
            )

        agrees = (
            (verdict == "supported" and check.verdict == "supported")
            or (verdict in ("unsupported", "contradicted") and check.verdict == "unsupported")
        )

        check.verdict = verdict
        check.confidence = round(max(lexical, 0.8) if agrees else min(max(lexical, 0.5), 0.7), 2)

        if reason:
            check.notes.insert(0, reason)

        quote = str(item.get("quote") or "").strip()

        if quote:
            owner = _find_quote(quote, sources, check.cites)

            if owner is not None:
                check.evidence = Evidence(source=owner, quote=quote, verified=True)
            elif check.evidence is not None:
                check.evidence.verified = True  # the checker's own sentence stays
                check.notes.append("The verifier's quote was not found in the source and was ignored.")


# ------------------------------------------------------------
# Entry point
# ------------------------------------------------------------


def _summarise(checks: Sequence[ClaimCheck]) -> FactCheckSummary:
    summary = FactCheckSummary(total=len(checks))

    for check in checks:
        setattr(summary, check.verdict, getattr(summary, check.verdict) + 1)

    verifiable = summary.supported + summary.partial + summary.unsupported + summary.contradicted

    if verifiable:
        summary.support_rate = round(
            (summary.supported + 0.5 * summary.partial) / verifiable, 3
        )

    return summary


def fact_check_answer(
    answer: str,
    sources: Sequence,
    *,
    embed: EmbedFn | None = None,
    llm: LlmFn | None = None,
) -> FactCheckReport | None:
    """
    Check ``answer`` (with its [n] markers, before any citation styling)
    against ``sources`` (objects with ``title`` and ``abstract``, numbered
    from 1 in order). Returns None when the answer holds no checkable
    claim, so callers show nothing rather than an empty report.
    """

    claims = extract_claims(answer)

    if not claims:
        return None

    checks = [check_claim(claim, sources, embed) for claim in claims]
    method: Literal["lexical", "semantic", "model"] = (
        "semantic" if embed is not None else "lexical"
    )

    if llm is not None:
        checkable = [c for c in checks if c.verdict not in ("invalid_citation", "unverifiable", "uncited")]

        if checkable:
            try:
                judged = _parse_llm(llm(_llm_prompt(checkable, sources)))
            except Exception:
                judged = {}

            if judged:
                _apply_llm(checks, judged, sources)
                method = "model"

    return FactCheckReport(method=method, claims=checks, summary=_summarise(checks))

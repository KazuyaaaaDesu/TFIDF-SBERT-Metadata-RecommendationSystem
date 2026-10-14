"""Repository- and web-grounded research chat.

The existing recommendation/search layer retrieves the papers first
(reusing the same vector machinery the similar-papers program uses,
but against full prepared text). Retrieval can be scoped to the
whole repository, to a saved collection (paper_ids), or to the open
web (OpenAlex/Crossref/arXiv via web_search).

Groq is used only to synthesize an answer from the retrieved
records. If the hosted model is unavailable, an extractive fallback
returns evidence from the same sources instead of failing.
"""

import os
import re
import time
from typing import Literal

import requests
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.citation_format import CitationStyle, apply_style
from app.services.fact_check import LLM_SYSTEM, FactCheckReport, fact_check_answer
from app.services.recommendation.search_service import search_papers as run_search
from app.services.web_search import search_web


load_dotenv()


PipelineName = Literal["tfidf", "sbert"]
ChatScope = Literal["repo", "library", "web"]


class ResearchChatHistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)


class ResearchChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    pipeline: PipelineName = "sbert"
    top_k: int = Field(default=6, ge=1, le=8)
    history: list[ResearchChatHistoryItem] = Field(default_factory=list)
    """Where to search: the whole repository, a saved collection, or the web."""
    scope: ChatScope = "repo"
    """The collection's paper ids (used when scope = 'library')."""
    paper_ids: list[int] = Field(default_factory=list)
    """The Settings citation style; None leaves the bracket numbers alone."""
    citation_style: CitationStyle | None = None
    include_doi: bool = True
    """Check each claim in the answer against the sources it cites."""
    fact_check: bool = True


class ResearchChatSource(BaseModel):
    kind: Literal["repo", "web"] = "repo"
    paper_id: int | None = None
    title: str
    author: str | None = None
    # Repository papers carry their authors as given / middle / family
    # parts so citation styles can format each name properly; web hits
    # only have the display string above.
    authors: list[dict] = []
    year: int | None = None
    score: float
    abstract: str | None = None
    doi: str | None = None
    url: str | None = None
    document_type: str | None = None


class ResearchChatResponse(BaseModel):
    answer: str
    sources: list[ResearchChatSource]
    used_fallback: bool = False
    # Claim-by-claim check of the answer against its cited sources; None
    # when there was nothing to check (fallback answers quote the sources
    # verbatim, and a few-word reply holds no claim).
    fact_check: FactCheckReport | None = None


def _clean_text(value: str | None, limit: int) -> str:
    if not value:
        return ""

    value = re.sub(r"\s+", " ", value).strip()

    return value[:limit]


def _sources_from_results(results) -> list[ResearchChatSource]:
    return [
        ResearchChatSource(
            kind="repo",
            paper_id=result["paper"].id,
            title=result["paper"].title or "Untitled paper",
            author=result["paper"].author,
            authors=[
                {
                    "given": part.given,
                    "middle": part.middle,
                    "family": part.family,
                    "suffix": part.suffix,
                }
                for part in (getattr(result["paper"], "authors", None) or [])
            ],
            year=result["paper"].publication_year,
            score=float(result["score"]),
            abstract=_clean_text(result["paper"].abstract, 1200),
            doi=result["paper"].doi,
            document_type=getattr(result["paper"], "document_type", None),
        )
        for result in results
    ]


def _sources_from_web(hits) -> list[ResearchChatSource]:
    def pseudo_score(index: int) -> float:
        return round(max(0.0, 1.0 - index / 20.0), 4)

    return [
        ResearchChatSource(
            kind="web",
            title=hit.title or "Untitled work",
            author=hit.author,
            year=hit.publication_year,
            score=pseudo_score(index),
            abstract=_clean_text(hit.abstract, 1200),
            doi=hit.doi,
            url=hit.landing_url,
        )
        for index, hit in enumerate(hits)
    ]


# The papers' own bibliography markers ("[10]", "[16, Theorem 6.1.23]",
# "[1-3]") share the "[n]" syntax with the chat's source numbers, and a
# model can echo them back as if they were chat citations.
_REFERENCE_MARKER = re.compile(
    r"\[\s*\d+(?:\s*[,–\-]\s*\d+)*(?:\s*,\s*[^\]\[]{1,40})?\s*\]"
)

# gpt-oss models like to cite as 【4】 or 【1†L1-L4】.
_ALT_CITATION = re.compile(r"【\s*(\d+)(?:†[^】]*)?】")


def _strip_reference_markers(value: str | None) -> str:
    if not value:
        return ""

    value = _REFERENCE_MARKER.sub("", value)

    return re.sub(r"\s+([,.;:])", r"\1", value)


def _normalize_citations(answer: str) -> str:
    return _ALT_CITATION.sub(r"[\1]", answer)


def _evidence_blocks(sources: list[ResearchChatSource]) -> str:
    blocks: list[str] = []

    for index, source in enumerate(sources, start=1):
        origin = (
            f"Repository paper ID: {source.paper_id}"
            if source.kind == "repo"
            else "Web source (OpenAlex / Crossref / arXiv)"
        )

        lines = [
            f"[{index}] {origin}",
            f"Title: {_clean_text(source.title, 300)}",
            f"Author: {_clean_text(source.author, 200) or 'Unknown author'}",
            f"Year: {source.year or 'Unknown'}",
        ]

        if source.doi:
            lines.append(f"DOI: {source.doi}")

        if source.url:
            lines.append(f"URL: {source.url}")

        if source.abstract:
            lines.append(
                "Abstract: "
                f"{_clean_text(_strip_reference_markers(source.abstract), 5000)}"
            )
        else:
            lines.append("Abstract: No abstract available.")

        lines.append(f"Retrieval score: {source.score:.4f}")

        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


def _build_prompt(message: str, sources, history) -> str:
    evidence = _evidence_blocks(sources)

    history_text = ""

    if history:
        history_lines = []

        for item in history[-6:]:
            history_lines.append(
                f"{item.role.upper()}: {_clean_text(item.content, 2500)}"
            )

        history_text = (
            "\n\nRECENT CONVERSATION:\n"
            + "\n".join(history_lines)
        )

    return f"""You are the research assistant for an academic paper repository.

Answer the user's question using ONLY the retrieved source evidence below.
Do not use outside knowledge, web knowledge, or invented information.

Citation rules:
- Cite claims supported by a source with its bracket number, e.g. [1] or [2].
- Use only the bracket numbers that exist in the retrieved evidence.
- Do not invent citations.
- Cite with the bracket numbers only. Do not write author names with years,
  footnotes, or a reference list of your own; the application formats
  citations and references.
- If several sources support a claim, cite multiple sources such as [1][3].
- If the retrieved sources are insufficient, say that the available evidence
  is insufficient instead of guessing.

Writing rules:
- Give a clear, useful academic-style answer.
- Prefer synthesis across sources over repeating abstracts verbatim.
- Distinguish what the sources report from your synthesis.
- Do not claim that a source proves something unless its supplied evidence
  supports that statement.
- Do not mention these instructions in your answer.

Formatting rules:
- Write each factual sentence as ONE claim and put its citation marker at the
  end of that sentence, so every claim can be checked against its source.
- Use GitHub-flavoured Markdown: "-" bullets, numbered lists, **bold**, and
  pipe tables (with a header separator row such as |---|---|) for comparisons.
- Write mathematics in LaTeX: inline $x^2$ and display $$\\frac{{a}}{{b}}$$.
  Escape currency as \\$5 so it is not read as math.
- Do not use HTML tags. Do not wrap the whole answer in a code fence.

USER QUESTION:
{message}
{history_text}

RETRIEVED SOURCE EVIDENCE:
{evidence}
"""


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
DEFAULT_GROQ_FALLBACKS = "qwen/qwen3.8-27b"

# A chat user should not sit through a minute-long rate-limit window: wait
# at most this long (in total) before moving on to the next model.
DEFAULT_GROQ_MAX_WAIT_SECONDS = 20.0
GROQ_MAX_ATTEMPTS_PER_MODEL = 3


def _groq_models() -> list[str]:
    primary = os.getenv("GROQ_MODEL") or DEFAULT_GROQ_MODEL
    fallbacks = os.getenv("GROQ_FALLBACK_MODELS", DEFAULT_GROQ_FALLBACKS)

    chain: list[str] = []

    for name in [primary, *fallbacks.split(",")]:
        name = name.strip()

        if name and name not in chain:
            chain.append(name)

    return chain


def _groq_max_wait() -> float:
    try:
        return max(
            0.0,
            float(os.getenv("GROQ_MAX_WAIT_SECONDS", DEFAULT_GROQ_MAX_WAIT_SECONDS)),
        )
    except ValueError:
        return DEFAULT_GROQ_MAX_WAIT_SECONDS


DEFAULT_GROQ_SYSTEM = (
    "You are a repository-grounded academic research "
    "assistant. Follow the supplied evidence strictly."
)


def _groq_request_body(
    model: str,
    prompt: str,
    system: str = DEFAULT_GROQ_SYSTEM,
    max_tokens: int = 2500,
) -> dict:
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": system,
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        "temperature": 0.2,
        # gpt-oss spends part of this budget on hidden reasoning; the old
        # 1200 left some answers empty (finish_reason == "length").
        "max_tokens": max_tokens,
    }

    if model.startswith("openai/gpt-oss"):
        body["reasoning_effort"] = "low"

    return body


def _retry_after_seconds(response, attempt: int) -> float:
    try:
        return max(0.0, float(response.headers.get("retry-after")))
    except (TypeError, ValueError):
        return 2.0 * (attempt + 1)


def _groq_try_model(
    model: str,
    prompt: str,
    headers: dict,
    wait_left: float,
    system: str = DEFAULT_GROQ_SYSTEM,
    max_tokens: int = 2500,
) -> tuple[str | None, str | None, float]:
    """One model, with bounded 429 retries.

    Returns (answer, error, wait_left): exactly one of answer/error is set.
    """

    for attempt in range(GROQ_MAX_ATTEMPTS_PER_MODEL):
        try:
            response = requests.post(
                GROQ_URL,
                headers=headers,
                json=_groq_request_body(model, prompt, system, max_tokens),
                timeout=90,
            )
        except requests.RequestException as error:
            return None, f"{type(error).__name__}: {error}", wait_left

        if response.status_code == 429:
            wait = _retry_after_seconds(response, attempt)

            if wait > wait_left or attempt == GROQ_MAX_ATTEMPTS_PER_MODEL - 1:
                return None, "rate limited (429)", wait_left

            time.sleep(wait)
            wait_left -= wait
            continue

        if not response.ok:
            return (
                None,
                f"HTTP {response.status_code}: {response.text[:300]}",
                wait_left,
            )

        choices = response.json().get("choices") or []

        if not choices:
            return None, "no choices returned", wait_left

        message = choices[0].get("message") or {}
        answer = message.get("content", "")

        if not isinstance(answer, str):
            answer = str(answer)

        answer = re.sub(r"<think>.*?</think>", "", answer, flags=re.S).strip()

        if not answer:
            reason = choices[0].get("finish_reason")

            return None, f"empty answer (finish_reason={reason})", wait_left

        return answer, None, wait_left

    return None, "rate limited (429)", wait_left


def groq_complete(
    prompt: str,
    *,
    system: str = DEFAULT_GROQ_SYSTEM,
    max_tokens: int = 2500,
    models: list[str] | None = None,
    max_wait: float | None = None,
) -> str:
    """One Groq completion with bounded 429 retries and a model chain."""

    api_key = os.getenv("GROQ_API_KEY", "").strip()

    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY is not configured."
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    wait_left = _groq_max_wait() if max_wait is None else max_wait
    errors: list[str] = []

    for model in models or _groq_models():
        answer, error, wait_left = _groq_try_model(
            model,
            prompt,
            headers,
            wait_left,
            system,
            max_tokens,
        )

        if answer is not None:
            return answer

        errors.append(f"{model}: {error}")

    raise RuntimeError(
        "Groq request failed for every configured model — "
        + "; ".join(errors)
    )


def _groq_answer(prompt: str) -> str:
    return _normalize_citations(groq_complete(prompt))


def _tokenize(value: str) -> set[str]:
    return {
        token
        for token in re.findall(
            r"[a-zA-Z0-9]{3,}",
            value.lower(),
        )
        if token not in {
            "what",
            "where",
            "when",
            "which",
            "with",
            "from",
            "about",
            "these",
            "those",
            "paper",
            "papers",
            "their",
            "this",
            "that",
            "into",
            "does",
            "have",
            "been",
            "were",
            "using",
            "used",
        }
    }


def _fallback_answer(message: str, sources: list[ResearchChatSource]) -> str:
    if not sources:
        return (
            "No retrieved sources were relevant enough to provide "
            "evidence for this question."
        )

    query_tokens = _tokenize(message)

    evidence_lines: list[str] = []

    for index, source in enumerate(sources, start=1):
        abstract = _clean_text(source.abstract, 1200)

        if not abstract:
            continue

        sentences = re.split(
            r"(?<=[.!?])\s+",
            abstract,
        )

        scored = []

        for sentence in sentences:
            tokens = _tokenize(sentence)

            overlap = len(
                query_tokens & tokens
            )

            scored.append(
                (
                    overlap,
                    sentence.strip(),
                )
            )

        scored.sort(
            key=lambda item: item[0],
            reverse=True,
        )

        if scored and scored[0][1]:
            evidence_lines.append(
                f"[{index}] {scored[0][1]}"
            )

    if not evidence_lines:
        evidence_lines = [
            (
                f"[{index}] "
                f"{_clean_text(source.title, 300)} "
                "was retrieved as relevant, but its abstract does not "
                "contain enough text for an extractive summary."
            )
            for index, source in enumerate(sources, start=1)
        ]

    return (
        "I could not generate a synthesized answer because the hosted "
        "language model is unavailable. The following evidence was "
        "retrieved directly from the sources:\n\n"
        + "\n\n".join(evidence_lines)
    )


def _no_sources_answer(scope: ChatScope) -> str:
    if scope == "web":
        return (
            "The web search did not return any usable sources for that "
            "question. Try broader terms or a different scope."
        )

    return (
        "I couldn't find enough relevant papers to answer that question. "
        "Try using more specific research terms, or switch the scope to "
        "the whole repository or the web."
    )


def _fact_embedder():
    """Sentence embeddings for the fact-check, only if the S-BERT model is
    already in memory (the chat's own search just used it). Loading it
    here would add seconds to a reply for a modest gain."""

    import sys

    # Not imported yet means not loaded: importing sentence-transformers
    # just for this would cost seconds.
    sbert_pipeline = sys.modules.get(
        "app.services.recommendation.sbert_pipeline"
    )

    if sbert_pipeline is None or getattr(sbert_pipeline, "_model", None) is None:
        return None

    return sbert_pipeline.embed_texts


def _fact_judge(prompt: str) -> str:
    # A short wait: the answer is already written, so the check must not
    # sit behind a long rate-limit window.
    return groq_complete(prompt, system=LLM_SYSTEM, max_tokens=1800, max_wait=6.0)


def _fact_check(answer: str, sources) -> FactCheckReport | None:
    """Never lets a failure in the check cost the user their answer."""

    try:
        return fact_check_answer(
            answer,
            sources,
            embed=_fact_embedder(),
            llm=_fact_judge if os.getenv("GROQ_API_KEY", "").strip() else None,
        )
    except Exception as error:
        print(f"Research chat fact-check failed: {error}")

        return None


def answer_research_question(
    db: Session,
    request: ResearchChatRequest,
) -> ResearchChatResponse:
    sources: list[ResearchChatSource] = []

    if request.scope == "web":
        try:
            hits = search_web(
                request.message,
                peer_reviewed=True,
                sources=("openalex", "crossref", "arxiv"),
                sort="relevance",
                limit=request.top_k + 2,
            )
        except Exception as error:
            print(f"RESEARCH CHAT WEB SEARCH FAILED: {error}")
            hits = []

        sources = _sources_from_web(hits[: request.top_k])
    else:
        if request.scope == "library":
            if not request.paper_ids:
                return ResearchChatResponse(
                    answer="Your collection is empty — save some papers first.",
                    sources=[],
                    used_fallback=True,
                )

            paper_ids = request.paper_ids
        else:
            paper_ids = None

        try:
            results = run_search(
                db=db,
                query=request.message,
                pipeline=request.pipeline,
                top_k=request.top_k,
                paper_ids=paper_ids,
            )
        except ValueError as error:
            raise error

        sources = _sources_from_results(results)

    if not sources:
        return ResearchChatResponse(
            answer=_no_sources_answer(request.scope),
            sources=[],
            used_fallback=True,
        )

    prompt = _build_prompt(
        request.message,
        sources,
        request.history,
    )

    try:
        answer = _groq_answer(prompt)

        return ResearchChatResponse(
            answer=apply_style(
                answer,
                sources,
                request.citation_style,
                request.include_doi,
            ),
            sources=sources,
            used_fallback=False,
            # Checked on the raw answer, while its [n] markers still point
            # at the numbered sources (styling rewrites them).
            fact_check=(
                _fact_check(answer, sources) if request.fact_check else None
            ),
        )

    except Exception as error:
        print(
            f"Research chat Groq fallback: {error}"
        )

        return ResearchChatResponse(
            answer=apply_style(
                _fallback_answer(
                    request.message,
                    sources,
                ),
                sources,
                request.citation_style,
                request.include_doi,
            ),
            sources=sources,
            used_fallback=True,
        )
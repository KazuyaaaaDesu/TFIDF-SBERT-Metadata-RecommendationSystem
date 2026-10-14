"""The research chat follows the citation style chosen in Settings.

The frontend sends `citation_style` / `include_doi` with each request;
answers (hosted-model and extractive-fallback alike) come back with
in-text citations and a reference list in that style. Without a style the
bracket numbers are left alone, so older clients keep working.

Run from the project root:

    .venv/bin/python -m unittest test.test_research_chat_styles -v
"""

import unittest
from unittest.mock import patch

from pydantic import ValidationError

from app.services import research_chat as chat_service
from app.services.research_chat import (
    ResearchChatRequest,
    ResearchChatSource,
)


class FakePaper:
    def __init__(self, id=7, title="A grounded retrieval study",
                 author="Researcher, Ada", publication_year=2023,
                 abstract="Semantic retrieval outperforms lexical search.",
                 doi="10.1234/grounded.2023", document_type="Journal Article"):
        self.id = id
        self.title = title
        self.author = author
        self.publication_year = publication_year
        self.abstract = abstract
        self.doi = doi
        self.document_type = document_type


def ask(style, *, include_doi=True, model_answer=None):
    request = ResearchChatRequest(
        message="How does semantic retrieval compare?",
        citation_style=style,
        include_doi=include_doi,
    )

    hosted = (
        patch.object(chat_service, "_groq_answer", return_value=model_answer)
        if model_answer is not None
        else patch.object(
            chat_service, "_groq_answer", side_effect=RuntimeError("no model")
        )
    )

    with patch.object(
        chat_service,
        "run_search",
        return_value=[{"paper": FakePaper(), "score": 0.7}],
    ), hosted:
        return chat_service.answer_research_question(db=None, request=request)


class RequestFieldsTest(unittest.TestCase):
    def test_style_is_optional_and_doi_defaults_on(self):
        request = ResearchChatRequest(message="q")

        self.assertIsNone(request.citation_style)
        self.assertTrue(request.include_doi)

    def test_only_the_four_settings_styles_are_accepted(self):
        for style in ("apa", "mla", "chicago", "ieee"):
            self.assertEqual(
                ResearchChatRequest(message="q", citation_style=style).citation_style,
                style,
            )

        with self.assertRaises(ValidationError):
            ResearchChatRequest(message="q", citation_style="harvard")


class StyledAnswerTest(unittest.TestCase):
    def test_hosted_answer_in_apa(self):
        response = ask("apa", model_answer="Semantic retrieval wins [1].")

        self.assertFalse(response.used_fallback)
        self.assertIn("Semantic retrieval wins (Researcher, 2023).", response.answer)
        self.assertIn("\n\nReferences\n", response.answer)
        self.assertIn(
            "Researcher, A. (2023). A grounded retrieval study. "
            "https://doi.org/10.1234/grounded.2023",
            response.answer,
        )

    def test_hosted_answer_in_mla_without_doi(self):
        response = ask("mla", include_doi=False, model_answer="Wins [1].")

        self.assertIn("Wins (Researcher).", response.answer)
        self.assertIn("\n\nWorks Cited\n", response.answer)
        self.assertNotIn("10.1234", response.answer)

    def test_extractive_fallback_follows_the_style_too(self):
        response = ask("ieee")

        self.assertTrue(response.used_fallback)
        self.assertIn("[1] Semantic retrieval outperforms lexical search.", response.answer)
        self.assertIn("\n\nReferences\n[1] A. Researcher,", response.answer)

        apa = ask("apa")
        self.assertIn("(Researcher, 2023) Semantic retrieval", apa.answer)

    def test_without_a_style_bracket_numbers_stay(self):
        response = ask(None, model_answer="Wins [1].")

        self.assertEqual(response.answer, "Wins [1].")

    def test_sources_carry_the_document_type(self):
        response = ask("apa", model_answer="Wins [1].")

        self.assertEqual(response.sources[0].document_type, "Journal Article")

    def test_papers_without_a_document_type_attribute_still_work(self):
        class Bare:
            id, title, author, publication_year = 1, "T", "A, B", 2020
            abstract, doi = "Abstract text.", None

        sources = chat_service._sources_from_results([{"paper": Bare(), "score": 0.5}])

        self.assertIsNone(sources[0].document_type)


class PromptTest(unittest.TestCase):
    def test_prompt_tells_the_model_not_to_format_citations_itself(self):
        source = ResearchChatSource(paper_id=1, title="T", score=0.5, abstract="x")

        prompt = chat_service._build_prompt("q", [source], [])

        self.assertIn("reference list", prompt)
        self.assertIn("application formats", prompt)


if __name__ == "__main__":
    unittest.main()

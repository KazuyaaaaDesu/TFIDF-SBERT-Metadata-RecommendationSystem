import json
import unittest
from types import SimpleNamespace as S

from app.services import fact_check as fc

TFIDF = S(
    title="Hybrid retrieval improves ranking",
    abstract=(
        "We evaluate TF-IDF, S-BERT and a hybrid on 120 queries. "
        "The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone. "
        "Dense retrieval does not help on very short queries. "
        "The study was run on a repository of 2,113 papers in 2024."
    ),
)
OTHER = S(
    title="Citation networks and bibliographic coupling",
    abstract=(
        "Bibliographic coupling links papers that share references. "
        "We find that coupling strength predicts topical similarity across disciplines. "
        "Co-citation captures a different signal from coupling in older literature."
    ),
)
EMPTY = S(title="A paper without an abstract", abstract=None)
SOURCES = [TFIDF, OTHER, EMPTY]


def run(answer, **kw):
    return fc.fact_check_answer(answer, SOURCES, **kw)


def verdicts(report):
    return [c.verdict for c in report.claims]


class ExtractionTest(unittest.TestCase):
    def claims(self, text):
        return fc.extract_claims(text)

    def test_sentences_and_markers_attach_to_the_right_claim(self):
        got = self.claims("The hybrid pipeline improves nDCG over TF-IDF [1]. Coupling strength predicts topical similarity [2].")
        self.assertEqual([c.cites for c in got], [[1], [2]])
        self.assertNotIn("[1]", got[0].text)

    def test_marker_after_the_full_stop_belongs_to_that_sentence(self):
        got = self.claims("Hybrid retrieval clearly improves ranking quality. [1] Coupling is a useful signal here. [2][3]")
        self.assertEqual([c.cites for c in got], [[1], [2, 3]])

    def test_ranges_and_lists_expand(self):
        self.assertEqual(self.claims("Several studies agree on this effect [1, 3].")[0].cites, [1, 3])
        self.assertEqual(self.claims("Several studies agree on this effect [1-3].")[0].cites, [1, 2, 3])

    def test_abbreviations_decimals_and_initials_do_not_split(self):
        got = self.claims("Smith et al. report that nDCG rose from 0.31 to 0.42 in the J. Smith study [1].")
        self.assertEqual(len(got), 1)

    def test_non_claims_are_skipped(self):
        text = "\n".join([
            "## Findings",
            "What does this mean for ranking?",
            "Here are the main points:",
            "The available evidence is insufficient to answer that.",
            "I could not find a source that covers this topic.",
            "The available retrieved sources do not contain information about bibliographic coupling, topical similarity, or co-citation, so a comparison cannot be provided.",
            "Based on the retrieved evidence, there is no information about the effect of seed choice.",
            "None of the sources discuss how citation counts relate to retrieval quality.",
            "No relevant evidence was found in the supplied sources for that question.",
            "The sources provided are insufficient to compare the two methods in detail.",
            "Too short.",
            "**Summary of Findings on Blended Learning and Student Satisfaction**",
            "__Key Points Across the Evidence__:",
            "```python",
            "x = 'The hybrid pipeline improves everything always'",
            "```",
            "$$ a = b + c + d + e + f $$",
        ])
        self.assertEqual(self.claims(text), [])

    def test_bold_inside_a_sentence_is_still_a_claim(self):
        got = self.claims("The hybrid pipeline **improves** nDCG over TF-IDF alone by a wide margin [1].")
        self.assertEqual(len(got), 1)

    def test_real_claims_that_mention_sources_are_still_claims(self):
        got = self.claims(
            "The retrieved sources show that coupling strength predicts topical similarity across disciplines [2]. "
            "Source 1 reports that the hybrid pipeline improves nDCG over TF-IDF alone [1]."
        )
        self.assertEqual(len(got), 2)

    def test_lists_tables_and_quotes(self):
        text = "\n".join([
            "- Hybrid ranking improves nDCG over TF-IDF alone [1]",
            "1. Coupling strength predicts topical similarity [2]",
            "",
            "| Pipeline | Result |",
            "|---|---|",
            "| Hybrid pipeline | improves nDCG@10 to 0.42 [1] |",
            "",
            "> Dense retrieval does not help on very short queries [1].",
        ])
        got = self.claims(text)
        self.assertEqual(len(got), 4)
        self.assertEqual(got[2].cites, [1])
        self.assertNotIn("|", got[2].text)

    def test_reference_list_and_markdown_noise_are_not_claims(self):
        text = "Hybrid ranking improves nDCG over TF-IDF [1].\n\nReferences\n[1] Smith, J. (2020). A long reference title that looks like a sentence. https://doi.org/10.1/x"
        self.assertEqual(len(self.claims(text)), 1)
        got = self.claims("**Bold** claim about `code` and $x^2$ that improves ranking over [TF-IDF](https://x.org) alone [1].")
        self.assertNotIn("*", got[0].text)
        self.assertNotIn("$", got[0].text)
        self.assertNotIn("https", got[0].text)

    def test_cap(self):
        text = "\n".join(f"- Claim number {i} says retrieval improves ranking quality [1]" for i in range(80))
        self.assertEqual(len(self.claims(text)), fc.MAX_CLAIMS)


class DeterministicVerdictTest(unittest.TestCase):
    def test_supported_with_evidence_quote(self):
        r = run("The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [1].")
        c = r.claims[0]
        self.assertEqual(c.verdict, "supported")
        self.assertEqual(c.evidence.source, 1)
        self.assertIn("0.42", c.evidence.quote)
        self.assertEqual(r.method, "lexical")

    def test_wrong_number_is_caught(self):
        c = run("The hybrid pipeline improves nDCG@10 from 0.31 to 0.55 over TF-IDF alone [1].").claims[0]
        self.assertEqual(c.verdict, "partial")
        self.assertTrue(any("0.55" in n for n in c.notes))

    def test_thousands_separators_and_percent_forms_match(self):
        self.assertEqual(run("The study used a repository of 2113 papers in 2024 [1].").claims[0].verdict, "supported")

    def test_polarity_flip_is_flagged(self):
        c = run("Dense retrieval helps on very short queries [1].").claims[0]
        self.assertIn(c.verdict, ("partial", "unsupported"))
        self.assertTrue(any("polarity" in n for n in c.notes) or c.verdict == "unsupported")

    def test_unrelated_claim_is_unsupported(self):
        c = run("Quantum annealing outperforms gradient descent on protein folding benchmarks [1].").claims[0]
        self.assertEqual(c.verdict, "unsupported")

    def test_wrong_source_is_not_support(self):
        # True of source 1, cited to source 2.
        c = run("The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [2].").claims[0]
        self.assertEqual(c.verdict, "unsupported")

    def test_multiple_sources_pool_their_evidence(self):
        c = run("Hybrid ranking improves nDCG while coupling strength predicts topical similarity [1][2].").claims[0]
        self.assertIn(c.verdict, ("supported", "partial"))

    def test_uncited_claims_point_at_the_source_that_backs_them(self):
        c = run("Bibliographic coupling links papers that share references.").claims[0]
        self.assertEqual(c.verdict, "uncited")
        self.assertEqual(c.evidence.source, 2)
        self.assertTrue(any("cite it" in n for n in c.notes))
        u = run("Quantum annealing outperforms gradient descent on protein folding.").claims[0]
        self.assertEqual(u.verdict, "uncited")
        self.assertIsNone(u.evidence)

    def test_invalid_citation(self):
        c = run("The hybrid pipeline improves nDCG@10 over TF-IDF alone [9].").claims[0]
        self.assertEqual(c.verdict, "invalid_citation")
        mixed = run("The hybrid pipeline improves nDCG@10 over TF-IDF alone [1][9].").claims[0]
        self.assertEqual(mixed.verdict, "supported")
        self.assertTrue(any("non-existent" in n for n in mixed.notes))

    def test_source_without_text_is_unverifiable(self):
        c = run("This paper proves that dense retrieval always wins on every dataset [3].").claims[0]
        self.assertEqual(c.verdict, "unverifiable")

    def test_summary_counts_and_rate(self):
        r = run(
            "The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [1]. "
            "Quantum annealing outperforms gradient descent on protein folding [1]. "
            "Bibliographic coupling links papers that share references."
        )
        s = r.summary
        self.assertEqual((s.total, s.supported, s.unsupported, s.uncited), (3, 1, 1, 1))
        self.assertEqual(s.support_rate, 0.5)  # 1 of 2 verifiable

    def test_nothing_to_check(self):
        self.assertIsNone(run("The available evidence is insufficient to answer."))
        self.assertIsNone(run(""))

    def test_no_sources(self):
        r = fc.fact_check_answer("The hybrid pipeline improves nDCG over TF-IDF alone [1].", [])
        self.assertEqual(r.claims[0].verdict, "invalid_citation")


class SemanticTest(unittest.TestCase):
    def test_embeddings_raise_a_paraphrase_over_the_threshold(self):
        paraphrase = "Combining dense and sparse signals gives better ranking quality than sparse alone [1]."
        base = run(paraphrase).claims[0]

        def embed(texts):  # claim and its best sentence look alike
            return [[1.0, 0.0] if i < 2 else [0.0, 1.0] for i, _ in enumerate(texts)]

        boosted = run(paraphrase, embed=embed)
        self.assertEqual(boosted.method, "semantic")
        self.assertGreaterEqual(boosted.claims[0].confidence, base.confidence)

    def test_a_failing_embedder_falls_back_silently(self):
        def boom(texts):
            raise RuntimeError("no model")

        r = run("The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [1].", embed=boom)
        self.assertEqual(r.claims[0].verdict, "supported")


class ModelJudgeTest(unittest.TestCase):
    CLAIM = "The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [1]."

    def judge(self, items):
        return lambda prompt: json.dumps(items)

    def test_prompt_contains_sources_and_claims_only_where_cited(self):
        seen = {}

        def llm(prompt):
            seen["p"] = prompt
            return "[]"

        run(self.CLAIM, llm=llm)
        self.assertIn("[1] Hybrid retrieval improves ranking", seen["p"])
        self.assertNotIn("[2] Citation networks", seen["p"])
        self.assertIn("1. (cites [1])", seen["p"])

    def test_model_verdict_and_verified_quote_are_used(self):
        quote = "improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone"
        r = run(self.CLAIM, llm=self.judge([{"id": 1, "verdict": "supported", "reason": "Exact figures match.", "quote": quote}]))
        c = r.claims[0]
        self.assertEqual(r.method, "model")
        self.assertEqual(c.verdict, "supported")
        self.assertEqual(c.notes[0], "Exact figures match.")
        self.assertEqual((c.evidence.source, c.evidence.quote), (1, quote))

    def test_a_made_up_quote_is_rejected(self):
        r = run(self.CLAIM, llm=self.judge([{"id": 1, "verdict": "supported", "reason": "ok", "quote": "The authors proved a ten-fold gain on every benchmark ever."}]))
        c = r.claims[0]
        self.assertNotIn("ten-fold", c.evidence.quote)
        self.assertTrue(any("not found in the source" in n for n in c.notes))

    def test_model_can_contradict_and_find_unsupported(self):
        r = run(
            "Dense retrieval helps on very short queries [1]. Quantum annealing outperforms gradient descent on protein folding [1].",
            llm=self.judge([
                {"id": 1, "verdict": "contradicted", "reason": "Source says it does not help.", "quote": ""},
                {"id": 2, "verdict": "unsupported", "reason": "Not mentioned.", "quote": ""},
            ]),
        )
        self.assertEqual(verdicts(r), ["contradicted", "unsupported"])
        self.assertEqual(r.summary.contradicted, 1)

    def test_supported_with_no_wording_overlap_is_downgraded(self):
        r = run(
            "Quantum annealing outperforms gradient descent on protein folding benchmarks [1].",
            llm=self.judge([{"id": 1, "verdict": "supported", "reason": "Yes.", "quote": ""}]),
        )
        self.assertEqual(r.claims[0].verdict, "partial")
        self.assertTrue(any("barely overlaps" in n for n in r.claims[0].notes))

    def test_model_never_overrides_structural_verdicts(self):
        r = run(
            "Hybrid retrieval improves ranking quality over the baseline [9]. Coupling links papers that share references.",
            llm=self.judge([{"id": 1, "verdict": "supported", "reason": "x", "quote": ""},
                            {"id": 2, "verdict": "supported", "reason": "x", "quote": ""}]),
        )
        self.assertEqual(verdicts(r), ["invalid_citation", "uncited"])

    def test_garbage_replies_fall_back_to_the_lexical_result(self):
        for reply in ["not json", "[", "{}", '[{"id": "x"}]', '[{"id": 1, "verdict": "great"}]', "```json\n[]\n```"]:
            r = run(self.CLAIM, llm=lambda p, reply=reply: reply)
            self.assertEqual(r.method, "lexical", reply)
            self.assertEqual(r.claims[0].verdict, "supported")

    def test_fenced_json_is_accepted(self):
        reply = '```json\n[{"id": 1, "verdict": "partial", "reason": "r", "quote": ""}]\n```'
        r = run(self.CLAIM, llm=lambda p: reply)
        self.assertEqual((r.method, r.claims[0].verdict), ("model", "partial"))

    def test_a_raising_model_is_survivable(self):
        def boom(prompt):
            raise RuntimeError("rate limited")

        r = run(self.CLAIM, llm=boom)
        self.assertEqual(r.method, "lexical")


class RobustnessTest(unittest.TestCase):
    def test_hostile_input_never_raises(self):
        for text in ["", " ", "[[[1]]]", "[1][2][3][4]", "\x00" * 50, "$" * 400, "|" * 300, "a. " * 3000,
                     "- " * 500, "```", "$$", "# " * 100]:
            fc.fact_check_answer(text, SOURCES)

    def test_large_answer_is_fast(self):
        import time
        text = " ".join("The hybrid pipeline improves nDCG@10 over TF-IDF alone [1]." for _ in range(400))
        start = time.time()
        fc.fact_check_answer(text, SOURCES)
        self.assertLess(time.time() - start, 3)

    def test_report_is_json_serialisable(self):
        r = run("The hybrid pipeline improves nDCG@10 from 0.31 to 0.42 over TF-IDF alone [1].")
        json.dumps(r.model_dump())



class ChatIntegrationTest(unittest.TestCase):
    """The chat attaches the report, on the raw answer, and never fails
    the reply because of it."""

    def ask(self, answer, **request_kw):
        from unittest.mock import patch

        from app.services import research_chat as chat
        from test.test_research_chat_styles import FakePaper

        request = chat.ResearchChatRequest(
            message="How does semantic retrieval compare?", **request_kw
        )
        paper = FakePaper(abstract="Semantic retrieval outperforms lexical search on technical queries by a wide margin.")

        with patch.object(chat, "run_search", return_value=[{"paper": paper, "score": 0.7}]), \
             patch.object(chat, "_groq_answer", return_value=answer), \
             patch.dict("os.environ", {"GROQ_API_KEY": ""}):
            return chat.answer_research_question(db=None, request=request)

    def test_report_is_attached_and_checked_before_styling(self):
        response = self.ask(
            "Semantic retrieval outperforms lexical search on technical queries [1].",
            citation_style="apa",
        )
        self.assertIn("(Researcher, 2023)", response.answer)  # styled for display...
        report = response.fact_check
        self.assertEqual(report.claims[0].cites, [1])          # ...checked on [1]
        self.assertEqual(report.claims[0].verdict, "supported")
        self.assertEqual(report.method, "lexical")

    def test_can_be_switched_off(self):
        response = self.ask("Semantic retrieval outperforms lexical search on technical queries [1].", fact_check=False)
        self.assertIsNone(response.fact_check)

    def test_an_answer_with_no_claims_has_no_report(self):
        self.assertIsNone(self.ask("The available evidence is insufficient to answer that.").fact_check)

    def test_a_failing_check_never_loses_the_answer(self):
        from unittest.mock import patch

        from app.services import research_chat as chat

        with patch.object(chat, "fact_check_answer", side_effect=RuntimeError("boom")):
            response = self.ask("Semantic retrieval outperforms lexical search on technical queries [1].")
        self.assertIn("Semantic retrieval", response.answer)
        self.assertIsNone(response.fact_check)

    def test_fallback_answers_are_not_checked(self):
        from unittest.mock import patch

        from app.services import research_chat as chat
        from test.test_research_chat_styles import FakePaper

        with patch.object(chat, "run_search", return_value=[{"paper": FakePaper(), "score": 0.7}]), \
             patch.object(chat, "_groq_answer", side_effect=RuntimeError("no model")):
            response = chat.answer_research_question(
                db=None, request=chat.ResearchChatRequest(message="q")
            )
        self.assertTrue(response.used_fallback)
        self.assertIsNone(response.fact_check)


if __name__ == "__main__":
    unittest.main()

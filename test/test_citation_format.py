"""Citation-style rendering for research-chat answers.

The model writes bracket numbers ([1], [2]); `apply_style` turns them
into the user's chosen style (APA 7, MLA 9, Chicago, IEEE) and appends the
matching reference list. Reference entries mirror
frontend/src/utils/citationStyles.ts so a chat reference reads exactly
like the Copy-as output.

Run from the project root:

    .venv/bin/python -m unittest test.test_citation_format -v
"""

import unittest
from types import SimpleNamespace as Rec

from app.services.citation_format import (
    apply_style,
    is_standalone_work,
    reference_entry,
    surnames,
)

YAO = Rec(
    author="Bohao Yao and Charl Ras and Hamid Mokhtar",
    year=2015,
    title="An algorithm for finding Hamiltonian Cycles in Cubic Planar Graphs",
    doi="10.1/yao",
    document_type="Journal Article",
)
KARAASLAN = Rec(
    author="Karaaslan, Hatice and Kılıç, Nurseven",
    year=2019,
    title="Students' attitudes towards blended language courses",
    doi=None,
    document_type="Journal Article",
)
SRIWICHAI = Rec(
    author="Sriwichai, Chuanpit",
    year=2020,
    title="Students' Readiness and Problems",
    doi="10.2/sri",
    document_type=None,
)
ANON = Rec(
    author=None,
    year=None,
    title="Untitled study of cycle covers in graphs",
    doi=None,
    document_type=None,
)
FOUR = Rec(
    author="Ann One and Bob Two and Cy Three and Di Four",
    year=2001,
    title="Many authors",
    doi=None,
    document_type=None,
)


class SurnamesTest(unittest.TestCase):
    def test_first_last_joined_by_and(self):
        self.assertEqual(
            surnames("Bohao Yao and Charl Ras and Hamid Mokhtar"),
            ["Yao", "Ras", "Mokhtar"],
        )

    def test_last_first_joined_by_and(self):
        self.assertEqual(
            surnames("Karaaslan, Hatice and Kılıç, Nurseven"),
            ["Karaaslan", "Kılıç"],
        )

    def test_single_last_first_author(self):
        self.assertEqual(surnames("Sriwichai, Chuanpit"), ["Sriwichai"])
        self.assertEqual(surnames("Aggarwal, Charu C"), ["Aggarwal"])

    def test_all_caps_surname_is_title_cased(self):
        self.assertEqual(surnames("AGGUN, Nazli"), ["Aggun"])

    def test_semicolon_lists_in_both_name_orders(self):
        self.assertEqual(
            surnames("Alex Krizhevsky; Ilya Sutskever; Geoffrey E. Hinton"),
            ["Krizhevsky", "Sutskever", "Hinton"],
        )
        self.assertEqual(
            surnames("Bai, Shuyang; Düker, Marie-Christine"),
            ["Bai", "Düker"],
        )

    def test_comma_separated_list_with_stray_spaces_and_trailing_comma(self):
        self.assertEqual(
            surnames("Jean-Marc Ginoux , Roomila Naeck , Matjaˇz Perc,"),
            ["Ginoux", "Naeck", "Perc"],
        )

    def test_corporate_author_is_kept_whole(self):
        self.assertEqual(
            surnames("BESIII Collaboration; M. Ablikim; M. N. Achasov"),
            ["BESIII Collaboration", "Ablikim", "Achasov"],
        )

    def test_name_particles_stay_with_the_surname(self):
        self.assertEqual(surnames("Ludwig van Beethoven"), ["van Beethoven"])

    def test_missing_author(self):
        self.assertEqual(surnames(None), [])
        self.assertEqual(surnames("  "), [])


class StructuredAuthorsTest(unittest.TestCase):
    """A repository paper carries given / middle / family parts and the
    styles use those, not a re-parse of the display string."""

    PAPER = Rec(
        author="Whatever Display String",
        authors=[
            {"given": "Ada", "middle": "Augusta", "family": "King", "suffix": ""},
            {"given": "Martin", "middle": "Luther", "family": "King", "suffix": "Jr."},
        ],
        year=1843, title="Notes on the analytical engine", doi=None,
        document_type="Journal Article",
    )

    def test_parts_win_over_the_display_string(self):
        self.assertEqual(
            reference_entry("apa", self.PAPER, False),
            "King, A. A., & King, M. L. Jr. (1843). Notes on the analytical engine.",
        )
        self.assertEqual(
            reference_entry("ieee", self.PAPER, False, number=1),
            '[1] A. A. King and M. L. King, Jr., "Notes on the analytical engine," 1843.',
        )
        self.assertEqual(
            reference_entry("mla", self.PAPER, False),
            'King, Ada Augusta, and Martin Luther King Jr. "Notes on the analytical engine". 1843.',
        )

    def test_in_text_uses_family_names(self):
        out = apply_style("Engine [1].", [self.PAPER], "apa")
        self.assertIn("Engine (King & King, 1843).", out)

    def test_object_parts_and_empty_parts_fall_back(self):
        obj = Rec(
            author="Jane Doe",
            authors=[Rec(given="Jane", middle="Q.", family="Doe", suffix="")],
            year=2000, title="T", doi=None, document_type=None,
        )
        self.assertIn("Doe, J. Q.", reference_entry("apa", obj, False))

        bare = Rec(author="Jane Doe", authors=[], year=2000, title="T",
                   doi=None, document_type=None)
        self.assertIn("Doe, J.", reference_entry("apa", bare, False))


class StandaloneWorkTest(unittest.TestCase):
    def test_mirrors_the_frontend_rule(self):
        for kind in ("Thesis", "PhD dissertation", "Technical Report", "Book Chapter"):
            self.assertTrue(is_standalone_work(kind), kind)
        for kind in ("Journal Article", "Preprint", None, ""):
            self.assertFalse(is_standalone_work(kind), kind)


class ReferenceEntryTest(unittest.TestCase):
    """Exact parity with citationParts() in citationStyles.ts."""

    def test_apa(self):
        self.assertEqual(
            reference_entry("apa", YAO, True),
            "Yao, B., Ras, C., & Mokhtar, H. (2015). "
            "An algorithm for finding Hamiltonian Cycles in Cubic Planar "
            "Graphs. https://doi.org/10.1/yao",
        )

    def test_mla_journal_article_quotes_the_title(self):
        self.assertEqual(
            reference_entry("mla", YAO, True),
            'Yao, Bohao, et al. "An algorithm for '
            'finding Hamiltonian Cycles in Cubic Planar Graphs". 2015. '
            "DOI: 10.1/yao.",
        )

    def test_mla_standalone_work_is_not_quoted(self):
        book = Rec(**{**vars(YAO), "document_type": "Book Chapter", "doi": None})

        self.assertEqual(
            reference_entry("mla", book, True),
            "Yao, Bohao, et al. An algorithm for "
            "finding Hamiltonian Cycles in Cubic Planar Graphs. 2015.",
        )

    def test_chicago(self):
        self.assertEqual(
            reference_entry("chicago", SRIWICHAI, True),
            'Sriwichai, Chuanpit. "Students\' Readiness and Problems". '
            "2020. https://doi.org/10.2/sri.",
        )

    def test_ieee_is_numbered(self):
        self.assertEqual(
            reference_entry("ieee", KARAASLAN, True, number=3),
            "[3] H. Karaaslan and N. Kılıç, "
            '"Students\' attitudes towards blended language courses," 2019.',
        )

    def test_each_style_applies_its_own_et_al_rule(self):
        def many(count):
            return Rec(
                author="; ".join(f"Given{i} Family{i}" for i in range(1, count + 1)),
                year=2020, title="Big collaboration", doi=None, document_type=None,
            )

        # APA 7 lists up to 20, then ". . ." and the last author.
        apa = reference_entry("apa", many(25), True)
        self.assertIn("Family19, G., . . . Family25, G. (2020).", apa)
        self.assertNotIn("Family20", apa)
        self.assertIn("& Family15, G. (2020)", reference_entry("apa", many(15), True))

        # IEEE: more than six authors -> first author et al.
        self.assertIn("G. Family1 et al.,", reference_entry("ieee", many(7), True))

        # MLA: three or more -> first author et al.
        self.assertIn("Family1, Given1, et al.", reference_entry("mla", many(3), True))

        # Chicago: more than ten -> first seven et al.
        chi = reference_entry("chicago", many(12), True)
        self.assertIn("Family7", chi)
        self.assertNotIn("Family8", chi)
        self.assertIn("et al.", chi)

    def test_ten_authors_or_fewer_are_listed_in_full(self):
        ten = Rec(
            author=" and ".join(f"Given{i} Family{i}" for i in range(1, 11)),
            year=2020, title="Ten authors", doi=None, document_type=None,
        )

        entry = reference_entry("apa", ten, True)

        self.assertIn("Family10", entry)
        self.assertNotIn("et al.", entry)

    def test_doi_toggle_and_missing_values(self):
        self.assertNotIn("10.1/yao", reference_entry("apa", YAO, False))
        self.assertEqual(
            reference_entry("apa", ANON, True),
            "Unknown author (n.d.). Untitled study of cycle covers in graphs.",
        )


class ApplyStyleTest(unittest.TestCase):
    def test_no_style_leaves_the_answer_untouched(self):
        answer = "Cubic graphs [1]."

        self.assertEqual(apply_style(answer, [YAO], None), answer)

    def test_answer_without_citations_gets_no_reference_list(self):
        self.assertEqual(apply_style("No sources used.", [YAO], "apa"), "No sources used.")

    def test_apa_in_text_and_alphabetical_references(self):
        out = apply_style("Cycles [1]. Attitudes vary [2].", [YAO, KARAASLAN], "apa")

        self.assertIn("Cycles (Yao et al., 2015).", out)
        self.assertIn("Attitudes vary (Karaaslan & Kılıç, 2019).", out)
        self.assertNotIn("[1]", out.split("\n\nReferences")[0])
        body, _, refs = out.partition("\n\nReferences\n")
        lines = refs.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("Karaaslan"))
        self.assertTrue(lines[1].startswith("Yao, B."))

    def test_apa_merges_adjacent_citations_alphabetically(self):
        for raw in ("[1][2]", "[1] [2]", "[1, 2]", "[2][1]"):
            out = apply_style(f"Both {raw}.", [YAO, KARAASLAN], "apa")

            self.assertIn(
                "Both (Karaaslan & Kılıç, 2019; Yao et al., 2015).", out, raw
            )

    def test_apa_without_author_uses_a_short_quoted_title_and_nd(self):
        out = apply_style("Anonymous work [1].", [ANON], "apa")

        self.assertIn('("Untitled study of cycle," n.d.)', out)

    def test_all_caps_titles_are_title_cased_in_short_form(self):
        shouting = Rec(
            author=None, year=None, doi=None, document_type=None,
            title="MULTI-COMMODITY MINIMUM-COST FLOW FOR GRAPHS",
        )

        out = apply_style("Flow [1].", [shouting], "apa")

        self.assertIn('("Multi-Commodity Minimum-Cost Flow For," n.d.)', out)

    def test_mla_uses_author_only_and_works_cited(self):
        out = apply_style("A [1] B [2] C [3].", [YAO, KARAASLAN, SRIWICHAI], "mla")

        self.assertIn("A (Yao et al.) B (Karaaslan and Kılıç) C (Sriwichai).", out)
        self.assertIn("\n\nWorks Cited\n", out)

    def test_chicago_author_date_in_text_and_bibliography(self):
        out = apply_style("X [1] Y [2] Z [3].", [YAO, KARAASLAN, FOUR], "chicago")

        self.assertIn("(Yao, Ras, and Mokhtar 2015)", out)
        self.assertIn("(Karaaslan and Kılıç 2019)", out)
        self.assertIn("(One et al. 2001)", out)
        self.assertIn("\n\nBibliography\n", out)

    def test_ieee_numbers_by_first_citation_and_orders_references_that_way(self):
        out = apply_style("B first [2], then A [1], B again [2].", [YAO, KARAASLAN], "ieee")

        body, _, refs = out.partition("\n\nReferences\n")
        self.assertEqual(body, "B first [1], then A [2], B again [1].")
        lines = refs.splitlines()
        self.assertTrue(lines[0].startswith("[1] H. Karaaslan"))
        self.assertTrue(lines[1].startswith("[2] B. Yao"))

    def test_ieee_adjacent_citations_are_listed_separately(self):
        out = apply_style("Both [1][2].", [YAO, KARAASLAN], "ieee")

        self.assertTrue(out.startswith("Both [1], [2]."))

    def test_only_cited_sources_are_listed(self):
        out = apply_style("Only one [2].", [YAO, KARAASLAN], "apa")

        refs = out.partition("\n\nReferences\n")[2].splitlines()
        self.assertEqual(len(refs), 1)
        self.assertTrue(refs[0].startswith("Karaaslan"))

    def test_unknown_source_numbers_are_dropped(self):
        out = apply_style("Real [1] and imagined [9].", [YAO], "apa")

        self.assertIn("Real (Yao et al., 2015) and imagined.", out)
        self.assertEqual(len(out.partition("\n\nReferences\n")[2].splitlines()), 1)

    def test_doi_toggle_reaches_the_reference_list(self):
        with_doi = apply_style("Cycles [1].", [YAO], "apa", include_doi=True)
        without = apply_style("Cycles [1].", [YAO], "apa", include_doi=False)

        self.assertIn("https://doi.org/10.1/yao", with_doi)
        self.assertNotIn("doi.org", without)

    def test_extractive_fallback_lines_are_styled_too(self):
        fallback = "Evidence:\n\n[1] Cycles exist.\n\n[2] Attitudes differ."

        out = apply_style(fallback, [YAO, KARAASLAN], "apa")

        self.assertIn("(Yao et al., 2015) Cycles exist.", out)
        self.assertIn("(Karaaslan & Kılıç, 2019) Attitudes differ.", out)


if __name__ == "__main__":
    unittest.main()

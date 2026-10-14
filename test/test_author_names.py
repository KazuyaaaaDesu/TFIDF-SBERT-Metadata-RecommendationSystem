import unittest

from app.services import author_names as an
from app.services.author_names import AuthorName, parse_author, parse_author_list


def P(text):
    n = parse_author(text)
    return (n.given, n.middle, n.family, n.suffix)


class ParseOneTest(unittest.TestCase):
    def test_first_last(self):
        self.assertEqual(P("John Smith"), ("John", "", "Smith", ""))

    def test_first_middle_last(self):
        self.assertEqual(P("John Ronald Reuel Tolkien"), ("John", "Ronald Reuel", "Tolkien", ""))
        self.assertEqual(P("J. R. R. Tolkien"), ("J.", "R. R.", "Tolkien", ""))

    def test_last_comma_first(self):
        self.assertEqual(P("Smith, John Michael"), ("John", "Michael", "Smith", ""))
        self.assertEqual(P("Smith, J."), ("J.", "", "Smith", ""))

    def test_particles_belong_to_family(self):
        self.assertEqual(P("Ludwig van Beethoven"), ("Ludwig", "", "van Beethoven", ""))
        self.assertEqual(P("Jan van der Berg"), ("Jan", "", "van der Berg", ""))
        self.assertEqual(P("van der Berg, Jan"), ("Jan", "", "van der Berg", ""))

    def test_suffix(self):
        self.assertEqual(P("Martin Luther King Jr."), ("Martin", "Luther", "King", "Jr."))
        self.assertEqual(P("King, Martin Luther, Jr."), ("Martin", "Luther", "King", "Jr."))
        self.assertEqual(P("King, Jr., Martin Luther"), ("Martin", "Luther", "King", "Jr."))

    def test_pubmed_initials(self):
        self.assertEqual(P("Smith JR"), ("J", "R", "Smith", ""))
        self.assertEqual(P("Garcia M"), ("M", "", "Garcia", ""))

    def test_uppercase_surname_is_title_cased(self):
        self.assertEqual(P("SMITH, John"), ("John", "", "Smith", ""))

    def test_single_token_and_empty(self):
        self.assertEqual(P("Plato"), ("", "", "Plato", ""))
        self.assertIsNone(parse_author(""))
        self.assertIsNone(parse_author(None))
        self.assertIsNone(parse_author("et al."))
        self.assertIsNone(parse_author("Unknown"))
        self.assertEqual(parse_author_list("Unknown"), [])

    def test_corporate_stays_whole(self):
        n = parse_author("ATLAS Collaboration")
        self.assertEqual((n.given, n.family), ("", "ATLAS Collaboration"))
        self.assertTrue(n.is_corporate)

    def test_hyphenated_given_name(self):
        n = parse_author("Jean-Paul Sartre")
        self.assertEqual((n.given, n.family), ("Jean-Paul", "Sartre"))
        self.assertEqual(n.initials(), "J.-P.")


class UnicodeHyphenTest(unittest.TestCase):
    def test_typographic_hyphen_in_given_name(self):
        n = parse_author("Hye\u2010Jin Paek")
        self.assertEqual((n.given, n.family), ("Hye\u2010Jin", "Paek"))
        self.assertEqual(n.initials(), "H.-J.")


class ParseListTest(unittest.TestCase):
    def fams(self, text):
        return [n.family for n in parse_author_list(text)]

    def test_semicolon_list(self):
        self.assertEqual(self.fams("Smith, John; Doe, Jane A."), ["Smith", "Doe"])

    def test_and_list(self):
        self.assertEqual(self.fams("John Smith and Jane Doe"), ["Smith", "Doe"])
        self.assertEqual(self.fams("John Smith, Jane Doe and Bob Roe"), ["Smith", "Doe", "Roe"])

    def test_comma_first_last_list(self):
        self.assertEqual(self.fams("John Smith, Jane Doe, Bob Roe"), ["Smith", "Doe", "Roe"])

    def test_last_first_pairs(self):
        self.assertEqual(self.fams("Smith, John, Doe, Jane"), ["Smith", "Doe"])

    def test_single_inverted_name_not_split(self):
        names = parse_author_list("Smith, John")
        self.assertEqual(len(names), 1)
        self.assertEqual(names[0].given, "John")

    def test_pipe_and_blank(self):
        self.assertEqual(self.fams("John Smith | Jane Doe"), ["Smith", "Doe"])
        self.assertEqual(parse_author_list(""), [])
        self.assertEqual(parse_author_list(None), [])

    def test_display_roundtrip(self):
        names = parse_author_list("Smith, John M.; Doe, Jane")
        self.assertEqual(an.display_string(names), "John M. Smith; Jane Doe")
        again = parse_author_list(an.display_string(names))
        self.assertEqual(names, again)


class InitialsTest(unittest.TestCase):
    def test_initials(self):
        self.assertEqual(AuthorName("John", "Ronald", "T").initials(), "J. R.")
        self.assertEqual(AuthorName("J.", "R.", "T").initials(), "J. R.")
        self.assertEqual(AuthorName("JR", "", "T").initials(), "J. R.")
        self.assertEqual(AuthorName("", "", "T").initials(), "")


class StylesTest(unittest.TestCase):
    A = AuthorName("John", "Michael", "Smith")
    B = AuthorName("Jane", "", "Doe")
    C = AuthorName("Bob", "A.", "Roe")

    def test_apa(self):
        self.assertEqual(an.format_apa([self.A]), "Smith, J. M.")
        self.assertEqual(an.format_apa([self.A, self.B]), "Smith, J. M., & Doe, J.")
        self.assertEqual(
            an.format_apa([self.A, self.B, self.C]),
            "Smith, J. M., Doe, J., & Roe, B. A.",
        )

    def test_apa_twenty_one_plus_uses_ellipsis(self):
        many = [AuthorName("A", "", f"F{i}") for i in range(25)]
        text = an.format_apa(many)
        self.assertIn(". . .", text)
        self.assertTrue(text.endswith("F24, A."))
        self.assertIn("F18, A.", text)
        self.assertNotIn("F19,", text)

    def test_mla(self):
        self.assertEqual(an.format_mla([self.A]), "Smith, John Michael")
        self.assertEqual(an.format_mla([self.A, self.B]), "Smith, John Michael, and Jane Doe")
        self.assertEqual(an.format_mla([self.A, self.B, self.C]), "Smith, John Michael, et al.")

    def test_chicago(self):
        self.assertEqual(an.format_chicago([self.A, self.B]), "Smith, John Michael, and Jane Doe")
        self.assertEqual(
            an.format_chicago([self.A, self.B, self.C]),
            "Smith, John Michael, Jane Doe, and Bob A. Roe",
        )

    def test_chicago_over_ten(self):
        many = [AuthorName("A", "", f"F{i}") for i in range(12)]
        text = an.format_chicago(many)
        self.assertTrue(text.endswith(", et al."))
        self.assertIn("F6", text)
        self.assertNotIn("F7", text)

    def test_ieee(self):
        self.assertEqual(an.format_ieee([self.A]), "J. M. Smith")
        self.assertEqual(an.format_ieee([self.A, self.B]), "J. M. Smith and J. Doe")
        self.assertEqual(
            an.format_ieee([self.A, self.B, self.C]),
            "J. M. Smith, J. Doe, and B. A. Roe",
        )
        seven = [AuthorName("A", "", f"F{i}") for i in range(7)]
        self.assertEqual(an.format_ieee(seven), "A. F0 et al.")

    def test_bibtex_and_corporate(self):
        self.assertEqual(
            an.format_bibtex([self.A, self.B]),
            "Smith, John Michael and Doe, Jane",
        )
        corp = parse_author("ATLAS Collaboration")
        self.assertEqual(an.format_bibtex([corp]), "{ATLAS Collaboration}")
        self.assertEqual(an.format_apa([corp]), "ATLAS Collaboration")

    def test_suffix_in_styles(self):
        n = AuthorName("Martin", "Luther", "King", "Jr.")
        self.assertEqual(an.format_apa([n]), "King, M. L. Jr.")
        self.assertEqual(an.format_ieee([n]), "M. L. King, Jr.")
        self.assertEqual(n.inverted(), "King, Martin Luther, Jr.")
        self.assertEqual(n.full(), "Martin Luther King Jr.")


if __name__ == "__main__":
    unittest.main()

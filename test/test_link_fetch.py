import unittest
from unittest import mock

from app.services import link_fetch
from app.services.link_fetch import LinkFetchError, clean_url, fetch_link


class FakeResponse:
    ok = True
    status_code = 200
    encoding = "utf-8"

    def __init__(self, body: str):
        self._body = body.encode()

    def iter_content(self, n):
        yield self._body

    def close(self):
        pass


class LinkFetchTests(unittest.TestCase):
    def test_clean_url_uri_list(self):
        self.assertEqual(clean_url("# c\r\nhttps://a.org/x?y=1 trailing"), "https://a.org/x?y=1")

    def _fetch(self, body):
        with mock.patch.object(link_fetch, "safe_get", return_value=FakeResponse(body)):
            return fetch_link("https://example.org/p")

    def test_bibtex(self):
        self.assertEqual(self._fetch("@article{a, title={T}}")["format"], "bib")

    def test_ris(self):
        self.assertEqual(self._fetch("TY  - JOUR\nTI  - T\nER  -")["format"], "ris")

    def test_html_meta(self):
        out = self._fetch(
            '<html><head><meta name="citation_title" content="Deep Nets">'
            '<meta name="citation_author" content="Doe, Jane">'
            '<meta name="citation_doi" content="10.1000/xyz123">'
            '<meta name="citation_publication_date" content="2021/05/01"></head></html>'
        )
        self.assertEqual(out["format"], "bib")
        self.assertIn("Deep Nets", out["text"])
        self.assertIn("year = {2021}", out["text"])

    def test_html_doi_only(self):
        out = self._fetch("<html><body>see doi 10.1000/abc.def</body></html>")
        self.assertEqual(out, {"format": "doi", "text": "10.1000/abc.def", "url": "https://example.org/p"})

    def test_unusable(self):
        with self.assertRaises(LinkFetchError):
            self._fetch("<html><body>nothing</body></html>")

    def test_private_blocked(self):
        with self.assertRaises(LinkFetchError):
            fetch_link("http://127.0.0.1:8000/x")
        with self.assertRaises(LinkFetchError):
            fetch_link("ftp://example.org/x")


if __name__ == "__main__":
    unittest.main()

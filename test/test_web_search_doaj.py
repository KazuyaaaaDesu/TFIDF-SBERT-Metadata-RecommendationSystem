import unittest
from unittest import mock

from app.services import web_search
from app.services.web_search import WebSearchResult, _merge, _search_doaj


class FakeResponse:
    ok = True
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _item(**bib):
    base = {
        "title": "  Neural   MT survey ",
        "year": "2022",
        "identifier": [
            {"id": "2666-8270", "type": "pissn"},
            {"id": "10.1016/J.Test.1", "type": "doi"},
        ],
        "journal": {"title": "Machine Learning with Applications"},
        "author": [{"name": "Ada Lovelace"}, {"name": "Alan Turing"}],
        "abstract": "An   abstract.",
        "link": [
            {"type": "fulltext", "url": "https://example.org/article"},
            {"type": "fulltext", "url": "https://example.org/a.pdf"},
        ],
    }
    base.update(bib)
    return {"bibjson": base}


def _run(payload, **kwargs):
    args = dict(year_min=None, year_max=None, sort="relevance", limit=10)
    args.update(kwargs)
    with mock.patch.object(
        web_search, "_get_with_retry", return_value=FakeResponse(payload)
    ) as get:
        return _search_doaj("neural machine translation", **args), get


class SearchDoajTests(unittest.TestCase):
    def test_maps_fields(self):
        results, get = _run({"results": [_item()]})
        self.assertEqual(len(results), 1)
        r = results[0]
        self.assertEqual(r.title, "Neural MT survey")
        self.assertEqual(r.author, "Ada Lovelace; Alan Turing")
        self.assertEqual(r.publication_year, 2022)
        self.assertEqual(r.doi, "10.1016/j.test.1")
        self.assertEqual(r.venue, "Machine Learning with Applications")
        self.assertEqual(r.abstract, "An abstract.")
        self.assertEqual(r.source, "doaj")
        self.assertIs(r.is_oa, True)
        self.assertEqual(r.document_type, "Journal Article")
        self.assertEqual(r.landing_url, "https://example.org/article")
        self.assertEqual(r.pdf_url, "https://example.org/a.pdf")
        self.assertIsNone(r.citations)

        kwargs = get.call_args.kwargs
        self.assertEqual(kwargs["source"], "doaj-search")
        self.assertFalse(kwargs["respect_429_backoff"])
        self.assertIn("mailto:", kwargs["headers"]["User-Agent"])
        self.assertTrue(
            get.call_args.args[0].startswith(
                "https://doaj.org/api/search/articles/neural%20machine"
            )
        )

    def test_year_filter_in_query_and_rechecked(self):
        payload = {
            "results": [_item(year="2019", title="Old"), _item(title="New")]
        }
        results, get = _run(payload, year_min=2020, year_max=2023)
        self.assertEqual([r.title for r in results], ["New"])
        self.assertIn("bibjson.year%3A%5B2020%20TO%202023%5D", get.call_args.args[0])

    def test_query_special_characters_neutralised(self):
        with mock.patch.object(
            web_search, "_get_with_retry", return_value=FakeResponse({"results": []})
        ) as get:
            _search_doaj('a/b: "c" AND d', year_min=None, year_max=None,
                         sort="relevance", limit=5)
        url = get.call_args.args[0]
        path = url.split("articles/")[1]
        self.assertNotIn("%2F", path)
        self.assertNotIn("%3A", path)
        self.assertNotIn("%22", url)
        self.assertIn("and", url)

    def test_doi_fallback_landing_and_missing_title(self):
        results, _ = _run(
            {"results": [_item(link=[]), _item(title="")]}
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].landing_url, "https://doi.org/10.1016/j.test.1")
        self.assertIsNone(results[0].pdf_url)

    def test_failure_returns_none(self):
        with mock.patch.object(web_search, "_get_with_retry", return_value=None):
            self.assertIsNone(
                _search_doaj("x", year_min=None, year_max=None,
                             sort="relevance", limit=5)
            )

    def test_bad_json_returns_none(self):
        class Bad(FakeResponse):
            def json(self):
                raise ValueError

        with mock.patch.object(web_search, "_get_with_retry", return_value=Bad({})):
            self.assertIsNone(
                _search_doaj("x", year_min=None, year_max=None,
                             sort="relevance", limit=5)
            )


class MergeDoajTests(unittest.TestCase):
    def test_doi_dedup_prefers_earlier_source(self):
        oa = WebSearchResult(title="Paper A", doi="10.1/a", source="openalex", publication_year=2021)
        dj = WebSearchResult(title="Paper A (DOAJ)", doi="https://doi.org/10.1/A", source="doaj", publication_year=2021)
        dj2 = WebSearchResult(title="Paper B", doi="10.1/b", source="doaj", publication_year=2020)
        merged = _merge([oa], [], [], [dj, dj2], "relevance", 10)
        self.assertEqual([r.source for r in merged], ["openalex", "doaj"])
        self.assertEqual(merged[1].title, "Paper B")

    def test_year_sort_includes_doaj(self):
        dj = WebSearchResult(title="New", source="doaj", publication_year=2024)
        oa = WebSearchResult(title="Old", source="openalex", publication_year=2010)
        merged = _merge([oa], [], [], [dj], "year", 10)
        self.assertEqual(merged[0].title, "New")

    def test_doaj_in_sources_and_fanout(self):
        self.assertIn("doaj", web_search.SOURCES)
        self.assertEqual(web_search._SEARCH_LABELS["doaj"], "doaj-search")
        dj = WebSearchResult(title="Only DOAJ", source="doaj")
        with mock.patch.object(web_search, "_search_doaj", return_value=[dj]), \
             mock.patch.object(web_search, "_breaker_open", return_value=False):
            web_search._CACHE.clear()
            out = web_search.search_web("zzz-doaj-test", sources=("doaj",))
        self.assertEqual([r.title for r in out], ["Only DOAJ"])


if __name__ == "__main__":
    unittest.main()

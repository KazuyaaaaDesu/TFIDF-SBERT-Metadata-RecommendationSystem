"""Related works for a web result (no saved paper): resolution by
DOI / OpenAlex id / title, all offline through the fetch seam.

Run from the project root:

    .venv/bin/python -m unittest test.test_web_result_connections -v
"""

import unittest
from unittest import mock
from urllib.error import HTTPError

from fastapi import HTTPException

from app import api
from app.services.web_connections import fetch_neighborhood

ROOT = {
    "id": "https://openalex.org/W100",
    "title": "Attention Is All You Need",
    "doi": "https://doi.org/10.0/center",
    "referenced_works": ["https://openalex.org/W1"],
}


def _work(work_id, title, cites):
    return {
        "id": f"https://openalex.org/{work_id}",
        "title": title,
        "doi": None,
        "publication_year": 2019,
        "cited_by_count": cites,
        "authorships": [],
        "referenced_works": [],
    }


def make_fetch(
    urls,
    *,
    root=ROOT,
    search_results=None,
    doi_404=False,
    s2=True,
    crossref=True,
):
    """One seam serving every provider, recording each URL.

    Provider routing is by host so a single `fetch` covers the whole
    multi-source neighborhood. `s2` / `crossref` switch a provider off to
    imitate it being unreachable, which is the expected case in
    production -- Semantic Scholar rate-limits hard without a key.
    """

    def fetch(url):
        urls.append(url)

        # -- Semantic Scholar --------------------------------------
        if "api.semanticscholar.org" in url:
            if not s2:
                raise HTTPError(url, 429, "Too Many Requests", {}, None)

            if "/references" in url:
                return {
                    "data": [
                        {
                            "citedPaper": {
                                "paperId": "s2ref",
                                "title": "Reference",
                                "year": 2019,
                                "citationCount": 9,
                                "authors": [{"name": "Ref Author"}],
                                "externalIds": {"DOI": "10.0/ref"},
                            }
                        }
                    ]
                }

            if "/citations" in url:
                return {
                    "data": [
                        {
                            "citingPaper": {
                                "paperId": "s2cit",
                                "title": "S2 Citer",
                                "year": 2021,
                                "citationCount": 4,
                                "authors": [],
                                "externalIds": {"DOI": "10.0/s2cit"},
                            }
                        }
                    ]
                }

            if "/paper/search" in url:
                return {"data": [{"paperId": "s2center", "title": "T"}]}

            # DOI resolution for the center.
            return {"paperId": "s2center", "title": "Attention Is All You Need"}

        # -- Crossref ------------------------------------------------
        if "api.crossref.org" in url:
            if not crossref:
                raise HTTPError(url, 404, "Not Found", {}, None)

            return {
                "message": {
                    "reference": [
                        {"DOI": "10.0/ref", "unstructured": "Reference"},
                        {"DOI": "10.0/extra", "article-title": "Extra Ref"},
                        # Unidentifiable: no DOI, no title. Dropped.
                        {"year": 1999},
                    ]
                }
            }

        # -- OpenCitations ------------------------------------------
        if "opencitations.net" in url:
            return [
                {
                    "cited": "omid:br/9 doi:10.0/oc openalex:W77",
                    "creation": "2012-01-01",
                }
            ]

        # -- Europe PMC ---------------------------------------------
        # The "Deep learning" record. This paper is life-sciences
        # indexed, so both sides answer.
        if "ebi.ac.uk" in url and "/search?" in url:
            return {
                "resultList": {
                    "result": [{"id": "26017442", "source": "MED"}]
                }
            }

        if "ebi.ac.uk" in url and "/references?" in url:
            return {
                "referenceList": {
                    "reference": [
                        {
                            "id": "5",
                            "source": "MED",
                            "title": "EPMC Prior",
                            "authorString": "Author A",
                            "pubYear": "2001",
                        }
                    ]
                }
            }

        if "ebi.ac.uk" in url and "/citations?" in url:
            return {
                "citationList": {
                    "citation": [
                        {
                            "id": "6",
                            "source": "MED",
                            "title": "EPMC Derivative",
                            "authorString": "Author B",
                            "pubYear": "2022",
                        }
                    ]
                }
            }

        # -- OpenAlex ------------------------------------------------
        if "filter=cites:" in url:
            return {"results": [_work("W3", "Citer", 4)]}

        if "filter=ids.openalex:" in url:
            return {"results": [_work("W1", "Reference", 9)]}

        if "/doi:" in url:
            if doi_404:
                raise HTTPError(url, 404, "Not Found", {}, None)
            return root

        if "?search=" in url:
            return {"results": search_results or []}

        if "/W100?" in url:
            return root

        raise AssertionError(f"unexpected URL: {url}")

    return fetch


class FetchNeighborhoodTest(unittest.TestCase):
    def test_resolves_by_doi_and_asks_openalex_first(self):
        urls = []
        result = fetch_neighborhood(
            doi="https://doi.org/10.0/Center",
            fetch=make_fetch(urls),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["work_id"], "W100")
        self.assertEqual(result["doi"], "10.0/center")

        # OpenAlex still leads: it is the only source that can build the
        # edge structure, so it must be resolved before anything else.
        openalex_calls = [u for u in urls if "api.openalex.org" in u]
        self.assertTrue(openalex_calls)
        self.assertTrue(
            all(u.startswith("https://api.openalex.org/works") for u in openalex_calls)
        )

    def test_unions_the_extra_sources_into_both_sides(self):
        result = fetch_neighborhood(doi="10.0/center", fetch=make_fetch([]))

        prior_ids = {w["work_id"] for w in result["prior_works"]}
        derivative_ids = {w["work_id"] for w in result["derivative_works"]}

        # The Semantic Scholar reference is folded into the OpenAlex row
        # it duplicates (see the corroboration test below), so it is
        # counted through that row rather than appearing separately.
        self.assertIn("W1", prior_ids)
        self.assertIn("doi:10.0/extra", prior_ids)  # Crossref-only reference
        self.assertIn("W3", derivative_ids)         # OpenAlex citer
        self.assertIn("s2:s2cit", derivative_ids)  # Semantic Scholar citer

    def test_a_work_two_sources_share_becomes_one_corroborated_row(self):
        result = fetch_neighborhood(doi="10.0/center", fetch=make_fetch([]))

        # "Reference" arrives three times: OpenAlex (no DOI), Semantic
        # Scholar (DOI 10.0/ref) and Crossref (DOI 10.0/ref). It must be
        # ONE row naming all three, not three near-identical rows.
        matching = [
            w
            for w in result["prior_works"]
            if w["work_id"] == "W1"
        ]
        self.assertEqual(len(matching), 1)

        row = matching[0]
        self.assertEqual(
            sorted(row["sources"]),
            ["crossref", "openalex", "semantic_scholar"],
        )
        # OpenAlex is merged first, so its own fields stand.
        self.assertEqual(row["cited_by_count"], 9)
        # ...and the DOI the later sources knew is filled into the gap.
        self.assertEqual(row["doi"], "10.0/ref")

    def test_reports_which_sources_answered(self):
        result = fetch_neighborhood(doi="10.0/center", fetch=make_fetch([]))

        self.assertEqual(
            result["sources"],
            [
                "openalex",
                "semantic_scholar",
                "crossref",
                "open_citations",
                "europe_pmc",
            ],
        )
        self.assertEqual(result["source_counts"]["semantic_scholar"]["prior"], 1)
        self.assertEqual(result["source_counts"]["crossref"]["prior"], 2)
        self.assertEqual(result["source_counts"]["open_citations"]["prior"], 1)
        self.assertEqual(result["source_counts"]["europe_pmc"]["derivative"], 1)

    def test_one_failing_source_does_not_break_the_neighborhood(self):
        result = fetch_neighborhood(
            doi="10.0/center",
            fetch=make_fetch([], s2=False),
        )

        self.assertTrue(result["ok"])
        # Semantic Scholar is down; every other provider still answers.
        self.assertEqual(
            result["sources"],
            ["openalex", "crossref", "open_citations", "europe_pmc"],
        )
        self.assertEqual(
            result["sources_skipped"], {"semantic_scholar": "unavailable"}
        )
        self.assertIn("W1", {w["work_id"] for w in result["prior_works"]})
        self.assertIn("W3", {w["work_id"] for w in result["derivative_works"]})

    def test_sources_flag_restricts_to_openalex(self):
        urls = []
        result = fetch_neighborhood(
            doi="10.0/center",
            fetch=make_fetch(urls),
            sources=(),
        )

        self.assertTrue(all("api.openalex.org" in u for u in urls))
        self.assertEqual(result["sources"], ["openalex"])
        self.assertEqual(
            {w["work_id"] for w in result["prior_works"]}, {"W1"}
        )

    def test_the_semantic_scholar_doi_keeps_its_slash(self):
        # Semantic Scholar routes DOI:<doi> as a path segment and does
        # not decode %2F, so an encoded slash silently resolves to
        # nothing -- and answers 429, not 404, which hides the mistake
        # behind the rate-limit branch. This pins the literal slash.
        urls = []
        fetch_neighborhood(doi="10.0/center", fetch=make_fetch(urls))

        s2_resolves = [
            u for u in urls if "api.semanticscholar.org" in u and "/paper/DOI:" in u
        ]
        self.assertTrue(s2_resolves)
        self.assertIn("DOI:10.0/center", s2_resolves[0])
        self.assertNotIn("%2F", s2_resolves[0])

    def test_doi_is_sanitised_before_use(self):
        urls = []
        fetch_neighborhood(
            doi="10.0/x?evil=1#frag",
            fetch=make_fetch(urls),
        )

        self.assertIn("%3F", urls[0])
        self.assertNotIn("?evil", urls[0])

    def test_falls_back_to_work_id_after_doi_404(self):
        urls = []
        result = fetch_neighborhood(
            doi="10.0/unknown",
            work_id="W100",
            fetch=make_fetch(urls, doi_404=True),
        )

        self.assertTrue(result["ok"])
        self.assertTrue(any("/W100?" in u for u in urls))

    def test_invalid_work_id_is_ignored(self):
        urls = []
        result = fetch_neighborhood(
            work_id="../../evil",
            fetch=make_fetch(urls),
        )

        self.assertEqual(result, {"ok": False, "reason": "no_doi"})
        self.assertEqual(urls, [])

    def test_title_lookup_accepts_exact_title(self):
        urls = []
        result = fetch_neighborhood(
            title="Attention is all you need",
            fetch=make_fetch(urls, search_results=[ROOT]),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["work_id"], "W100")

    def test_title_lookup_rejects_a_different_paper(self):
        result = fetch_neighborhood(
            title="Attention is all you need",
            fetch=make_fetch(
                [], search_results=[_work("W7", "Cooking with gas", 1)]
            ),
        )

        self.assertFalse(result["ok"])
        self.assertNotIn("detail", result)

    def test_nothing_to_resolve(self):
        self.assertEqual(
            fetch_neighborhood(fetch=make_fetch([])),
            {"ok": False, "reason": "no_doi"},
        )

    def test_unknown_doi_without_fallback_is_not_an_error(self):
        result = fetch_neighborhood(
            doi="10.0/unknown",
            fetch=make_fetch([], doi_404=True),
        )

        self.assertFalse(result["ok"])
        self.assertNotIn("detail", result)

    def test_network_failure_is_reported(self):
        def failing(_url):
            raise OSError("down")

        result = fetch_neighborhood(doi="10.0/x", fetch=failing)

        self.assertFalse(result["ok"])
        self.assertIn("detail", result)


class WebResultEndpointTest(unittest.TestCase):
    def test_unresolved_is_an_empty_200(self):
        with mock.patch.object(
            api,
            "fetch_neighborhood",
            return_value={"ok": False, "reason": "no_doi"},
        ):
            body = api.web_result_connections(
                doi=None, title=None, work_id=None, sources=None
            )

        self.assertTrue(body["ok"])
        self.assertFalse(body["resolved"])
        self.assertEqual(body["prior_works"], [])
        self.assertEqual(body["derivative_works"], [])

    def test_resolved_passes_through(self):
        with mock.patch.object(
            api,
            "fetch_neighborhood",
            return_value={"ok": True, "prior_works": [], "derivative_works": []},
        ):
            body = api.web_result_connections(
                doi="10.0/x", title=None, work_id=None, sources=None
            )

        self.assertTrue(body["resolved"])

    def test_network_failure_is_502(self):
        with mock.patch.object(
            api,
            "fetch_neighborhood",
            return_value={"ok": False, "reason": "lookup_failed", "detail": "x"},
        ):
            with self.assertRaises(HTTPException) as caught:
                api.web_result_connections(
                doi="10.0/x", title=None, work_id=None, sources=None
            )

        self.assertEqual(caught.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()


class ExtraSourceTest(unittest.TestCase):
    """OpenCitations and Europe PMC, offline through the fetch seam."""

    DOI = "10.0/center"

    def fetch(self, url):
        self.urls.append(url)

        if "opencitations.net" in url:
            return [
                {
                    "cited": "omid:br/1 doi:10.0/ocref openalex:W9 pmid:2",
                    # `creation` is the citing entity's date, NOT the
                    # reference's year -- reading it as one is the trap.
                    "creation": "2015-05-27",
                },
                {"cited": "openalex:W8"},
            ]

        if "ebi.ac.uk" in url and "/search?" in url:
            return {
                "resultList": {
                    "result": [
                        {"id": "26017442", "source": "MED", "doi": self.DOI}
                    ]
                }
            }

        if "ebi.ac.uk" in url and "/references?" in url:
            return {
                "referenceList": {
                    "reference": [
                        {
                            "id": "1",
                            "source": "MED",
                            "title": "EPMC Reference",
                            "authorString": "Smith J, Doe A",
                            "pubYear": "2011",
                        }
                    ]
                }
            }

        if "ebi.ac.uk" in url and "/citations?" in url:
            return {
                "citationList": {
                    "citation": [
                        {
                            "id": "2",
                            "source": "MED",
                            "title": "EPMC Citer",
                            "authorString": "Lee K",
                            "pubYear": "2020",
                        }
                    ]
                }
            }

        raise AssertionError(f"unexpected URL: {url}")

    def setUp(self):
        self.urls = []

    def test_opencitations_gives_references_only(self):
        from app.services.web_connections_extra import (
            fetch_opencitations_references,
        )

        result = fetch_opencitations_references(doi=self.DOI, fetch=self.fetch)

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["prior_works"]), 2)
        self.assertEqual(result["derivative_works"], [])

        # A row with no title is still a row: the union fills it from
        # whichever other source knows the work.
        row = result["prior_works"][0]
        self.assertIsNone(row["title"])
        self.assertEqual(row["doi"], "10.0/ocref")
        self.assertEqual(row["sources"], ["open_citations"])

    def test_opencitations_never_reads_the_citation_date_as_a_year(self):
        from app.services.web_connections_extra import (
            fetch_opencitations_references,
        )

        result = fetch_opencitations_references(doi=self.DOI, fetch=self.fetch)

        for row in result["prior_works"]:
            self.assertIsNone(row["publication_year"])

    def test_opencitations_never_calls_the_unpaginated_citations_endpoint(self):
        from app.services.web_connections_extra import (
            fetch_opencitations_references,
        )

        fetch_opencitations_references(doi=self.DOI, fetch=self.fetch)

        self.assertTrue(all("/references/" in u for u in self.urls))
        self.assertFalse(any("/citations/" in u for u in self.urls))

    def test_opencitations_falls_back_to_an_openalex_id(self):
        from app.services.web_connections_extra import (
            fetch_opencitations_references,
        )

        result = fetch_opencitations_references(doi=self.DOI, fetch=self.fetch)
        bare = result["prior_works"][1]

        self.assertEqual(bare["work_id"], "oc:W8")
        self.assertIsNone(bare["doi"])

    def test_europe_pmc_does_not_quote_the_doi(self):
        # `DOI:"10.0/x"` is parsed by Europe PMC as a literal phrase
        # and matches nothing -- verified live: the quoted form returns
        # 0 hits, the bare form 1. The slash MAY be percent-encoded
        # (unlike Semantic Scholar, which does not decode %2F and needs
        # it literal); what must never appear is a pair of quotes.
        from app.services.web_connections_extra import (
            fetch_europepmc_neighborhood,
        )

        fetch_europepmc_neighborhood(doi=self.DOI, fetch=self.fetch)

        search = next(u for u in self.urls if "/search?" in u)
        self.assertNotIn("%22", search)
        self.assertNotIn('"', search)
        # Whatever the encoding, the query has to round-trip to the
        # bare DOI once the server decodes it.
        from urllib.parse import unquote

        self.assertIn("DOI:10.0/center", unquote(search))

    def test_europe_pmc_returns_both_sides_with_metadata(self):
        from app.services.web_connections_extra import (
            fetch_europepmc_neighborhood,
        )

        result = fetch_europepmc_neighborhood(doi=self.DOI, fetch=self.fetch)

        self.assertTrue(result["ok"])
        self.assertEqual(result["paper_id"], "MED/26017442")

        prior = result["prior_works"][0]
        self.assertEqual(prior["title"], "EPMC Reference")
        self.assertEqual(prior["publication_year"], 2011)
        self.assertEqual(prior["author"], "Smith J, Doe A")
        self.assertEqual(prior["work_id"], "epmc:MED:1")

        derivative = result["derivative_works"][0]
        self.assertEqual(derivative["title"], "EPMC Citer")

    def test_europe_pmc_missing_record_is_not_an_error(self):
        from app.services.web_connections_extra import (
            fetch_europepmc_neighborhood,
        )

        def empty(url):
            return {"resultList": {"result": []}}

        result = fetch_europepmc_neighborhood(doi=self.DOI, fetch=empty)

        self.assertFalse(result["ok"])
        self.assertEqual(result["prior_works"] if "prior_works" in result else [], [])

    def test_europe_pmc_drops_a_row_with_no_title(self):
        from app.services.web_connections_extra import _epmc_entry

        self.assertIsNone(_epmc_entry({"id": "1", "source": "MED", "title": None}))
        self.assertIsNone(_epmc_entry({"id": "", "source": "MED", "title": "x"}))

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, Paper, PaperCitation
from app.services import literature_gather as gather
from app.services.evaluation import loo_qrels

ABSTRACT = {"word%d" % i: [i] for i in range(40)}  # 40 words


TITLES = {
    100: "Quantum error correction in superconducting circuits",
    101: "Deep reinforcement learning for robotic locomotion",
    102: "Soil microbiome responses to long-term drought",
    103: "A survey of consensus protocols in distributed ledgers",
    200: "Photosynthetic efficiency of marine diatoms under acidification",
}


def _work(n, abstract=True, title=None):
    return {
        "id": f"https://openalex.org/W{n}",
        "doi": f"https://doi.org/10.9/ref{n}",
        "display_name": title or TITLES[n],
        "publication_year": 2019,
        "type": "article",
        "cited_by_count": n,
        "authorships": [{"author": {"display_name": f"Author {n}"}}],
        "abstract_inverted_index": ABSTRACT if abstract else None,
    }


class GatherTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.seeds = []
        for s in range(3):
            paper = Paper(
                title=f"Local seed paper {s} with its own words {s * 17}",
                author="A",
                abstract="a seed abstract",
                doi=f"10.1/seed{s}",
            )
            self.db.add(paper)
            self.db.flush()
            self.seeds.append(paper)
            for w in range(100, 104):  # all seeds cite W100..W103
                self.db.add(PaperCitation(
                    paper_id=paper.id, direction="cites",
                    external_work_id=f"W{w}",
                ))
        # W200 cited by one seed only
        self.db.add(PaperCitation(
            paper_id=self.seeds[0].id, direction="cites", external_work_id="W200"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _fetch(self, works):
        calls = []

        def fetch(url):
            calls.append(url)
            wanted = url.split("openalex_id:")[1].split("&")[0].split("|")
            return {"results": [w for w in works if w["id"].split("/")[-1] in wanted]}

        fetch.calls = calls
        return fetch

    def test_most_cited_first_and_references_resolve(self):
        works = [_work(n) for n in (100, 101, 102, 103, 200)]
        fetch = self._fetch(works)
        out = gather.gather_cited_works(self.db, limit=300, fetch=fetch)

        self.assertEqual(out["added"], 5)
        self.assertEqual(out["unresolved_references"], 5)
        self.assertEqual(out["rows_linked"], 3 * 4 + 1)
        self.assertIn("W100|W101|W102|W103|W200", fetch.calls[0])

        added = self.db.query(Paper).filter_by(extraction_method="openalex-gather").count()
        self.assertEqual(added, 5)

        # The seeds now qualify as leave-one-out queries.
        queries = loo_qrels.build_loo_queries(self.db, min_refs=3)
        self.assertEqual(len(queries), 3)
        self.assertEqual([q.n_refs for q in queries], [5, 4, 4])

    def test_limit_is_respected(self):
        works = [_work(n) for n in (100, 101, 102, 103, 200)]
        out = gather.gather_cited_works(self.db, limit=2, fetch=self._fetch(works))
        self.assertEqual(out["added"], 2)
        self.assertEqual(self.db.query(Paper).filter_by(extraction_method="openalex-gather").count(), 2)

    def test_no_abstract_is_skipped(self):
        works = [_work(100, abstract=False), _work(101)]
        out = gather.gather_cited_works(self.db, fetch=self._fetch(works))
        self.assertEqual(out["added"], 1)
        self.assertEqual(out["skipped_no_abstract"], 1)

    def test_existing_paper_is_linked_not_duplicated(self):
        existing = Paper(title=TITLES[100],
                         author="X", abstract="x", doi="10.9/ref100")
        self.db.add(existing)
        self.db.commit()

        out = gather.gather_cited_works(self.db, fetch=self._fetch([_work(100)]))
        self.assertEqual(out["added"], 0)
        self.assertEqual(out["already_in_library"], 1)
        matched = {r.matched_paper_id for r in
                   self.db.query(PaperCitation).filter_by(external_work_id="W100")}
        self.assertEqual(matched, {existing.id})

    def test_failed_batch_is_reported(self):
        def boom(url):
            raise OSError("offline")

        out = gather.gather_cited_works(self.db, fetch=boom)
        self.assertEqual(out["failed_batches"], 1)
        self.assertEqual(out["added"], 0)

    def test_rerun_is_idempotent(self):
        works = [_work(n) for n in (100, 101, 102, 103, 200)]
        gather.gather_cited_works(self.db, fetch=self._fetch(works))
        again = gather.gather_cited_works(self.db, fetch=self._fetch(works))
        self.assertEqual(again["added"], 0)
        self.assertEqual(again["unresolved_references"], 0)

    def test_bad_limit(self):
        with self.assertRaises(ValueError):
            gather.gather_cited_works(self.db, limit=0)



class GatherJobApiTest(unittest.TestCase):
    def test_job_runs_in_background_and_reports_progress(self):
        import time
        from unittest import mock

        from fastapi.testclient import TestClient

        from app import api

        def fake_gather(db, *, limit, on_progress=None, **_):
            summary = {
                "unresolved_references": 4, "considered": 2, "added": 2,
                "already_in_library": 0, "skipped_no_abstract": 0,
                "failed_batches": 0, "rows_linked": 5, "limit": limit,
            }
            on_progress(summary, 0, 2, "First paper")
            on_progress(summary, 1, 2, "Second paper")
            return summary

        rebuilt = []
        client = TestClient(api.app)

        fake_expand = lambda db, on_progress=None, **_: {
            "papers_considered": 3, "papers_expanded": 3, "rows_added": 90,
            "failed_batches": 0, "not_found": 0,
        }

        with mock.patch.object(api, "gather_cited_works", fake_gather), \
             mock.patch.object(api, "expand_references", fake_expand), \
             mock.patch.object(api, "link_reference_rows", lambda db: {}), \
             mock.patch.object(api, "rebuild_recommendation_data", lambda: rebuilt.append(1)), \
             mock.patch.object(api, "set_recommendation_index_stale", lambda stale: None), \
             mock.patch.object(api, "SessionLocal", lambda: mock.MagicMock()):
            started = client.post("/api/citations/gather-literature", json={"limit": 10})
            self.assertEqual(started.status_code, 200)

            status = {}
            for _ in range(50):
                status = client.get("/api/citations/gather-literature/status").json()
                if status["state"] != "running":
                    break
                time.sleep(0.05)

        self.assertEqual(status["state"], "done")
        self.assertEqual(status["added"], 2)
        self.assertEqual(status["recent"], ["First paper", "Second paper"])
        self.assertTrue(status["summary"]["index_rebuilt"])
        self.assertEqual(rebuilt, [1])
        self.assertIn("elapsed", status)

    def test_bad_limit_and_concurrent_start(self):
        from fastapi.testclient import TestClient

        from app import api

        client = TestClient(api.app)
        self.assertEqual(
            client.post("/api/citations/gather-literature", json={"limit": 0}).status_code, 400
        )

        api._gather_update(state="running")
        try:
            self.assertEqual(
                client.post("/api/citations/gather-literature", json={"limit": 5}).status_code, 409
            )
        finally:
            api._gather_update(state="idle")



class ExpandReferencesTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.gathered = Paper(
            title="A gathered paper about ocean currents and tides",
            author="A", abstract="x", doi="10.5/g",
            source_filename="openalex:W500", extraction_method="openalex-gather")
        self.plain = Paper(
            title="A plain paper about forest canopy ecology study",
            author="B", abstract="y", doi="10.5/p")
        self.nodoi = Paper(title="No identifier here at all just text", author="C", abstract="z")
        self.local_ref = Paper(
            title="Locally present cited paper on glacier retreat rates",
            author="D", abstract="w", doi="10.5/r",
            source_filename="openalex:W900", extraction_method="openalex-gather")
        self.db.add_all([self.gathered, self.plain, self.nodoi, self.local_ref])
        self.db.flush()
        # local_ref already has references cached, so it is not expanded.
        self.db.add(PaperCitation(paper_id=self.local_ref.id, direction="cites",
                                  external_work_id="W1"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _fetch(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if "openalex_id:" in url:
                return {"results": [{
                    "id": "https://openalex.org/W500",
                    "referenced_works": [
                        "https://openalex.org/W900", "https://openalex.org/W901",
                        "https://openalex.org/W901",
                    ]}]}
            return {"results": [{
                "id": "https://openalex.org/W600", "doi": "https://doi.org/10.5/p",
                "referenced_works": ["https://openalex.org/W902"]}]}

        fetch.calls = calls
        return fetch

    def test_expands_gathered_by_work_id_and_others_by_doi(self):
        fetch = self._fetch()
        out = gather.expand_references(self.db, fetch=fetch)

        self.assertEqual(out["papers_considered"], 2)  # nodoi and local_ref excluded
        self.assertEqual(out["papers_expanded"], 2)
        self.assertEqual(out["rows_added"], 3)  # duplicate W901 collapsed
        self.assertTrue(any("openalex_id:W500" in u for u in fetch.calls))
        self.assertTrue(any("doi:10.5/p" in u for u in fetch.calls))

        rows = {(r.paper_id, r.external_work_id)
                for r in self.db.query(PaperCitation).filter_by(direction="cites")}
        self.assertIn((self.gathered.id, "W900"), rows)
        self.assertIn((self.plain.id, "W902"), rows)

    def test_links_to_gathered_papers_without_network(self):
        from app.services import citations

        gather.expand_references(self.db, fetch=self._fetch())
        # No DOI lookups wanted: every network call here would fail.
        def no_network(url):
            raise AssertionError("unexpected network call")

        only_gathered = citations.gathered_work_map(self.db)
        self.assertEqual(only_gathered["W900"], self.local_ref.id)

        # plain paper's DOI lookup is the only network need; fail it quietly.
        result = citations.link_reference_rows(self.db, fetch=lambda url: {"results": []})
        self.assertTrue(result["ok"])
        row = (self.db.query(PaperCitation)
               .filter_by(paper_id=self.gathered.id, external_work_id="W900").one())
        self.assertEqual(row.matched_paper_id, self.local_ref.id)

    def test_idempotent_and_failed_batch(self):
        gather.expand_references(self.db, fetch=self._fetch())
        again = gather.expand_references(self.db, fetch=self._fetch())
        self.assertEqual(again["papers_considered"], 0)

        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        db2 = sessionmaker(bind=engine)()
        db2.add(Paper(title="Another gathered one about volcanic ash plumes",
                      author="E", abstract="v", source_filename="openalex:W700",
                      extraction_method="openalex-gather"))
        db2.commit()

        def boom(url):
            raise OSError("offline")

        out = gather.expand_references(db2, fetch=boom)
        self.assertEqual(out["failed_batches"], 1)
        self.assertEqual(out["papers_expanded"], 0)

    def test_bad_limit(self):
        with self.assertRaises(ValueError):
            gather.expand_references(self.db, limit=0)


if __name__ == "__main__":
    unittest.main()

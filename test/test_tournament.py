"""Tournament runner and API, with the search engine stubbed."""

import os
import tempfile
import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import (
    Base,
    Paper,
    PaperCitation,
    TournamentQueryScore,
    TournamentRun,
)
from app.services.evaluation import loo_qrels, tournament


def _hit(paper_id):
    return {"paper": SimpleNamespace(id=paper_id), "score": 1.0}


def _build_db(n_seeds=14):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    counter = 0

    for s in range(n_seeds):
        seed = Paper(
            title=f"Seed paper number {s} on topic {s * 7}",
            author="A",
            abstract=f"abstract {s}",
            publication_year=2015 + s % 5,
        )
        db.add(seed)
        db.flush()
        for r in range(4):
            ref = Paper(title=f"Reference {s}-{r} of unique things {r * 13}", author="B")
            db.add(ref)
            db.flush()
            counter += 1
            db.add(
                PaperCitation(
                    paper_id=seed.id,
                    direction="cites",
                    external_work_id=f"W{counter}",
                    matched_paper_id=ref.id,
                )
            )
    db.commit()
    return db


def _stub_search(quality):
    """quality[pipeline] -> fraction of the relevant set it returns
    (in rank order), padded with junk. The seed itself is always
    returned first, to prove the runner removes it."""

    queries = {}

    def search(*, db, query, seed_paper_id, pipeline, top_k, custom_weights):
        if not queries:
            for q in loo_qrels.build_loo_queries(db, min_refs=1):
                queries[q.query] = q

        q = queries[query]
        relevant = sorted(q.relevance)
        take = int(round(len(relevant) * quality[pipeline]))
        ids = [q.seed_paper_id] + relevant[:take] + list(range(9000, 9030))
        return [_hit(i) for i in ids][:top_k]

    return search


QUALITY = {
    "tfidf": 1.0,
    "sbert": 0.5,
    "tfidf_sbert": 0.25,
}


class TournamentRunnerTest(unittest.TestCase):
    def setUp(self):
        self.db = _build_db()

    def tearDown(self):
        self.db.close()

    def test_clear_winner_and_persisted_scores(self):
        result = tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert", "tfidf_sbert"],
            n_queries=14,
            resamples=300,
            run_search=_stub_search(QUALITY),
        )

        verdict = result["verdict"]
        self.assertEqual(result["n_queries"], 14)
        self.assertEqual(verdict["winner"], "tfidf")
        self.assertEqual(verdict["outcome"], "winner")
        self.assertEqual(verdict["ranking"][0]["pipeline"], "tfidf")

        run = self.db.get(TournamentRun, result["run_id"])
        self.assertEqual(run.outcome, "winner")
        self.assertEqual(run.winner_pipeline_id, "tfidf")
        rows = (
            self.db.query(TournamentQueryScore)
            .filter_by(run_id=run.id)
            .count()
        )
        self.assertEqual(rows, 14 * 3)

    def test_seed_is_removed_from_candidates(self):
        # tfidf returns the seed first; with exclusion the perfect
        # relevant-first ranking still scores nDCG = 1.0.
        result = tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert"],
            n_queries=14,
            resamples=100,
            record=False,
            run_search=_stub_search(QUALITY),
        )
        top = result["verdict"]["ranking"][0]
        self.assertEqual(top["pipeline"], "tfidf")
        self.assertAlmostEqual(top["mean"], 1.0)

    def test_record_false_writes_nothing(self):
        tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert"],
            n_queries=14,
            resamples=100,
            record=False,
            run_search=_stub_search(QUALITY),
        )
        self.assertEqual(self.db.query(TournamentRun).count(), 0)

    def test_equal_pipelines_never_get_a_winner(self):
        result = tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert"],
            n_queries=14,
            resamples=200,
            record=False,
            run_search=_stub_search({"tfidf": 0.5, "sbert": 0.5}),
        )
        self.assertIsNone(result["verdict"]["winner"])

    def test_failing_query_is_dropped_and_reported(self):
        good = _stub_search(QUALITY)
        calls = {"n": 0}

        def flaky(**kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom")
            return good(**kwargs)

        result = tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert"],
            n_queries=14,
            resamples=100,
            record=False,
            run_search=flaky,
        )
        self.assertEqual(len(result["dropped"]), 1)
        self.assertEqual(result["n_queries"], 13)

    def test_validation(self):
        search = _stub_search(QUALITY)
        with self.assertRaises(ValueError):
            tournament.run_tournament(self.db, pipelines=["tfidf"], run_search=search)
        with self.assertRaises(ValueError):
            tournament.run_tournament(self.db, pipelines=["tfidf", "nope"], run_search=search)
        with self.assertRaises(ValueError):
            tournament.run_tournament(self.db, pipelines=["tfidf", "custom"], run_search=search)
        with self.assertRaises(ValueError):
            tournament.run_tournament(self.db, primary_metric="bogus", run_search=search)
        with self.assertRaises(ValueError):
            tournament.run_tournament(self.db, n_queries=0, run_search=search)

    def test_empty_repository_explains_itself(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        empty = sessionmaker(bind=engine)()
        with self.assertRaises(ValueError) as ctx:
            tournament.run_tournament(
                empty, pipelines=["tfidf", "sbert"],
                run_search=_stub_search(QUALITY),
            )
        self.assertIn("resolved references", str(ctx.exception))

    def test_pool_count(self):
        info = tournament.eligible_query_count(self.db, 3)
        self.assertEqual(info["available"], 14)
        self.assertEqual(info["required_n_for_0_05"], 126)


class TournamentApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app.database as database

        cls.tmp = tempfile.mkdtemp()
        cls.engine = create_engine(
            f"sqlite:///{os.path.join(cls.tmp, 't.db')}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(cls.engine)
        cls.Session = sessionmaker(bind=cls.engine)

        seed = cls.Session()
        template = _build_db()
        for paper in template.query(Paper).all():
            seed.add(Paper(id=paper.id, title=paper.title, author=paper.author,
                           abstract=paper.abstract, publication_year=paper.publication_year))
        seed.flush()
        for row in template.query(PaperCitation).all():
            seed.add(PaperCitation(paper_id=row.paper_id, direction=row.direction,
                                   external_work_id=row.external_work_id,
                                   matched_paper_id=row.matched_paper_id))
        seed.commit()
        seed.close()
        template.close()

        from fastapi.testclient import TestClient
        from app import api

        def override():
            db = cls.Session()
            try:
                yield db
            finally:
                db.close()

        api.app.dependency_overrides[api.get_session] = override
        cls.api = api
        cls.client = TestClient(api.app)

    @classmethod
    def tearDownClass(cls):
        cls.api.app.dependency_overrides.clear()

    def test_pool_run_history_and_detail(self):
        pool = self.client.get("/api/evaluation/tournament/pool?min_refs=3")
        self.assertEqual(pool.status_code, 200)
        self.assertEqual(pool.json()["available"], 14)

        original = tournament._default_search
        tournament._default_search = lambda: _stub_search(QUALITY)
        try:
            response = self.client.post(
                "/api/evaluation/tournament",
                json={"pipelines": ["tfidf", "sbert", "tfidf_sbert"],
                      "n_queries": 14, "label": "api test"},
            )
        finally:
            tournament._default_search = original

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["verdict"]["winner"], "tfidf")
        run_id = body["run_id"]

        history = self.client.get("/api/evaluation/tournament/history").json()
        newest = history["runs"][0]
        self.assertGreaterEqual(history["total"], 1)
        self.assertEqual(newest["id"], run_id)
        self.assertEqual(newest["label"], "api test")

        detail = self.client.get(f"/api/evaluation/tournament/{run_id}").json()
        self.assertEqual(len(detail["query_scores"]), 14 * 3)
        self.assertEqual(detail["verdict"]["winner"], "tfidf")

    def test_export_endpoint(self):
        original = tournament._default_search
        tournament._default_search = lambda: _stub_search(QUALITY)
        try:
            body = self.client.post(
                "/api/evaluation/tournament",
                json={"pipelines": ["tfidf", "sbert"], "n_queries": 14},
            ).json()
        finally:
            tournament._default_search = original

        url = f"/api/evaluation/tournament/{body['run_id']}/export"
        csv_response = self.client.get(url + "?format=csv")
        self.assertEqual(csv_response.status_code, 200)
        self.assertIn("attachment; filename=", csv_response.headers["content-disposition"])
        self.assertEqual(len(csv_response.text.strip().splitlines()), 1 + 14 * 2)
        self.assertEqual(self.client.get(url + "?format=bad").status_code, 400)
        self.assertEqual(
            self.client.get("/api/evaluation/tournament/9999/export").status_code, 404
        )

    def test_bad_requests(self):
        self.assertEqual(
            self.client.post("/api/evaluation/tournament",
                             json={"pipelines": ["tfidf"]}).status_code, 400)
        self.assertEqual(
            self.client.get("/api/evaluation/tournament/9999").status_code, 404)



class TournamentExportTest(unittest.TestCase):
    def setUp(self):
        self.db = _build_db()
        self.result = tournament.run_tournament(
            self.db,
            pipelines=["tfidf", "sbert", "tfidf_sbert"],
            n_queries=14,
            resamples=100,
            run_search=_stub_search(QUALITY),
        )

    def _detail(self):
        import json as _json

        run = self.db.get(TournamentRun, self.result["run_id"])
        detail = _json.loads(run.result_json)
        detail["run_id"] = run.id
        detail["query_scores"] = [
            {
                "pipeline_id": r.pipeline_id,
                "seed_paper_id": r.seed_paper_id,
                "num_relevant": r.num_relevant,
                "ndcg": r.ndcg, "mrr": r.mrr, "recall": r.recall, "hit": r.hit,
            }
            for r in self.db.query(TournamentQueryScore).filter_by(run_id=run.id)
        ]
        return detail

    def test_result_is_strict_json(self):
        import json as _json

        # Constant gaps give an undefined d_z; it must be null, not Infinity.
        _json.dumps(self.result, allow_nan=False)

    def test_csv_rows_and_header(self):
        import csv as _csv, io as _io

        name, media, text = tournament.export_tournament(self._detail(), "csv")
        rows = list(_csv.reader(_io.StringIO(text)))
        self.assertEqual(rows[0], list(tournament.SCORE_COLUMNS))
        self.assertEqual(len(rows) - 1, 14 * 3)
        self.assertTrue(name.endswith("-scores.csv"))
        self.assertTrue(media.startswith("text/csv"))

    def test_pairwise_csv(self):
        import csv as _csv, io as _io

        _, _, text = tournament.export_tournament(self._detail(), "pairwise")
        rows = list(_csv.reader(_io.StringIO(text)))
        self.assertEqual(rows[0], list(tournament.PAIR_COLUMNS))
        self.assertEqual(len(rows) - 1, 3)  # 3 pipelines -> 3 pairs

    def test_json_round_trip_and_bad_format(self):
        import json as _json

        _, _, text = tournament.export_tournament(self._detail(), "json")
        self.assertEqual(_json.loads(text)["verdict"]["winner"], "tfidf")
        with self.assertRaises(ValueError):
            tournament.export_tournament(self._detail(), "xml")


if __name__ == "__main__":
    unittest.main()

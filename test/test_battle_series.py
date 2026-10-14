"""Explain-differences, streamed battles and battle series."""

import json
import os
import tempfile
import unittest
from unittest import mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, BattleRun, Paper, PaperCitation
from app.services.evaluation import battle_explain as ex
from app.services.evaluation import battle_series as bs
from app.services.recommendation import compare_service as cs


def row(pid, tf=0.0, sb=0.0, md=0.0):
    return {"paper_id": pid, "title": f"P{pid}", "year": 2020,
            "components": {"tfidf": tf, "sbert": sb, "metadata": md}}


class ExplainTest(unittest.TestCase):
    def test_needs_two_pipelines_with_results(self):
        self.assertIsNone(ex.explain_differences({"a": [row(1)], "b": []}))

    def test_contested_unanimous_and_unique(self):
        out = ex.explain_differences({
            "a": [row(1, tf=.5), row(2, tf=.4), row(3, tf=.3)],
            "b": [row(1, sb=.5), row(4, sb=.4)],
            "c": [row(1, md=.5), row(2, md=.4), row(5, md=.1)],
            "d": [row(1, tf=.5), row(2, tf=.4)],
        })
        self.assertEqual(out["union"], 5)
        self.assertEqual(out["shared_by_all"], 1)
        self.assertEqual([u["paper_id"] for u in out["unanimous"]], [1])
        # paper 2 is 3-vs-1: the most evenly split; 3, 4, 5 are 1-vs-3
        self.assertEqual(out["contested"][0]["paper_id"], 2)
        self.assertEqual(out["contested"][0]["out"], ["b"])
        self.assertEqual(out["contested_count"], 4)
        by = {p["id"]: p for p in out["pipelines"]}
        self.assertEqual([u["paper_id"] for u in by["a"]["unique"]], [3])
        self.assertEqual(by["b"]["unique"][0]["paper_id"], 4)

    def test_signal_mix_and_drivers(self):
        out = ex.explain_differences({
            "a": [row(1, tf=.6, sb=.2), row(2, tf=.2)],
            "b": [row(1, sb=.7), row(3, md=.3)],
        })
        by = {p["id"]: p for p in out["pipelines"]}
        self.assertEqual(by["a"]["dominant"], "tfidf")
        self.assertAlmostEqual(sum(by["a"]["signal_mix"].values()), 1.0, places=3)
        top = out["unanimous"][0]
        self.assertEqual(top["drivers"], {"a": "tfidf", "b": "sbert"})

    def test_results_without_components_still_explain(self):
        out = ex.explain_differences({"a": [{"paper_id": 1}], "b": [{"paper_id": 2}]})
        self.assertIsNone(out["pipelines"][0]["signal_mix"])
        self.assertEqual(out["contested_count"], 2)

    def test_limit(self):
        out = ex.explain_differences(
            {"a": [row(i) for i in range(1, 30)], "b": [row(i) for i in range(30, 60)]}, limit=3)
        self.assertEqual(len(out["contested"]), 3)


class CleanQueriesTest(unittest.TestCase):
    def test_dedupes_case_and_space_insensitively(self):
        out = bs.clean_queries("  Neural  nets \n\nneural nets\nGraph models\n")
        self.assertEqual(out["queries"], ["Neural nets", "Graph models"])
        self.assertEqual(out["duplicates_dropped"], 1)

    def test_limit_and_truncation_are_reported(self):
        out = bs.clean_queries([f"q{i}" for i in range(60)] + ["x" * 400], limit=50)
        self.assertEqual(len(out["queries"]), 50)
        self.assertEqual(out["over_limit"], 11)
        self.assertEqual(out["truncated"], 1)


def stored(shares, winner, decisive, query="q"):
    return {"query": query, "response_json": json.dumps(
        {"winner": {"pipeline_id": winner, "shares": shares, "decisive": decisive}})}


class SeriesSummaryTest(unittest.TestCase):
    def test_pools_agreement_and_counts_verdicts(self):
        rows = [stored({"a": .9, "b": .7}, "a", True, "q1"),
                stored({"a": .8, "b": .79}, "a", False, "q2"),
                stored({"a": .6, "b": .9}, "b", True, "q3"),
                {"query": "old", "response_json": None}]
        out = bs.series_summary(rows)
        self.assertEqual((out["n_battles"], out["n_queries"]), (4, 3))
        self.assertEqual((out["decisive"], out["too_close"], out["unscored"]), (2, 1, 1))
        a = next(r for r in out["agreement"] if r["pipeline"] == "a")
        self.assertAlmostEqual(a["mean"], (.9 + .8 + .6) / 3)
        self.assertEqual(a["decisive_wins"], 1)

    def test_empty(self):
        out = bs.series_summary([])
        self.assertEqual((out["n_battles"], out["agreement"]), (0, []))


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app import api

        path = os.path.join(tempfile.mkdtemp(), "series.db")
        cls.engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        Base.metadata.create_all(cls.engine)
        cls.Session = sessionmaker(bind=cls.engine, expire_on_commit=False)
        cls.api = api

        def override():
            db = cls.Session()
            try:
                yield db
            finally:
                db.close()

        api.app.dependency_overrides[api.get_session] = override
        cls.client = TestClient(api.app)

        with cls.Session() as db:
            for i in range(4):
                seed = Paper(title=f"Seed paper number {i} about topic {i * 13}", author="A",
                             abstract="abstract text", publication_year=2015 + i)
                db.add(seed); db.flush()
                ref = Paper(title=f"Reference {i} unrelated wording {i * 31}", author="B")
                db.add(ref); db.flush()
                db.add(PaperCitation(paper_id=seed.id, direction="cites",
                                     external_work_id=f"W{i}", matched_paper_id=ref.id))
            db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.api.app.dependency_overrides.clear()

    def test_sample_returns_seed_papers_with_references(self):
        out = self.client.get("/api/evaluation/battle-series/sample?n=3&seed=1").json()
        self.assertEqual(len(out["papers"]), 3)
        self.assertGreaterEqual(out["eligible"], 4)
        self.assertTrue(all(p["n_refs"] >= 1 for p in out["papers"]))
        again = self.client.get("/api/evaluation/battle-series/sample?n=3&seed=1").json()
        self.assertEqual(out, again)  # seeded: repeatable

    def test_queries_endpoint(self):
        out = self.client.post("/api/evaluation/battle-series/queries", json={"text": "a\nA\nb"}).json()
        self.assertEqual(out["queries"], ["a", "b"])

    def test_stream_emits_real_progress_then_the_full_response(self):
        def fake(**kw):
            yield ("start", ["tfidf", "sbert"])
            for pid in ("tfidf", "sbert"):
                yield ("pipeline", cs.PipelineBattle(
                    id=pid, results=[cs.RankedPaper(paper_id=1, title="T", year=2020, score=.5)]), 0.01)
            yield ("done", cs.CompareResponse(
                query="streamed", top_k=3,
                pipelines=[cs.PipelineBattle(id="tfidf", results=[]), cs.PipelineBattle(id="sbert", results=[])],
                consensus=[], pairwise=[],
                winner=cs.WinnerResult(pipeline_id="tfidf", metric="independence_weighted_consensus",
                                       value=.9, margin=.1, decisive=True, runner_up="sbert")))

        with mock.patch.object(self.api, "compare_pipelines_stream", fake), \
             mock.patch.object(self.api, "SessionLocal", self.Session):
            r = self.client.post("/api/recommendations/compare/stream",
                                 json={"query": "streamed", "top_k": 3, "run_label": "stream-test"})
        self.assertEqual(r.status_code, 200)
        events = [json.loads(line) for line in r.text.splitlines()]
        self.assertEqual([e["event"] for e in events], ["start", "pipeline", "pipeline", "done"])
        self.assertEqual(events[1]["id"], "tfidf")
        self.assertIsNotNone(events[-1]["response"]["battle_id"])
        with self.Session() as db:
            self.assertEqual(db.query(BattleRun).filter_by(run_label="stream-test").count(), 1)

    def test_stream_reports_errors_as_events_and_validation_as_http(self):
        def boom(**kw):
            yield ("start", ["tfidf"])
            raise ValueError("bad recipe")

        with mock.patch.object(self.api, "compare_pipelines_stream", boom), \
             mock.patch.object(self.api, "SessionLocal", self.Session):
            r = self.client.post("/api/recommendations/compare/stream", json={"query": "x"})
        events = [json.loads(line) for line in r.text.splitlines()]
        self.assertEqual(events[-1], {"event": "error", "detail": "bad recipe"})
        self.assertEqual(self.client.post("/api/recommendations/compare/stream", json={}).status_code, 400)

    def test_labels_and_summary(self):
        M = "independence_weighted_consensus"
        with self.Session() as db:
            for i, (decisive, share) in enumerate([(True, .9), (False, .8), (True, .7)]):
                resp = {"winner": {"pipeline_id": "a", "decisive": decisive, "shares": {"a": share, "b": .5}}}
                db.add(BattleRun(query=f"q{i}", top_k=3, winner_pipeline_id="a", winner_metric=M,
                                 winner_value=share, run_label="series-x", response_json=json.dumps(resp)))
            db.commit()
        labels = self.client.get("/api/evaluation/battle-series/labels").json()
        self.assertIn({"label": "series-x", "battles": 3}, [{k: v for k, v in l.items() if k != "last"} for l in labels])
        out = self.client.get("/api/evaluation/battle-series/summary", params={"label": "series-x"}).json()
        self.assertEqual((out["n_battles"], out["decisive"], out["too_close"]), (3, 2, 1))
        self.assertEqual(out["agreement"][0]["pipeline"], "a")
        empty = self.client.get("/api/evaluation/battle-series/summary", params={"label": "nope"}).json()
        self.assertEqual(empty["n_battles"], 0)


class StreamGeneratorTest(unittest.TestCase):
    def test_compare_pipelines_consumes_the_stream_and_carries_differences(self):
        def fake_run_one(**kw):
            pid = kw["pipeline"]
            ids = [1, 2, 3] if pid != "sbert" else [1, 9, 8]
            ranked = [cs.RankedPaper(paper_id=i, title=f"P{i}", score=.5,
                                     components={"tfidf": .3, "sbert": .1, "metadata": 0.0}) for i in ids]
            return {i: r for r, i in enumerate(ids, 1)}, {i: .5 for i in ids}, ranked

        with mock.patch.object(cs, "_run_one", fake_run_one):
            events = list(cs.compare_pipelines_stream(db=None, query="q", seed_paper_id=None, top_k=3))
            result = cs.compare_pipelines(db=None, query="q", seed_paper_id=None, top_k=3)

        kinds = [e[0] for e in events]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(kinds.count("pipeline"), len(cs.PIPELINE_ORDER))
        self.assertEqual(kinds[-1], "done")
        self.assertEqual(result.model_dump(), events[-1][1].model_dump())
        self.assertIsNotNone(result.differences)
        self.assertEqual(result.differences["pipelines"][0]["dominant"], "tfidf")


if __name__ == "__main__":
    unittest.main()

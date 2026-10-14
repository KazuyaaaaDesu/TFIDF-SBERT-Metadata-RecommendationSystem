"""Durable tournaments: background run, saved per query, resumable."""

import os
import tempfile
import threading
import time
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import (
    Base,
    Paper,
    PaperCitation,
    TournamentQueryScore,
    TournamentRun,
)
from app.services.evaluation import tournament, tournament_jobs as jobs

from test.test_tournament import QUALITY, _stub_search


def make_factory(n_seeds=12):
    path = os.path.join(tempfile.mkdtemp(), "jobs.db")
    engine = create_engine(
        f"sqlite:///{path}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    db = factory()
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
            db.add(PaperCitation(
                paper_id=seed.id, direction="cites",
                external_work_id=f"W{counter}", matched_paper_id=ref.id,
            ))

    db.commit()
    db.close()

    return factory


def wait_for(factory, run_id, states, timeout=20):
    deadline = time.time() + timeout

    while time.time() < deadline:
        with factory() as db:
            status = jobs.status_payload(db, db.get(TournamentRun, run_id))

        if status["status"] in states:
            return status

        time.sleep(0.02)

    raise AssertionError(f"run {run_id} never reached {states}: {status}")


PIPES = ["tfidf", "sbert", "tfidf_sbert"]


class DurableRunTest(unittest.TestCase):
    def setUp(self):
        self.factory = make_factory()

    def _create(self, **kw):
        with self.factory() as db:
            run = jobs.create_run(
                db, pipelines=PIPES, n_queries=12, resamples=100, **kw
            )
            return run.id

    def test_create_returns_immediately_with_a_saved_plan(self):
        run_id = self._create(label="plan")
        with self.factory() as db:
            run = db.get(TournamentRun, run_id)
            self.assertEqual(run.status, "interrupted")  # nothing started it
            self.assertEqual(run.progress_total, 12)
            self.assertEqual(run.outcome, "pending")
            self.assertEqual(db.query(TournamentQueryScore).count(), 0)

    def test_runs_to_completion_and_matches_a_one_shot_run(self):
        run_id = self._create()
        search = _stub_search(QUALITY)
        self.assertTrue(jobs.start_run(self.factory, run_id, run_search=search))
        status = wait_for(self.factory, run_id, {"done"})

        self.assertEqual(status["done"], 12)
        self.assertEqual(status["winner_pipeline_id"], "tfidf")
        self.assertEqual(status["outcome"], "winner")

        with self.factory() as db:
            stored = db.get(TournamentRun, run_id)
            self.assertEqual(
                db.query(TournamentQueryScore).filter_by(run_id=run_id).count(),
                12 * 3,
            )
            one_shot = tournament.run_tournament(
                db, pipelines=PIPES, n_queries=12, resamples=100,
                record=False, run_search=_stub_search(QUALITY),
            )
            import json
            saved = json.loads(stored.result_json)
            self.assertEqual(saved["verdict"]["ranking"], one_shot["verdict"]["ranking"])
            self.assertEqual(saved["run_id"], run_id)

    def test_stop_then_resume_scores_each_query_exactly_once(self):
        run_id = self._create()
        inner = _stub_search(QUALITY)
        calls = {"n": 0}

        def search(**kw):
            calls["n"] += 1
            if calls["n"] == 5 * 3:  # during the 5th query
                jobs.stop_run(run_id)
            return inner(**kw)

        jobs.start_run(self.factory, run_id, run_search=search)
        paused = wait_for(self.factory, run_id, {"interrupted"})

        self.assertTrue(0 < paused["done"] < 12)
        partial_rows = None
        with self.factory() as db:
            partial_rows = db.query(TournamentQueryScore).filter_by(run_id=run_id).count()
            self.assertEqual(partial_rows, paused["done"] * 3)
            self.assertEqual(db.get(TournamentRun, run_id).outcome, "pending")

        self.assertTrue(paused["partial_means"])  # live bars have data

        resumed_calls = {"n": 0}

        def counting(**kw):
            resumed_calls["n"] += 1
            return inner(**kw)

        jobs.start_run(self.factory, run_id, run_search=counting)
        done = wait_for(self.factory, run_id, {"done"})

        self.assertEqual(done["done"], 12)
        # Only the unscored queries were searched again (3 pipelines each).
        self.assertEqual(resumed_calls["n"], (12 - paused["done"]) * 3)

        with self.factory() as db:
            pairs = [
                (r.seed_paper_id, r.pipeline_id)
                for r in db.query(TournamentQueryScore).filter_by(run_id=run_id)
            ]
            self.assertEqual(len(pairs), len(set(pairs)), "a query was scored twice")
            self.assertEqual(len(pairs), 36)

    def test_server_restart_is_flagged_and_resumable(self):
        run_id = self._create()
        inner = _stub_search(QUALITY)
        seen = {"n": 0}

        def search(**kw):
            seen["n"] += 1
            if seen["n"] == 4 * 3:
                jobs.stop_run(run_id)
            return inner(**kw)

        jobs.start_run(self.factory, run_id, run_search=search)
        wait_for(self.factory, run_id, {"interrupted"})

        # Simulate the process dying mid-run: the row still says running.
        with self.factory() as db:
            db.get(TournamentRun, run_id).status = "running"
            db.commit()
            # No worker behind it -> reported as interrupted straight away.
            self.assertEqual(
                jobs.status_payload(db, db.get(TournamentRun, run_id))["status"],
                "interrupted",
            )
            self.assertEqual(jobs.mark_interrupted(db), 1)
            self.assertEqual(db.get(TournamentRun, run_id).status, "interrupted")

        jobs.start_run(self.factory, run_id, run_search=inner)
        self.assertEqual(wait_for(self.factory, run_id, {"done"})["done"], 12)

    def test_failed_queries_are_dropped_and_survive_a_resume(self):
        run_id = self._create()
        inner = _stub_search(QUALITY)
        state = {"n": 0}

        def flaky(**kw):
            state["n"] += 1
            if state["n"] == 1:
                raise RuntimeError("boom")
            if state["n"] == 6 * 3 + 1:
                jobs.stop_run(run_id)
            return inner(**kw)

        jobs.start_run(self.factory, run_id, run_search=flaky)
        paused = wait_for(self.factory, run_id, {"interrupted"})
        self.assertEqual(paused["dropped"], 1)

        jobs.start_run(self.factory, run_id, run_search=inner)
        done = wait_for(self.factory, run_id, {"done"})
        self.assertEqual(done["dropped"], 1)

        with self.factory() as db:
            import json
            saved = json.loads(db.get(TournamentRun, run_id).result_json)
            self.assertEqual(len(saved["dropped"]), 1)
            self.assertEqual(saved["n_queries"], 11)

    def test_unscorable_run_ends_in_error_not_a_hang(self):
        run_id = self._create()

        def always_fails(**kw):
            raise RuntimeError("no engine")

        jobs.start_run(self.factory, run_id, run_search=always_fails)
        status = wait_for(self.factory, run_id, {"error"})
        self.assertIn("could be scored", status["error"])

    def test_only_one_worker_per_run(self):
        run_id = self._create()
        gate = threading.Event()
        inner = _stub_search(QUALITY)

        def slow(**kw):
            gate.wait(5)
            return inner(**kw)

        self.assertTrue(jobs.start_run(self.factory, run_id, run_search=slow))
        self.assertFalse(jobs.start_run(self.factory, run_id, run_search=slow))
        gate.set()
        wait_for(self.factory, run_id, {"done"})

    def test_discard_only_unfinished_runs(self):
        run_id = self._create()
        with self.factory() as db:
            self.assertTrue(jobs.discard_run(db, run_id))
            self.assertIsNone(db.get(TournamentRun, run_id))

        done_id = self._create()
        jobs.start_run(self.factory, done_id, run_search=_stub_search(QUALITY))
        wait_for(self.factory, done_id, {"done"})
        with self.factory() as db:
            self.assertFalse(jobs.discard_run(db, done_id))

    def test_a_head_to_head_of_two_pipelines_runs_and_gets_a_verdict(self):
        with self.factory() as db:
            run = jobs.create_run(db, pipelines=["tfidf", "sbert"], n_queries=12, resamples=100)
            run_id = run.id

        jobs.start_run(self.factory, run_id, run_search=_stub_search(QUALITY))
        status = wait_for(self.factory, run_id, {"done"})

        self.assertEqual(status["done"], 12)
        self.assertEqual(status["winner_pipeline_id"], "tfidf")
        with self.factory() as db:
            import json as _json
            saved = _json.loads(db.get(TournamentRun, run_id).result_json)
            self.assertEqual(saved["verdict"]["omnibus"]["df"], 1)
            self.assertEqual(len(saved["verdict"]["pairwise"]), 1)
            self.assertEqual(
                db.query(TournamentQueryScore).filter_by(run_id=run_id).count(), 12 * 2
            )

    def test_reanalyze_recomputes_the_verdict_from_stored_scores(self):
        import json as _json

        run_id = self._create()
        jobs.start_run(self.factory, run_id, run_search=_stub_search(QUALITY))
        wait_for(self.factory, run_id, {"done"})

        with self.factory() as db:
            before = _json.loads(db.get(TournamentRun, run_id).result_json)
            run = db.get(TournamentRun, run_id)
            run.result_json = _json.dumps({"stale": True})  # an out-of-date analysis
            run.outcome = "tie"
            db.commit()

            self.assertTrue(jobs.reanalyze_run(db, run_id))
            run = db.get(TournamentRun, run_id)
            after = _json.loads(run.result_json)

            self.assertNotIn("stale", after)
            self.assertEqual(after["verdict"]["ranking"], before["verdict"]["ranking"])
            self.assertEqual(run.outcome, before["verdict"]["outcome"])
            self.assertEqual(run.status, "done")
            # scores were not touched
            self.assertEqual(
                db.query(TournamentQueryScore).filter_by(run_id=run_id).count(), 12 * 3
            )

    def test_a_run_saved_before_settings_existed_is_reanalysed_from_its_own_result(self):
        import json as _json

        run_id = self._create()
        jobs.start_run(self.factory, run_id, run_search=_stub_search(QUALITY))
        wait_for(self.factory, run_id, {"done"})

        with self.factory() as db:
            run = db.get(TournamentRun, run_id)
            original = _json.loads(run.result_json)
            run.settings_json = None            # as for runs from before durable jobs
            db.commit()

            self.assertTrue(jobs.reanalyze_run(db, run_id))
            again = _json.loads(db.get(TournamentRun, run_id).result_json)
            self.assertEqual(again["verdict"]["ranking"], original["verdict"]["ranking"])
            self.assertEqual(again["primary_metric"], original["primary_metric"])
            self.assertEqual(again["seed"], original["seed"])
            self.assertEqual(again["pipelines"], original["pipelines"])

    def test_reanalyze_refuses_unfinished_missing_and_legacy_runs(self):
        with self.factory() as db:
            unfinished = jobs.create_run(db, pipelines=PIPES, n_queries=12)
            self.assertFalse(jobs.reanalyze_run(db, unfinished.id))
            self.assertFalse(jobs.reanalyze_run(db, 99999))

            legacy = TournamentRun(
                kind="loo_citations", primary_metric="ndcg", top_k=10, n_queries=12,
                seed=0, pipelines="[]", outcome="tie", result_json="{}",
                status="done", settings_json=None,
            )
            db.add(legacy)
            db.commit()
            self.assertFalse(jobs.reanalyze_run(db, legacy.id))

    def test_the_per_run_cap_is_5000_queries(self):
        self.assertEqual(tournament.MAX_QUERIES, 5000)
        with self.factory() as db:
            with self.assertRaises(ValueError):
                jobs.create_run(db, pipelines=PIPES, n_queries=5001)
            # asking for more than the library holds simply uses them all
            run = jobs.create_run(db, pipelines=PIPES, n_queries=4000)
            self.assertEqual(run.progress_total, 12)
            jobs.discard_run(db, run.id)

    def test_validation_and_latest_unfinished(self):
        with self.factory() as db:
            with self.assertRaises(ValueError):
                jobs.create_run(db, pipelines=["tfidf"])
            with self.assertRaises(ValueError):
                jobs.create_run(db, pipelines=PIPES, n_queries=1)
            self.assertIsNone(jobs.latest_unfinished(db))
            run = jobs.create_run(db, pipelines=PIPES, n_queries=12)
            self.assertEqual(jobs.latest_unfinished(db).id, run.id)

    def test_eta_uses_busy_time_not_wall_clock(self):
        run_id = self._create()
        with self.factory() as db:
            run = db.get(TournamentRun, run_id)
            run.progress_done = 4
            run.busy_seconds = 8.0   # 2 s per query
            db.commit()
            payload = jobs.status_payload(db, run)
        self.assertEqual(payload["seconds_per_query"], 2.0)
        self.assertEqual(payload["eta_seconds"], 16)  # 8 left x 2 s


class DurableApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient

        from app import api

        cls.factory = make_factory()
        cls.api = api

        def override():
            db = cls.factory()
            try:
                yield db
            finally:
                db.close()

        api.app.dependency_overrides[api.get_session] = override
        cls.client = TestClient(api.app)

    @classmethod
    def tearDownClass(cls):
        cls.api.app.dependency_overrides.clear()

    def test_start_poll_active_and_conflicts(self):
        from unittest import mock

        from app.services.evaluation import tournament as t

        with mock.patch.object(t, "_default_search", lambda: _stub_search(QUALITY)), \
             mock.patch.object(self.api, "SessionLocal", self.factory):
            started = self.client.post(
                "/api/evaluation/tournament/start",
                json={"pipelines": PIPES, "n_queries": 12, "label": "durable"},
            )
            self.assertEqual(started.status_code, 200, started.text)
            run_id = started.json()["run_id"]
            self.assertIn(started.json()["status"], {"running", "done"})

            status = {}
            for _ in range(400):
                status = self.client.get(
                    f"/api/evaluation/tournament/{run_id}/status"
                ).json()
                if status["status"] != "running":
                    break
                time.sleep(0.02)

            self.assertEqual(status["status"], "done")
            self.assertEqual(status["done"], 12)

            # Finished runs are not "active"; resume refuses them.
            self.assertIsNone(self.client.get("/api/evaluation/tournament/active").json()["run"])
            self.assertEqual(
                self.client.post(f"/api/evaluation/tournament/{run_id}/resume").status_code, 409
            )

            detail = self.client.get(f"/api/evaluation/tournament/{run_id}").json()
            self.assertEqual(detail["verdict"]["winner"], "tfidf")

    def test_an_unfinished_run_is_not_served_as_a_result(self):
        from app.models.models import TournamentRun

        with self.factory() as db:
            run = jobs.create_run(db, pipelines=PIPES, n_queries=12)  # never started
            run_id = run.id

        for suffix in ("", "/export?format=csv"):
            response = self.client.get(f"/api/evaluation/tournament/{run_id}{suffix}")
            self.assertEqual(response.status_code, 409, suffix)
            self.assertIn("not finished", response.json()["detail"])

        # ...but its status is available.
        status = self.client.get(f"/api/evaluation/tournament/{run_id}/status")
        self.assertEqual(status.status_code, 200)
        with self.factory() as db:
            jobs.discard_run(db, run_id)

    def test_bad_requests(self):
        self.assertEqual(
            self.client.post("/api/evaluation/tournament/start",
                             json={"pipelines": ["tfidf"]}).status_code, 400)
        self.assertEqual(
            self.client.get("/api/evaluation/tournament/9999/status").status_code, 404)
        self.assertEqual(
            self.client.post("/api/evaluation/tournament/9999/resume").status_code, 404)
        self.assertEqual(
            self.client.delete("/api/evaluation/tournament/9999").status_code, 404)


if __name__ == "__main__":
    unittest.main()

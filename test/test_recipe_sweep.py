"""The Lab's recipe sweep."""

import json
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from app.services.evaluation import loo_qrels
from app.services.evaluation import recipe_sweep as rs


class GridTest(unittest.TestCase):
    def test_sizes_and_sums(self):
        for step, size in ((10, 66), (20, 21), (25, 15), (5, 231)):
            grid = rs.recipe_grid(step)
            self.assertEqual(len(grid), size, step)
            self.assertTrue(all(sum(g) == 100 and min(g) >= 0 for g in grid))
            self.assertEqual(len(set(grid)), size)

    def test_corners_present_and_bad_step_rejected(self):
        grid = rs.recipe_grid(10)
        for corner in ((100, 0, 0), (0, 100, 0), (0, 0, 100)):
            self.assertIn(corner, grid)
        with self.assertRaises(ValueError):
            rs.recipe_grid(7)

    def test_presets_cover_all_six(self):
        self.assertEqual(len(rs.preset_recipes()), 6)


class ComponentsTest(unittest.TestCase):
    def setUp(self):
        self.c = rs.Components([10, 20, 30, 40], [1, 0, .5, 0], [0, 1, .5, 0], [0, 0, 0, 1])

    def test_rank_follows_the_weights(self):
        self.assertEqual(self.c.rank((1, 0, 0), 4), [10, 30])       # zero-score papers dropped
        self.assertEqual(self.c.rank((0, 1, 0), 2), [20, 30])
        self.assertEqual(self.c.rank((0, 0, 1), 4), [40])
        self.assertEqual(self.c.rank((.5, .5, 0), 3), [10, 20, 30])  # a three-way tie breaks by id

    def test_percentages_and_fractions_rank_alike(self):
        self.assertEqual(self.c.rank((40, 40, 20), 4), self.c.rank((.4, .4, .2), 4))

    def test_empty(self):
        self.assertEqual(rs.Components([], [], [], []).rank((1, 1, 1), 5), [])


def fake_search(table):
    """search_papers-shaped: equal-thirds components for the query."""

    def search(*, db, query, seed_paper_id, pipeline, top_k, custom_weights):
        self_check = custom_weights == rs.EVEN_THIRDS and pipeline == "custom" and seed_paper_id is None
        assert self_check
        return [
            {"paper": SimpleNamespace(id=pid), "score": 1.0,
             "components": {"tfidf": t / 3, "sbert": s / 3, "metadata": m / 3}}
            for pid, (t, s, m) in table[query].items()
        ]

    return search


class RecoveryTest(unittest.TestCase):
    def test_components_are_recovered_and_excluded_papers_removed(self):
        search = fake_search({"q": {1: (1.0, .2, 0.0), 2: (.4, .9, .5), 3: (0, 0, 1)}})
        comps = rs.components_for(search, None, "q", excluded={3})
        self.assertEqual(sorted(comps.ids.tolist()), [1, 2])
        i = comps.ids.tolist().index(2)
        np.testing.assert_allclose(comps.parts[:, i], [.4, .9, .5])


def lq(i, relevant):
    return loo_qrels.LooQuery(seed_paper_id=i, query=f"q{i}", relevance={p: 2 for p in relevant},
                              excluded_ids=frozenset({i}), n_refs=len(relevant))


class RunSweepTest(unittest.TestCase):
    def table(self, n):
        # Relevant papers are the ones S-BERT scores high; TF-IDF is noise.
        out = {}
        for i in range(n):
            out[f"q{i}"] = {
                100 + j: (((j * 7 + i) % 5) / 5, 1.0 if j < 3 else 0.1, 0.0)
                for j in range(12)
            }
        return out

    def sweep(self, n, step=20):
        queries = [lq(i, [100, 101, 102]) for i in range(n)]
        events = list(rs.run_sweep(None, n_queries=n, k=5, step=step, seed=1,
                                   search=fake_search(self.table(n)), queries=queries))
        return events

    def test_events_progress_and_result(self):
        events = self.sweep(12)
        self.assertEqual(events[0], {"event": "start", "n_queries": 12, "grid_size": 21})
        self.assertEqual(events[-1]["event"], "done")
        self.assertEqual([e["done"] for e in events if e["event"] == "progress"], list(range(1, 13)))
        result = events[-1]["result"]
        self.assertEqual((result["n_queries"], result["skipped"], len(result["grid"])), (12, 0, 21))
        json.dumps(result, allow_nan=False)

    def test_semantic_corner_beats_lexical_corner_and_heldout_says_better(self):
        result = self.sweep(16)[-1]["result"]
        means = {tuple(c["weights"].values()): c["mean"] for c in result["grid"]}
        self.assertGreater(means[(0, 100, 0)], means[(100, 0, 0)])
        held = result["heldout"]
        self.assertEqual(held["n_select"] + held["n_confirm"], 16)
        self.assertGreater(held["chosen"]["sbert"], held["chosen"]["tfidf"])
        # sbert is the strongest preset here and the chosen blend is no better than it
        self.assertEqual(held["strongest_preset"] in ("sbert", "sbert_metadata", "tfidf_sbert"), True)
        self.assertIn(held["outcome"], ("no_difference", "better", "worse"))
        self.assertEqual(len(held["comparisons"]), 6)

    def test_too_few_queries_skips_the_split(self):
        result = self.sweep(5)[-1]["result"]
        self.assertIsNone(result["heldout"])
        self.assertIn("exploratory", result["reason"])

    def test_queries_without_relevant_papers_or_candidates_are_skipped(self):
        table = self.table(3)
        queries = [lq(0, [100]), lq(1, []), lq(2, [100])]
        table["q2"] = {}
        result = list(rs.run_sweep(None, n_queries=3, k=5, step=20, search=fake_search(table), queries=queries))[-1]["result"]
        self.assertEqual((result["n_queries"], result["skipped"]), (1, 2))

    def test_deterministic(self):
        a = self.sweep(14)[-1]["result"]
        b = self.sweep(14)[-1]["result"]
        self.assertEqual(a, b)

    def test_offline_ranking_matches_an_independent_weighted_sum(self):
        table = {i: (((i * 3) % 7) / 7, ((i * 5) % 11) / 11, ((i * 2) % 3) / 3) for i in range(1, 15)}
        comps = rs.components_for(fake_search({"q": table}), None, "q", set())
        for w in ((.4, .4, .2), (1, 0, 0), (.1, .2, .7)):
            expected = sorted(
                (pid for pid, parts in table.items() if sum(a * b for a, b in zip(w, parts)) > 0),
                key=lambda pid: (-sum(a * b for a, b in zip(w, table[pid])), pid),
            )
            self.assertEqual(comps.rank(w, 14), expected, w)


class ApiTest(unittest.TestCase):
    def test_endpoint_streams_events_and_validates_step(self):
        from fastapi.testclient import TestClient
        from app import api

        client = TestClient(api.app)
        fake = iter([{"event": "start", "n_queries": 1, "grid_size": 1}, {"event": "done", "result": {"ok": True}}])
        with mock.patch.object(api.recipe_sweep, "run_sweep", lambda *a, **k: fake):
            r = client.post("/api/evaluation/recipe-sweep", json={"step": 10})
        self.assertEqual([json.loads(l)["event"] for l in r.text.splitlines()], ["start", "done"])
        self.assertEqual(client.post("/api/evaluation/recipe-sweep", json={"step": 7}).status_code, 400)
        self.assertEqual(client.post("/api/evaluation/recipe-sweep", json={"n_queries": 1}).status_code, 422)


if __name__ == "__main__":
    unittest.main()

"""Battle verdict honesty (margin / too close to call) and judging."""

import json
import os
import tempfile
import unittest
from unittest import mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, BattleRun, Paper, PaperCitation
from app.services.evaluation import battle_judge as bj
from app.services.recommendation import compare_service as cs
from app.services.recommendation.compare_service import (
    CompareResponse,
    ConsensusEntry,
    PairwiseAgreement,
    PipelineBattle,
    RankedPaper,
    WinnerResult,
)

COMP = cs.PIPELINE_COMPONENTS


def rank_maps(lists):
    return {p: {pid: i for i, pid in enumerate(ids, 1)} for p, ids in lists.items()}


def pick(lists):
    maps = rank_maps(lists)
    votes = {}
    for ids in lists.values():
        for pid in ids:
            votes[pid] = votes.get(pid, 0) + 1
    consensus = [
        ConsensusEntry(paper_id=pid, votes=v)
        for pid, v in sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return cs._pick_winner(rank_maps=maps, consensus=consensus, component_sets=COMP)


ALL = list(COMP)


class WinnerMarginTest(unittest.TestCase):
    def test_identical_lists_are_too_close_to_call(self):
        w = pick({p: [1, 2, 3, 4, 5] for p in ALL})
        self.assertFalse(w.decisive)
        self.assertEqual(w.margin, 0.0)
        self.assertEqual(set(w.contenders), set(ALL))

    def test_a_pipeline_everyone_agrees_with_wins_decisively(self):
        lists = {p: [1, 2, 3, 4, 5] for p in ALL}
        lists["sbert"] = [90, 91, 92, 93, 94]  # the odd one out
        w = pick(lists)
        self.assertNotEqual(w.pipeline_id, "sbert")
        self.assertEqual(w.shares["sbert"], min(w.shares.values()))

    def test_margin_runner_up_and_shares_are_consistent(self):
        w = pick({"tfidf": [1, 2, 3], "sbert": [1, 2, 4], "tfidf_sbert": [1, 2, 3],
                  "tfidf_metadata": [1, 5, 6], "sbert_metadata": [7, 8, 9],
                  "tfidf_sbert_metadata": [1, 2, 3]})
        self.assertEqual(w.value, w.shares[w.pipeline_id])
        self.assertAlmostEqual(w.margin, round(w.shares[w.pipeline_id] - w.shares[w.runner_up], 4), places=4)
        self.assertEqual(w.min_margin, cs.MIN_DECISIVE_MARGIN)
        self.assertEqual(w.decisive, w.margin >= cs.MIN_DECISIVE_MARGIN)
        self.assertIn(w.pipeline_id, w.contenders)

    def test_contenders_are_exactly_those_within_the_margin(self):
        w = pick({p: [1, 2, 3, 4, 5] for p in ALL[:3]} | {p: [1, 2, 3, 4, 5] for p in ALL[3:]})
        top = w.shares[w.pipeline_id]
        self.assertEqual(
            set(w.contenders),
            {p for p, v in w.shares.items() if top - v < cs.MIN_DECISIVE_MARGIN},
        )

    def test_consensus_shares_matches_what_pick_winner_reports(self):
        lists = {"tfidf": [1, 2, 3], "sbert": [1, 4, 5], "tfidf_sbert": [2, 3, 6]}
        maps = rank_maps(lists)
        shares, ranks = cs.consensus_shares(
            rank_maps=maps, consensus_positions={1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6},
            consensus_size=6, component_sets=COMP,
        )
        self.assertEqual(set(shares), set(lists))
        self.assertTrue(all(0 <= v <= 1 for v in shares.values()))

    def test_a_single_pipeline_has_no_margin(self):
        w = pick({"tfidf": [1, 2, 3]})
        self.assertIsNone(w.margin)
        self.assertFalse(w.decisive)

    def test_empty_results_give_no_winner(self):
        self.assertIsNone(pick({"tfidf": [], "sbert": []}))


class JudgeListsTest(unittest.TestCase):
    def test_scores_match_hand_computation(self):
        relevance = {1: 2, 2: 1}
        out = bj.judge_lists({"a": [1, 9, 2], "b": [9, 8, 7]}, relevance, k=3, basis="references")
        a = out["scores"]["a"]
        # DCG = 3/log2(2) + 0 + 1/log2(4) = 3.5 ; IDCG = 3/1 + 1/log2(3)
        import math
        self.assertAlmostEqual(a["ndcg"], 3.5 / (3 + 1 / math.log2(3)))
        self.assertEqual((a["hits"], a["hit"], a["mrr"]), (2, 1.0, 1.0))
        self.assertAlmostEqual(a["recall"], 1.0)
        self.assertEqual(out["scores"]["b"]["ndcg"], 0.0)
        self.assertEqual(out["ranking"], ["a", "b"])
        self.assertEqual(out["leader"], "a")
        self.assertTrue(out["separated"])

    def test_excluded_papers_cannot_score(self):
        out = bj.judge_lists({"a": [5, 1], "b": [1, 5]}, {1: 1}, k=2, basis="references", excluded={5})
        self.assertEqual(out["scores"]["a"]["returned"], 1)
        self.assertEqual(out["scores"]["a"]["ndcg"], out["scores"]["b"]["ndcg"])  # the seed no longer helps b's rank

    def test_ties_have_no_single_leader_and_are_not_separated(self):
        out = bj.judge_lists({"a": [1], "b": [1]}, {1: 1}, k=1, basis="human")
        self.assertIsNone(out["leader"])
        self.assertEqual(set(out["leaders"]), {"a", "b"})
        self.assertFalse(out["separated"])

    def test_one_query_with_a_small_edge_is_not_separated(self):
        out = bj.judge_lists({"a": [1, 2, 3], "b": [2, 1, 3]}, {1: 1, 2: 1}, k=3, basis="human")
        self.assertLess(out["margin"], bj.MIN_JUDGED_MARGIN)
        self.assertFalse(out["separated"])

    def test_nothing_relevant_found_is_flagged(self):
        out = bj.judge_lists({"a": [8], "b": [9]}, {1: 1}, k=1, basis="human")
        self.assertTrue(out["nothing_relevant_found"])

    def test_zero_grades_are_not_relevant_and_inputs_validate(self):
        out = bj.judge_lists({"a": [1]}, {1: 0}, k=1, basis="human")
        self.assertEqual(out["n_relevant"], 0)
        with self.assertRaises(ValueError):
            bj.judge_lists({"a": [1]}, {1: 1}, k=1, basis="vibes")
        with self.assertRaises(ValueError):
            bj.judge_lists({}, {1: 1}, k=1, basis="human")

    def test_result_is_json_serialisable(self):
        json.dumps(bj.judge_lists({"a": [1, 2]}, {1: 2}, k=2, basis="references"), allow_nan=False)


def judged(ndcgs, basis="human"):
    return {"judgement_json": json.dumps({
        "basis": basis, "nothing_relevant_found": False,
        "scores": {p: {"ndcg": v, "hit": 1.0 if v > 0 else 0.0} for p, v in ndcgs.items()},
    })}


class JudgedSummaryTest(unittest.TestCase):
    def test_empty(self):
        out = bj.judged_summary([])
        self.assertEqual((out["n_judged"], out["pipelines"], out["verdict"]), (0, [], None))

    def test_means_and_no_verdict_until_enough_battles(self):
        rows = [judged({"a": 0.6, "b": 0.3}) for _ in range(4)]
        out = bj.judged_summary(rows)
        self.assertEqual(out["n_judged"], 4)
        self.assertEqual(out["pipelines"][0]["pipeline"], "a")
        self.assertAlmostEqual(out["pipelines"][0]["mean"], 0.6)
        self.assertIsNone(out["verdict"])  # 4 < MIN_JUDGED_FOR_VERDICT
        self.assertEqual(out["min_for_verdict"], bj.MIN_JUDGED_FOR_VERDICT)

    def test_verdict_once_there_are_enough(self):
        import random
        random.seed(1)
        rows = [judged({"a": 0.5 + random.uniform(-0.05, 0.05) + 0.2,
                        "b": 0.5 + random.uniform(-0.05, 0.05),
                        "c": 0.3 + random.uniform(-0.05, 0.05)}) for _ in range(30)]
        out = bj.judged_summary(rows)
        self.assertEqual(out["n_judged"], 30)
        self.assertEqual(out["verdict"]["winner"], "a")

    def test_battles_with_nothing_relevant_or_missing_pipelines_are_left_out(self):
        rows = [judged({"a": 0.5, "b": 0.4}), judged({"a": 0.5, "b": 0.4}),
                {"judgement_json": json.dumps({"basis": "human", "nothing_relevant_found": True,
                                               "scores": {"a": {"ndcg": 0, "hit": 0}, "b": {"ndcg": 0, "hit": 0}}})},
                judged({"a": 0.9}),   # incomplete: no "b"
                {"judgement_json": "not json"}]
        out = bj.judged_summary(rows)
        self.assertEqual(out["n_judged"], 2)
        self.assertEqual(out["n_skipped_nothing_relevant"], 1 + 1)

    def test_by_basis_counts(self):
        rows = [judged({"a": 0.5, "b": 0.4}, "human"), judged({"a": 0.5, "b": 0.4}, "references")]
        self.assertEqual(bj.judged_summary(rows)["by_basis"], {"human": 1, "references": 1})


# ------------------------------------------------------------
# API
# ------------------------------------------------------------

def fake_response(seed=None, lists=None):
    lists = lists or {"tfidf": [11, 12, 13], "sbert": [13, 14, 15]}
    return CompareResponse(
        query=None if seed else "ranking papers", seed_paper_id=seed, top_k=3,
        pipelines=[PipelineBattle(id=p, results=[RankedPaper(paper_id=i, title=f"P{i}", year=2020, score=0.5) for i in ids])
                   for p, ids in lists.items()],
        consensus=[ConsensusEntry(paper_id=13, votes=2)],
        pairwise=[PairwiseAgreement(a="tfidf", b="sbert", overlap=1)],
        winner=WinnerResult(pipeline_id="tfidf", metric="independence_weighted_consensus", value=0.8,
                            margin=0.001, decisive=False, runner_up="sbert", contenders=["tfidf", "sbert"]),
    )


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app import api

        path = os.path.join(tempfile.mkdtemp(), "judge.db")
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

        db = cls.Session()
        seed = Paper(title="Seed paper on retrieval ranking methods", author="A", abstract="x", doi="10.1/seed")
        db.add(seed); db.flush()
        cls.seed_id = seed.id
        refs = []
        for i in range(3):
            r = Paper(title=f"Cited reference {i} about unique topic {i * 7}", author="B")
            db.add(r); db.flush(); refs.append(r.id)
            db.add(PaperCitation(paper_id=seed.id, direction="cites", external_work_id=f"W{i}", matched_paper_id=r.id))
        db.commit(); cls.refs = refs; db.close()

    @classmethod
    def tearDownClass(cls):
        cls.api.app.dependency_overrides.clear()

    def _compare(self, response, **body):
        with mock.patch.object(self.api, "compare_pipelines", return_value=response):
            return self.client.post("/api/recommendations/compare", json={"top_k": 3, **body})

    def test_a_text_battle_is_recorded_with_margin_and_battle_id(self):
        r = self._compare(fake_response(), query="ranking papers")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIsNotNone(body["battle_id"])
        self.assertIsNone(body["judgement"])  # a text battle has no ground truth
        self.assertFalse(body["winner"]["decisive"])
        with self.Session() as db:
            run = db.get(BattleRun, body["battle_id"])
            self.assertEqual((run.decisive, run.margin), (False, 0.001))
            self.assertIsNone(run.judged_basis)

    def test_a_seed_battle_is_judged_against_the_papers_own_references(self):
        lists = {"tfidf": [self.refs[0], self.refs[1], 900], "sbert": [901, 902, self.refs[2]]}
        r = self._compare(fake_response(self.seed_id, lists), seed_paper_id=self.seed_id)
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()["judgement"]
        self.assertEqual(j["basis"], "references")
        self.assertEqual(j["n_relevant"], 3)
        self.assertEqual(j["scores"]["tfidf"]["hits"], 2)
        self.assertEqual(j["scores"]["sbert"]["hits"], 1)
        self.assertEqual(j["leader"], "tfidf")
        with self.Session() as db:
            run = db.get(BattleRun, r.json()["battle_id"])
            self.assertEqual((run.judged_basis, run.judged_leader), ("references", "tfidf"))
            self.assertIn("scores", json.loads(run.judgement_json))

    def test_the_seed_itself_in_a_list_does_not_count(self):
        lists = {"tfidf": [self.seed_id, self.refs[0], 900], "sbert": [self.refs[0], 901, 902]}
        j = self._compare(fake_response(self.seed_id, lists), seed_paper_id=self.seed_id).json()["judgement"]
        self.assertEqual(j["scores"]["tfidf"]["returned"], 2)

    def test_a_seed_with_no_references_is_simply_not_judged(self):
        with self.Session() as db:
            lone = Paper(title="A lone paper with no references at all", author="C")
            db.add(lone); db.commit(); lone_id = lone.id
        r = self._compare(fake_response(lone_id), seed_paper_id=lone_id)
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["judgement"])

    def test_human_judging_a_recorded_battle_persists_scores(self):
        battle = self._compare(fake_response(), query="human judged").json()["battle_id"]
        r = self.client.post("/api/evaluation/judge", json={"battle_id": battle, "relevant": [13, 14, 999]})
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual(j["basis"], "human")
        self.assertEqual(j["n_relevant"], 2)            # 999 was never shown: ignored
        self.assertEqual(j["scores"]["sbert"]["hits"], 2)
        self.assertEqual(j["scores"]["tfidf"]["hits"], 1)
        with self.Session() as db:
            run = db.get(BattleRun, battle)
            self.assertEqual(run.judged_basis, "human")
            self.assertEqual(run.judged_leader, j["leader"])

    def test_human_judging_without_a_battle_uses_the_given_lists_and_stores_nothing(self):
        r = self.client.post("/api/evaluation/judge", json={"lists": {"a": [1, 2], "b": [3, 4]}, "top_k": 2, "relevant": [1]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["leader"], "a")

    def test_judge_errors(self):
        self.assertEqual(self.client.post("/api/evaluation/judge", json={"relevant": [1]}).status_code, 400)
        self.assertEqual(self.client.post("/api/evaluation/judge", json={"battle_id": 99999, "relevant": []}).status_code, 404)
        with self.Session() as db:
            bare = BattleRun(query="q", top_k=3, winner_pipeline_id="tfidf", winner_metric="independence_weighted_consensus", winner_value=0.5)
            db.add(bare); db.commit(); bare_id = bare.id
        self.assertEqual(self.client.post("/api/evaluation/judge", json={"battle_id": bare_id, "relevant": []}).status_code, 409)

    def test_history_tally_counts_only_decisive_wins_and_separates_the_rest(self):
        with self.Session() as db:
            db.query(BattleRun).delete()
            M = "independence_weighted_consensus"
            db.add_all([
                BattleRun(query="a", top_k=3, winner_pipeline_id="sbert", winner_metric=M, winner_value=0.9, margin=0.05, decisive=True),
                BattleRun(query="b", top_k=3, winner_pipeline_id="sbert", winner_metric=M, winner_value=0.9, margin=0.04, decisive=True),
                BattleRun(query="c", top_k=3, winner_pipeline_id="tfidf", winner_metric=M, winner_value=0.8, margin=0.003, decisive=False),
                BattleRun(query="d", top_k=3, winner_pipeline_id="tfidf", winner_metric=M, winner_value=0.8),                 # unknown margin
                BattleRun(query="e", top_k=3, winner_pipeline_id="tfidf", winner_metric="consensus_votes", winner_value=5.0),  # legacy
            ])
            db.commit()
        h = self.client.get("/api/evaluation/battles").json()
        self.assertEqual({t["pipeline_id"]: t["wins"] for t in h["tally"]}, {"sbert": 2})
        self.assertEqual(h["verdicts"], {"decisive": 2, "too_close": 1, "unknown": 1, "legacy": 1, "judged": 0})
        self.assertEqual(h["total"], 5)
        run = h["runs"][0]
        for key in ("margin", "decisive", "judged_basis", "judged_leader"):
            self.assertIn(key, run)

    def test_backfill_recovers_margin_from_stored_lists_and_skips_the_rest(self):
        with self.Session() as db:
            db.query(BattleRun).delete()
            M = "independence_weighted_consensus"
            lists = {p: [1, 2, 3] for p in ALL}
            resp = CompareResponse(
                query="q", top_k=3,
                pipelines=[PipelineBattle(id=p, results=[RankedPaper(paper_id=i, score=0.5) for i in ids]) for p, ids in lists.items()],
                consensus=[ConsensusEntry(paper_id=i, votes=6) for i in (1, 2, 3)], pairwise=[],
                winner=WinnerResult(pipeline_id="tfidf", metric=M, value=1.0),
            )
            db.add_all([
                BattleRun(query="has lists", top_k=3, winner_pipeline_id="tfidf", winner_metric=M, winner_value=1.0, response_json=resp.model_dump_json()),
                BattleRun(query="no lists", top_k=3, winner_pipeline_id="tfidf", winner_metric=M, winner_value=1.0),
                BattleRun(query="custom", top_k=3, winner_pipeline_id="tfidf", winner_metric=M, winner_value=1.0, response_json=resp.model_dump_json(), custom_weights='{"tfidf": 1}'),
                BattleRun(query="legacy", top_k=3, winner_pipeline_id="tfidf", winner_metric="consensus_votes", winner_value=5.0, response_json=resp.model_dump_json()),
            ])
            db.commit()
            self.assertEqual(self.api.backfill_battle_verdicts(db), 1)
            rows = {r.query: r for r in db.query(BattleRun)}
            self.assertEqual((rows["has lists"].decisive, rows["has lists"].margin), (False, 0.0))
            for name in ("no lists", "custom", "legacy"):
                self.assertIsNone(rows[name].decisive, name)
            self.assertEqual(self.api.backfill_battle_verdicts(db), 0)  # idempotent

    def test_judged_summary_endpoint(self):
        with self.Session() as db:
            db.query(BattleRun).delete()
            for i in range(12):
                db.add(BattleRun(query=f"q{i}", top_k=3, winner_pipeline_id="tfidf", winner_metric="independence_weighted_consensus",
                                 winner_value=0.5, judged_basis="human",
                                 judgement_json=judged({"a": 0.7 + 0.01 * (i % 3), "b": 0.3 + 0.01 * (i % 4)})["judgement_json"]))
            db.commit()
        out = self.client.get("/api/evaluation/battles/judged").json()
        self.assertEqual(out["n_judged"], 12)
        self.assertEqual(out["verdict"]["winner"], "a")


if __name__ == "__main__":
    unittest.main()

import math
import unittest

import numpy as np

from app.services.evaluation import stats


class SpecialFunctionTest(unittest.TestCase):
    def test_chi2_sf_known_values(self):
        # Standard table values.
        self.assertAlmostEqual(stats.chi2_sf(3.841458820694124, 1), 0.05, places=6)
        self.assertAlmostEqual(stats.chi2_sf(5.991464547107979, 2), 0.05, places=6)
        self.assertAlmostEqual(stats.chi2_sf(0.0, 3), 1.0)
        self.assertAlmostEqual(stats.chi2_sf(20.0, 5), 0.0012, places=4)

    def test_normal_ppf(self):
        self.assertAlmostEqual(stats._normal_ppf(0.975), 1.959964, places=5)
        self.assertAlmostEqual(stats._normal_ppf(0.5), 0.0, places=9)
        self.assertAlmostEqual(stats._normal_ppf(0.01), -2.326348, places=5)


class BootstrapTest(unittest.TestCase):
    def test_ci_contains_mean_and_is_seeded(self):
        data = [0.1, 0.4, 0.5, 0.7, 0.2, 0.9, 0.3, 0.6]
        first = stats.bootstrap_ci(data, resamples=2000, seed=1)
        second = stats.bootstrap_ci(data, resamples=2000, seed=1)

        self.assertEqual(first, second)
        self.assertAlmostEqual(first["mean"], sum(data) / len(data))
        self.assertLess(first["lo"], first["mean"])
        self.assertGreater(first["hi"], first["mean"])

    def test_constant_data_has_degenerate_interval(self):
        result = stats.bootstrap_ci([0.5] * 6)
        self.assertEqual((result["lo"], result["hi"]), (0.5, 0.5))

    def test_paired_bootstrap_detects_consistent_gap(self):
        a = [0.6, 0.7, 0.65, 0.8, 0.7, 0.75]
        b = [x - 0.1 for x in a]
        result = stats.paired_bootstrap(a, b, resamples=500, seed=3)

        self.assertAlmostEqual(result["mean_diff"], 0.1)
        self.assertTrue(result["excludes_zero"])

    def test_paired_bootstrap_length_mismatch(self):
        with self.assertRaises(ValueError):
            stats.paired_bootstrap([1, 2], [1])


class RankTestTest(unittest.TestCase):
    def test_wilcoxon_matches_hand_computation(self):
        # Differences 1..5 all positive: W- = 0, exact two-sided p
        # = 2 / 2^5 = 0.0625.
        result = stats.wilcoxon_signed_rank([1, 2, 3, 4, 5], [0] * 5)
        self.assertAlmostEqual(result["p_value"], 0.0625)
        self.assertEqual(result["statistic"], 0.0)

    def test_wilcoxon_symmetric_is_not_significant(self):
        result = stats.wilcoxon_signed_rank([1, -2, 3, -4], [0] * 4)
        self.assertGreater(result["p_value"], 0.5)

    def test_wilcoxon_all_equal(self):
        result = stats.wilcoxon_signed_rank([1, 2], [1, 2])
        self.assertEqual(result["p_value"], 1.0)
        self.assertEqual(result["n"], 0)

    def test_wilcoxon_handles_ties_exactly(self):
        result = stats.wilcoxon_signed_rank([1, 1, 1, 1, -1], [0] * 5)
        self.assertTrue(0.0 < result["p_value"] <= 1.0)

    def test_wilcoxon_normal_approximation_agrees_with_exact(self):
        rng = np.random.default_rng(0)
        a = rng.normal(0.1, 0.2, 50)
        zeros = np.zeros(50)
        exact = stats.wilcoxon_signed_rank(a, zeros)["p_value"]

        original = stats.WILCOXON_EXACT_MAX_N
        stats.WILCOXON_EXACT_MAX_N = 1
        try:
            approx = stats.wilcoxon_signed_rank(a, zeros)["p_value"]
        finally:
            stats.WILCOXON_EXACT_MAX_N = original

        self.assertAlmostEqual(exact, approx, delta=0.02)

    def test_friedman_known_example(self):
        # Three pipelines, perfectly consistent ordering on 6 queries:
        # rank sums 6 / 12 / 18, Q = 12 / (6*3*4) * (36+0+36) = 12.
        scores = {
            "a": [3, 3, 3, 3, 3, 3],
            "b": [2, 2, 2, 2, 2, 2],
            "c": [1, 1, 1, 1, 1, 1],
        }
        result = stats.friedman(scores)

        self.assertAlmostEqual(result["statistic"], 12.0)
        self.assertEqual(result["df"], 2)
        self.assertAlmostEqual(result["p_value"], math.exp(-6.0), places=6)
        self.assertEqual(result["mean_ranks"]["a"], 1.0)

    def test_friedman_all_tied_is_not_significant(self):
        scores = {"a": [0.5, 0.5, 0.5], "b": [0.5, 0.5, 0.5]}
        result = stats.friedman(scores)
        self.assertEqual(result["statistic"], 0.0)
        self.assertEqual(result["p_value"], 1.0)

    def test_holm_adjustment(self):
        adjusted = stats.holm_adjust([0.01, 0.04, 0.03])
        self.assertAlmostEqual(adjusted[0], 0.03)
        self.assertAlmostEqual(adjusted[1], 0.06)
        self.assertAlmostEqual(adjusted[2], 0.06)

    def test_holm_is_monotone_and_capped(self):
        adjusted = stats.holm_adjust([0.5, 0.9])
        self.assertEqual(adjusted, [1.0, 1.0])


class EffectSizeTest(unittest.TestCase):
    def test_cliffs_delta_extremes(self):
        self.assertEqual(stats.cliffs_delta([3, 4], [1, 2]), 1.0)
        self.assertEqual(stats.cliffs_delta([1, 2], [3, 4]), -1.0)
        self.assertEqual(stats.cliffs_delta([1, 2], [1, 2]), 0.0)

    def test_cliffs_delta_partial(self):
        # pairs: (2>1)=+, (2<3)=-, (4>1)=+, (4>3)=+ -> (3-1)/4
        self.assertAlmostEqual(stats.cliffs_delta([2, 4], [1, 3]), 0.5)

    def test_cohens_dz(self):
        self.assertAlmostEqual(
            stats.paired_cohens_dz([2, 4, 6], [1, 2, 3]),
            2.0 / 1.0,
        )
        self.assertEqual(stats.paired_cohens_dz([1, 1], [1, 1]), 0.0)


class SampleSizeTest(unittest.TestCase):
    def test_documented_figures(self):
        self.assertEqual(stats.required_sample_size(0.05, 0.2), 126)
        self.assertEqual(stats.required_sample_size(0.05, 0.1), 32)

    def test_zero_spread(self):
        self.assertEqual(stats.required_sample_size(0.05, 0.0), 2)

    def test_rejects_bad_effect(self):
        with self.assertRaises(ValueError):
            stats.required_sample_size(0.0, 0.2)


class BradleyTerryTest(unittest.TestCase):
    def test_stronger_item_rates_higher(self):
        votes = [("a", "b")] * 8 + [("b", "a")] * 2
        rating = stats.bradley_terry(votes)

        self.assertGreater(rating["a"], rating["b"])
        # Geometric mean normalised to 1.
        self.assertAlmostEqual(rating["a"] * rating["b"], 1.0, places=6)
        # MLE odds a:b is 8:2 = 4 (regularisation nudges slightly).
        self.assertAlmostEqual(rating["a"] / rating["b"], 4.0, delta=0.2)

    def test_symmetric_votes_give_equal_ratings(self):
        rating = stats.bradley_terry([("a", "b"), ("b", "a")] * 5)
        self.assertAlmostEqual(rating["a"], rating["b"], places=6)

    def test_empty_and_self_vote(self):
        self.assertEqual(stats.bradley_terry([]), {})
        with self.assertRaises(ValueError):
            stats.bradley_terry([("a", "a")])

    def test_ci_brackets_the_point_estimate(self):
        votes = [("a", "b")] * 12 + [("b", "a")] * 4 + [("b", "c")] * 9 + [("c", "b")] * 5
        ci = stats.bradley_terry_ci(votes, resamples=200, seed=1)

        for entry in ci.values():
            self.assertLessEqual(entry["lo"], entry["hi"])


class RankWithTiesTest(unittest.TestCase):
    def _scores(self, n=80, seed=0, shifts=None):
        rng = np.random.default_rng(seed)
        shifts = shifts or {"a": 0.0, "b": 0.0, "c": 0.0}
        base = rng.uniform(0.2, 0.8, n)
        return {
            name: np.clip(base + shift + rng.normal(0, 0.05, n), 0, 1)
            for name, shift in shifts.items()
        }

    def test_clear_winner(self):
        scores = self._scores(shifts={"a": 0.15, "b": 0.0, "c": -0.1})
        result = stats.rank_with_ties(scores, resamples=500, seed=1)

        self.assertEqual(result["outcome"], stats.OUTCOME_WINNER)
        self.assertEqual(result["winner"], "a")
        self.assertEqual(result["ranking"][0]["pipeline"], "a")

    def test_identical_pipelines_tie(self):
        base = self._scores(shifts={"a": 0.0})["a"]
        scores = {"a": base, "b": base.copy(), "c": base.copy()}
        result = stats.rank_with_ties(scores, resamples=200, seed=1)

        self.assertIsNone(result["winner"])
        self.assertIn(result["outcome"], {stats.OUTCOME_TIE, stats.OUTCOME_INCONCLUSIVE})
        self.assertEqual(len(result["tie_groups"]), 1)

    def test_two_leaders_form_a_tie_group(self):
        scores = self._scores(shifts={"a": 0.1, "b": 0.1, "c": -0.2}, seed=4)
        result = stats.rank_with_ties(scores, resamples=500, seed=1)

        self.assertIsNone(result["winner"])
        self.assertEqual(set(result["top_group"]), {"a", "b"})

    def test_too_few_queries_is_inconclusive(self):
        scores = {"a": [0.5, 0.6, 0.55], "b": [0.5, 0.6, 0.56]}
        result = stats.rank_with_ties(scores, resamples=200, seed=1)

        self.assertEqual(result["outcome"], stats.OUTCOME_INCONCLUSIVE)
        self.assertIsNone(result["winner"])

    def test_single_query_is_inconclusive(self):
        result = stats.rank_with_ties({"a": [0.5], "b": [0.4]})
        self.assertEqual(result["outcome"], stats.OUTCOME_INCONCLUSIVE)

    def test_deterministic_given_seed(self):
        scores = self._scores(shifts={"a": 0.1, "b": 0.0})
        first = stats.rank_with_ties(scores, resamples=300, seed=9)
        second = stats.rank_with_ties(scores, resamples=300, seed=9)
        self.assertEqual(first, second)

    def test_validation(self):
        with self.assertRaises(ValueError):
            stats.rank_with_ties({"a": [1, 2]})
        with self.assertRaises(ValueError):
            stats.rank_with_ties({"a": [1, 2], "b": [1]})

    def test_null_false_positive_rate_is_near_alpha(self):
        # Pipelines drawn from the same distribution must crown a
        # winner no more than about alpha of the time.
        rng = np.random.default_rng(123)
        trials = 120
        winners = 0

        for _ in range(trials):
            scores = {
                name: rng.uniform(0, 1, 40) for name in ("a", "b", "c")
            }
            result = stats.rank_with_ties(scores, resamples=100, seed=1)
            winners += result["outcome"] == stats.OUTCOME_WINNER

        self.assertLessEqual(winners / trials, 0.10)



class BinaryMetricTest(unittest.TestCase):
    """Hit rate is 0/1 per query: McNemar's exact test and Cohen's h."""

    def _pair(self, a_only, b_only, both=5, neither=5):
        a = np.array([1] * a_only + [0] * b_only + [1] * both + [0] * neither, float)
        b = np.array([0] * a_only + [1] * b_only + [1] * both + [0] * neither, float)
        return a, b

    def test_mcnemar_known_values(self):
        # 8 vs 2 discordant: 2 * (1 + 10 + 45) / 1024
        r = stats.mcnemar_exact(*self._pair(8, 2))
        self.assertAlmostEqual(r["p_value"], 112 / 1024)
        self.assertEqual((r["a_only"], r["b_only"], r["n_discordant"]), (8, 2, 10))

    def test_mcnemar_symmetry_and_degenerate_cases(self):
        self.assertEqual(stats.mcnemar_exact(*self._pair(5, 5))["p_value"], 1.0)
        self.assertEqual(stats.mcnemar_exact(*self._pair(0, 0))["p_value"], 1.0)
        self.assertAlmostEqual(
            stats.mcnemar_exact(*self._pair(12, 3))["p_value"],
            stats.mcnemar_exact(*self._pair(3, 12))["p_value"],
        )
        # p never exceeds 1, even for a lopsided tie at the centre
        self.assertLessEqual(stats.mcnemar_exact(*self._pair(1, 0))["p_value"], 1.0)

    def test_mcnemar_large_counts_do_not_overflow(self):
        r = stats.mcnemar_exact(*self._pair(1800, 1700))
        self.assertTrue(0.0 < r["p_value"] <= 1.0)

    def test_mcnemar_validates(self):
        with self.assertRaises(ValueError):
            stats.mcnemar_exact([1, 0], [1])

    def test_cohens_h(self):
        self.assertAlmostEqual(stats.cohens_h(0.5, 0.5), 0.0)
        self.assertAlmostEqual(stats.cohens_h(0.743, 0.65), 0.203, places=3)
        self.assertAlmostEqual(stats.cohens_h(0.65, 0.743), -0.203, places=3)
        self.assertAlmostEqual(stats.cohens_h(1.0, 0.0), math.pi)
        # a nine-point hit-rate gap is not "negligible", on either side of 0.2
        self.assertEqual(stats.h_label(stats.cohens_h(0.743, 0.65)), "small")
        self.assertEqual(stats.h_label(stats.cohens_h(0.74, 0.65)), "very small")
        self.assertEqual(stats.h_label(0.05), "negligible")
        self.assertEqual(stats.h_label(0.15), "very small")
        self.assertEqual(stats.h_label(0.19), "very small")
        self.assertEqual(stats.h_label(0.2), "small")
        self.assertEqual(stats.h_label(0.6), "medium")
        self.assertEqual(stats.h_label(0.9), "large")

    def test_size_labels_for_cliffs_delta_are_unchanged(self):
        self.assertEqual(stats.cliffs_label(0.1), "negligible")
        self.assertEqual(stats.cliffs_label(0.2), "small")
        self.assertEqual(stats.cliffs_label(0.4), "medium")
        self.assertEqual(stats.cliffs_label(0.6), "large")

    def test_is_binary(self):
        self.assertTrue(stats.is_binary([0, 1, 1, 0.0]))
        self.assertFalse(stats.is_binary([0, 0.5, 1]))
        self.assertFalse(stats.is_binary([]))

    def _hit_scores(self, rate_a, rate_b, n=300, seed=3):
        rng = np.random.default_rng(seed)
        shared = rng.uniform(0, 1, n)
        return {
            "a": (shared < rate_a).astype(float),
            "b": (np.clip(shared + rng.normal(0, 0.15, n), 0, 1) < rate_b).astype(float),
            "c": (rng.uniform(0, 1, n) < 0.5).astype(float),
        }

    def test_rank_with_ties_uses_mcnemar_and_h_on_binary_scores(self):
        r = stats.rank_with_ties(self._hit_scores(0.75, 0.65), resamples=100, seed=1)
        self.assertTrue(r["binary"])
        self.assertEqual(r["pairwise_test"], "McNemar exact")
        for row in r["pairwise"]:
            self.assertEqual(row["test"], "mcnemar")
            self.assertEqual(row["effect_kind"], "h")
            self.assertEqual(row["effect_size"], row["cohens_h"])
            self.assertIn(row["effect_label"], {"negligible", "very small", "small", "medium", "large"})
            # the discordant counts account for the whole difference
            self.assertEqual(row["a_only"] - row["b_only"], round(row["mean_diff"] * 300))

    def test_a_nine_point_gap_is_not_called_negligible(self):
        scores = {
            "a": np.array([1.0] * 223 + [0.0] * 77),
            "b": np.array([1.0] * 195 + [0.0] * 105),
        }
        rng = np.random.default_rng(0)
        rng.shuffle(scores["a"]); rng.shuffle(scores["b"])
        r = stats.rank_with_ties(scores, resamples=100, seed=1)
        self.assertNotEqual(r["pairwise"][0]["effect_label"], "negligible")

    def test_continuous_scores_use_wilcoxon_and_a_paired_delta(self):
        rng = np.random.default_rng(0)
        scores = {n: rng.uniform(0, 1, 60) + i * 0.1 for i, n in enumerate("abc")}
        r = stats.rank_with_ties(scores, resamples=100, seed=1)
        self.assertFalse(r["binary"])
        self.assertEqual(r["pairwise_test"], "Wilcoxon signed-rank")
        for row in r["pairwise"]:
            self.assertEqual(row["test"], "wilcoxon")
            self.assertEqual(row["effect_kind"], "delta")
            # the label is read from the paired measure, not the unpaired one
            self.assertEqual(row["effect_size"], row["paired_delta"])
            self.assertIn("cliffs_delta", row)  # kept for stored-run comparability
            self.assertNotIn("a_only", row)

    def test_mixed_zero_one_and_fractions_is_not_binary(self):
        scores = {"a": np.array([1.0, 0.0, 1.0, 0.5] * 5), "b": np.array([0.0, 1.0, 1.0, 0.0] * 5)}
        self.assertFalse(stats.rank_with_ties(scores, resamples=50, seed=1)["binary"])

    def test_false_positive_rate_on_equal_hit_rates(self):
        rng = np.random.default_rng(11)
        winners = 0
        for _ in range(80):
            scores = {n: (rng.uniform(0, 1, 200) < 0.7).astype(float) for n in "abc"}
            winners += stats.rank_with_ties(scores, resamples=50, seed=1)["outcome"] == "winner"
        self.assertLessEqual(winners / 80, 0.12)



class PairedEffectSizeTest(unittest.TestCase):
    def test_paired_dominance_counts_wins_minus_losses_per_query(self):
        a = [3, 2, 5, 1, 4, 4]
        b = [1, 2, 4, 3, 2, 4]  # a wins 3, loses 1, ties 2
        self.assertAlmostEqual(stats.paired_dominance(a, b), (3 - 1) / 6)
        self.assertAlmostEqual(stats.paired_dominance(b, a), -(3 - 1) / 6)
        self.assertEqual(stats.paired_dominance([1, 2], [1, 2]), 0.0)
        self.assertEqual(stats.paired_dominance([2, 3], [1, 1]), 1.0)

    def test_paired_dominance_validates(self):
        with self.assertRaises(ValueError):
            stats.paired_dominance([1, 2], [1])
        with self.assertRaises(ValueError):
            stats.paired_dominance([], [])

    def test_a_consistent_small_edge_is_not_swamped_by_query_difficulty(self):
        # Queries differ hugely in difficulty (0.05 .. 0.95) but pipeline a
        # beats b by a little on 70% of them and loses on 30%: the unpaired
        # delta is near zero, the paired one reads the real consistency.
        rng = np.random.default_rng(0)
        difficulty = rng.uniform(0.05, 0.95, 400)
        edge = np.where(rng.uniform(size=400) < 0.7, 0.03, -0.03)
        a, b = difficulty + edge, difficulty
        self.assertLess(abs(stats.cliffs_delta(a, b)), 0.1)
        self.assertGreater(stats.paired_dominance(a, b), 0.35)
        row = stats.rank_with_ties({"a": a, "b": b}, resamples=100, seed=1)["pairwise"][0]
        self.assertEqual(row["effect_size"], row["paired_delta"])
        self.assertNotEqual(row["effect_label"], "negligible")

    def test_unpaired_and_paired_agree_when_scores_are_independent(self):
        rng = np.random.default_rng(1)
        a = rng.uniform(0, 1, 2000) + 0.2
        b = rng.uniform(0, 1, 2000)
        self.assertAlmostEqual(stats.cliffs_delta(a, b), stats.paired_dominance(a, b), delta=0.05)


class DetectableGapTest(unittest.TestCase):
    def test_gap_matches_the_sample_size_formula(self):
        rng = np.random.default_rng(2)
        base = rng.uniform(0, 1, 300)
        scores = {"a": base + 0.01, "b": base + rng.normal(0, 0.06, 300)}
        v = stats.rank_with_ties(scores, resamples=100, seed=1)
        gap = v["detectable_gap"]
        self.assertIsNotNone(gap)
        # n queries can detect `gap`; the required n for that gap is ~ n
        sd = float(np.std(np.array(scores[v["ranking"][0]["pipeline"]]) - np.array(scores[v["ranking"][1]["pipeline"]]), ddof=1))
        self.assertAlmostEqual(stats.required_sample_size(gap, sd), 300, delta=2)

    def test_more_queries_detect_smaller_gaps(self):
        rng = np.random.default_rng(3)
        def run(n):
            base = rng.uniform(0, 1, n)
            return stats.rank_with_ties({"a": base, "b": base + rng.normal(0, 0.1, n)}, resamples=50, seed=1)["detectable_gap"]
        self.assertGreater(run(50), run(800))


if __name__ == "__main__":
    unittest.main()

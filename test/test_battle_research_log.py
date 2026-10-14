"""
The Arena's run log has to be research-grade: the campaign's tally is
only defensible if every formal run can be told from a development
walkthrough, and only analysable if the agreement structure a battle
computed survives the request.

Covers four things:

    1. the migration adds its columns, is idempotent, leaves existing
       rows alone, and backfills query_kind from `query IS NULL`;
    2. a recorded battle stores the whole CompareResponse plus its
       label, class, query kind, knobs and corpus fingerprint;
    3. export / archive / delete round-trip the history -- CSV and
       JSONL, a timestamped file under storage/exports/, and a cleared
       table;
    4. /stats reports win shares overall and split by query kind.

The pure half of all of this -- CSV and JSONL serialisation, the
summaries read back out of a stored response, win-share aggregation --
lives in app.services.evaluation.battle_log and is tested directly
here, without a database or a client. The API half runs against a
temporary SQLite file (TestClient serves in a worker thread, so an
in-memory DB will not do) with the comparison engine stubbed, so no
vectors or models are loaded.

Run from the project root:

    .venv/bin/python -m unittest test.test_battle_research_log -v
"""

import csv
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, BattleRun
from app.services.evaluation import battle_log, corpus_state
from app.services.recommendation.compare_service import (
    CompareResponse,
    ConsensusEntry,
    PairwiseAgreement,
    PipelineBattle,
    RankedPaper,
    WinnerResult,
)


# ============================================================
# FIXTURES
# ============================================================

def _response(
    *,
    winner: str = "tfidf",
    value: float = 0.75,
    pipelines: int = 3,
    consensus: list[tuple[int, int]] | None = None,
    pairwise: list[tuple[int, float | None]] | None = None,
) -> CompareResponse:
    """A small but structurally complete CompareResponse.

    Shaped like a real one (several pipelines, consensus entries with
    vote counts, pairwise pairs) so the export and the summaries are
    exercised against the shape they will actually meet, without
    building one by running six pipelines.
    """

    entries = (
        consensus
        if consensus is not None
        else [(11, 3), (12, 2), (13, 1)]
    )

    pairs = pairwise if pairwise is not None else [(3, 1.5), (2, 4.0)]

    return CompareResponse(
        query="ranking",
        seed_paper_id=None,
        top_k=5,
        pipelines=[
            PipelineBattle(
                id=f"p{index}",
                results=[
                    RankedPaper(
                        paper_id=entry[0],
                        title=f"Paper {entry[0]}",
                        year=2020,
                        score=0.5,
                    )
                ],
            )
            for index, entry in enumerate(entries[:pipelines])
        ],
        consensus=[
            ConsensusEntry(
                paper_id=paper_id,
                title=f"Paper {paper_id}",
                year=2020,
                votes=votes,
                avg_rank=1.5,
                best_rank=1,
            )
            for paper_id, votes in entries
        ],
        pairwise=[
            PairwiseAgreement(
                a=f"p{index}",
                b=f"p{index + 1}",
                overlap=overlap,
                mean_rank_gap=gap,
            )
            for index, (overlap, gap) in enumerate(pairs)
        ],
        winner=WinnerResult(
            pipeline_id=winner,
            metric="independence_weighted_consensus",
            value=value,
            avg_consensus_rank=1.5,
        ),
    )


def _run(**overrides) -> dict:
    """One row in the dict shape the export and stats helpers read."""

    row = {
        "id": 1,
        "created_at": "2026-10-09T10:00:00",
        "run_label": "campaign-ml-text-5",
        "subject_class": "Machine Learning",
        "query_kind": "text",
        "query": "ranking",
        "seed_paper_id": None,
        "top_k": 5,
        "winner_pipeline_id": "tfidf",
        "winner_metric": "independence_weighted_consensus",
        "winner_value": 0.75,
        "avg_consensus_rank": 1.5,
        "mmr_lambda": None,
        "mmr_pool": None,
        "custom_weights": None,
        "response_json": _response().model_dump_json(),
        "corpus_size": 145,
        "corpus_version": "v1-n145-abcdef123456",
    }
    row.update(overrides)

    return row


# ============================================================
# MIGRATION
# ============================================================

class MigrationTest(unittest.TestCase):
    """
    scripts/migrate_add_battle_research_log.py, run against a
    throwaway copy of the real schema.

    The live database is never touched: the migration opens the path it
    is given, and that path is a temporary file created here with the
    pre-migration battle_runs layout.
    """

    NEW_COLUMNS = {
        "run_label": "VARCHAR(200)",
        "subject_class": "VARCHAR(100)",
        "query_kind": "VARCHAR(20)",
        "mmr_lambda": "FLOAT",
        "mmr_pool": "INTEGER",
        "custom_weights": "TEXT",
        "response_json": "TEXT",
        "corpus_size": "INTEGER",
        "corpus_version": "VARCHAR(100)",
    }

    def setUp(self):
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)

        self.path = os.path.join(
            self._temporary_directory.name,
            "legacy.db",
        )
        self._loaded = None

        self._create_legacy_database()

    def _create_legacy_database(self):
        """battle_runs exactly as it was before the research log."""

        conn = sqlite3.connect(self.path)
        try:
            conn.execute(
                """
                CREATE TABLE battle_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    query TEXT,
                    seed_paper_id INTEGER,
                    top_k INTEGER NOT NULL,
                    winner_pipeline_id VARCHAR(50) NOT NULL,
                    winner_metric VARCHAR(50) NOT NULL,
                    winner_value FLOAT,
                    avg_consensus_rank FLOAT,
                    created_at DATETIME NOT NULL
                )
                """
            )
            conn.executemany(
                """
                INSERT INTO battle_runs (
                    query, seed_paper_id, top_k, winner_pipeline_id,
                    winner_metric, winner_value, avg_consensus_rank,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        "ranking",
                        None,
                        10,
                        "tfidf",
                        "independence_weighted_consensus",
                        0.61,
                        2.0,
                        "2026-09-30 21:42:31.110740",
                    ),
                    (
                        "graphs",
                        None,
                        10,
                        "sbert",
                        "independence_weighted_consensus",
                        0.48,
                        3.0,
                        "2026-10-01 09:00:00",
                    ),
                    # The one seed run: query NULL, seed_paper_id set.
                    (
                        None,
                        7,
                        10,
                        "tfidf_sbert",
                        "independence_weighted_consensus",
                        0.55,
                        2.5,
                        "2026-10-02 09:00:00",
                    ),
                ],
            )
            conn.commit()
        finally:
            conn.close()

    def _module(self):
        """The migration script, loaded as a module.

        Imported rather than exec'd so its own ``__file__``-relative
        path resolution runs exactly as it does from the command line;
        only DB_PATH is redirected, at the attribute the script's main()
        reads.
        """

        if self._loaded is None:
            path = self._migration_path()

            spec = importlib.util.spec_from_file_location(
                "migrate_add_battle_research_log_under_test",
                path,
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            self._loaded = module

        return self._loaded

    def _migrate(self, db_path: str | None = None):
        """Run the migration against the given (or our) database."""

        module = self._module()
        target = db_path or self.path

        with mock.patch.object(module, "DB_PATH", target):
            module.main()

    def _columns(self):
        conn = sqlite3.connect(self.path)
        try:
            return {
                row[1]: row[2]
                for row in conn.execute("PRAGMA table_info(battle_runs)")
            }
        finally:
            conn.close()

    def _rows(self):
        conn = sqlite3.connect(self.path)
        try:
            conn.row_factory = sqlite3.Row
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM battle_runs ORDER BY id"
                )
            ]
        finally:
            conn.close()

    def test_adds_every_column_and_keeps_every_row(self):
        self._migrate()

        columns = self._columns()

        for name, column_type in self.NEW_COLUMNS.items():
            self.assertIn(name, columns)
            self.assertEqual(columns[name], column_type)

        rows = self._rows()

        self.assertEqual(len(rows), 3)

        # The original values are byte-identical: a migration that
        # rewrote history would invalidate the very runs it is meant
        # to preserve.
        self.assertEqual(rows[0]["query"], "ranking")
        self.assertEqual(rows[0]["top_k"], 10)
        self.assertEqual(rows[0]["winner_pipeline_id"], "tfidf")
        self.assertEqual(rows[0]["winner_value"], 0.61)
        self.assertEqual(
            rows[0]["created_at"],
            "2026-09-30 21:42:31.110740",
        )

    def test_existing_rows_are_null_except_query_kind(self):
        self._migrate()

        for row in self._rows():
            for column in self.NEW_COLUMNS:
                if column == "query_kind":
                    continue

                self.assertIsNone(
                    row[column],
                    f"{column} was invented on a pre-campaign row",
                )

    def test_query_kind_is_backfilled_from_query(self):
        self._migrate()

        rows = self._rows()

        self.assertEqual(rows[0]["query_kind"], "text")
        self.assertEqual(rows[1]["query_kind"], "text")
        self.assertEqual(rows[2]["query_kind"], "seed")

    def test_running_twice_changes_nothing(self):
        self._migrate()

        once = self._rows()
        self._migrate()
        twice = self._rows()

        self.assertEqual(once, twice)

    def test_backfill_never_overwrites_a_tagged_run(self):
        """A run recorded after the migration must keep its own kind.

        The backfill is what makes the migration idempotent in effect
        as well as in time, so it has to be conditional -- otherwise
        re-running it the morning of a campaign would quietly restate
        every recorded run.
        """

        self._migrate()

        conn = sqlite3.connect(self.path)
        try:
            conn.execute(
                "UPDATE battle_runs "
                "SET query_kind='seed', run_label='campaign-1' "
                "WHERE id=1"
            )
            conn.commit()
        finally:
            conn.close()

        self._migrate()

        rows = {row["id"]: row for row in self._rows()}

        self.assertEqual(rows[1]["query_kind"], "seed")
        self.assertEqual(rows[1]["run_label"], "campaign-1")

    def test_missing_database_is_a_no_op_not_a_crash(self):
        """A fresh checkout has no DB to migrate yet."""

        self._migrate(
            os.path.join(
                self._temporary_directory.name,
                "nowhere",
                "absent.db",
            )
        )

    def test_database_without_the_table_is_a_no_op(self):
        empty = os.path.join(
            self._temporary_directory.name,
            "empty.db",
        )

        conn = sqlite3.connect(empty)
        conn.close()

        self._migrate(empty)

    def _migration_path(self) -> str:
        return os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scripts",
            "migrate_add_battle_research_log.py",
        )


# ============================================================
# PURE HELPERS
# ============================================================

class SummariseResponseTest(unittest.TestCase):
    """Figures read back out of a stored CompareResponse."""

    def test_reads_consensus_and_pairwise_figures(self):
        summary = battle_log.summarise_response(_response().model_dump_json())

        self.assertEqual(summary["pipeline_count"], 3)
        self.assertEqual(summary["consensus_size"], 3)
        self.assertEqual(summary["top_consensus_votes"], 3)
        self.assertEqual(summary["top_consensus_paper_id"], 11)
        self.assertEqual(summary["pair_count"], 2)
        self.assertAlmostEqual(summary["mean_overlap"], 2.5)
        self.assertAlmostEqual(summary["mean_rank_gap"], 2.75)

    def test_missing_or_unreadable_blob_yields_nulls_not_an_error(self):
        """Every pre-campaign row has no response_json at all."""

        for blob in (None, "", "{ not json", "[1, 2, 3]"):
            with self.subTest(blob=blob):
                summary = battle_log.summarise_response(blob)

                for key, value in summary.items():
                    self.assertIsNone(
                        value,
                        f"{key} was invented from {blob!r}",
                    )

    def test_null_mean_rank_gaps_are_not_counted_as_zero(self):
        """A pair with no shared paper has no rank gap at all.

        Averaging its null as 0 would report that the pipelines agree
        closely in rank for a pair that never overlapped.
        """

        summary = battle_log.summarise_response(
            _response(
                pairwise=[(3, 2.0), (0, None), (1, 4.0)],
            ).model_dump_json()
        )

        # Mean of 2.0 and 4.0. Averaging the null gap in as 0 would
        # give 2.0 -- i.e. exactly the figure a reader would take away
        # as "the pairs agree closely".
        self.assertEqual(summary["pair_count"], 3)
        self.assertAlmostEqual(summary["mean_rank_gap"], 3.0)


class CsvExportTest(unittest.TestCase):
    def _parse(self, text: str) -> list[dict]:
        return list(csv.DictReader(io.StringIO(text)))

    def test_header_and_one_row_per_run(self):
        text = "".join(
            battle_log.iter_export(
                [
                    _run(id=1),
                    _run(id=2, winner_pipeline_id="sbert"),
                ],
                "csv",
            )
        )

        rows = self._parse(text)

        self.assertEqual(
            list(rows[0].keys()),
            list(battle_log.CSV_COLUMNS),
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["id"], "1")
        self.assertEqual(rows[1]["winner_pipeline_id"], "sbert")

    def test_carries_the_scalars_and_the_derived_figures(self):
        rows = self._parse(
            "".join(battle_log.iter_export([_run()], "csv"))
        )
        row = rows[0]

        self.assertEqual(row["run_label"], "campaign-ml-text-5")
        self.assertEqual(row["subject_class"], "Machine Learning")
        self.assertEqual(row["query_kind"], "text")
        self.assertEqual(row["top_k"], "5")
        self.assertEqual(row["corpus_size"], "145")
        self.assertEqual(row["corpus_version"], "v1-n145-abcdef123456")

        self.assertEqual(row["pipeline_count"], "3")
        self.assertEqual(row["consensus_size"], "3")
        self.assertEqual(row["mean_overlap"], "2.5")

    def test_a_query_with_commas_and_quotes_stays_one_cell(self):
        text = "".join(
            battle_log.iter_export(
                [_run(query='spectral "graphs", revisited')],
                "csv",
            )
        )

        rows = self._parse(text)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["query"], 'spectral "graphs", revisited')

    def test_custom_weights_render_as_one_readable_cell(self):
        rows = self._parse(
            "".join(
                battle_log.iter_export(
                    [
                        _run(
                            custom_weights=json.dumps(
                                {"tfidf": 0.1, "sbert": 0.9, "metadata": 0.0}
                            )
                        )
                    ],
                    "csv",
                )
            )
        )

        self.assertEqual(
            rows[0]["custom_weights"],
            "metadata=0.0; sbert=0.9; tfidf=0.1",
        )

    def test_a_run_without_a_response_exports_blank_derived_cells(self):
        rows = self._parse(
            "".join(
                battle_log.iter_export(
                    [_run(response_json=None)],
                    "csv",
                )
            )
        )

        self.assertEqual(rows[0]["run_label"], "campaign-ml-text-5")
        self.assertEqual(rows[0]["mean_overlap"], "")
        self.assertEqual(rows[0]["pair_count"], "")

    def test_rows_stream_one_at_a_time(self):
        """The export must not need the whole table in memory."""

        chunks = list(
            battle_log.iter_export([_run(id=index) for index in range(5)], "csv")
        )

        self.assertEqual(len(chunks), 6)
        self.assertTrue(chunks[0].startswith("id,created_at"))


class JsonlExportTest(unittest.TestCase):
    def test_one_object_per_line_with_the_full_response(self):
        text = "".join(
            battle_log.iter_export(
                [
                    _run(id=1),
                    _run(id=2, winner_pipeline_id="sbert"),
                ],
                "jsonl",
            )
        )

        self.assertEqual(len(text.strip().split("\n")), 2)

        first = json.loads(text.split("\n")[0])

        self.assertEqual(first["id"], 1)
        self.assertEqual(first["run_label"], "campaign-ml-text-5")

        # The whole point: the consensus and pairwise structure is in
        # the file, not just the winner summary.
        self.assertEqual(len(first["response"]["consensus"]), 3)
        self.assertEqual(len(first["response"]["pairwise"]), 2)
        self.assertEqual(len(first["response"]["pipelines"]), 3)
        self.assertEqual(
            first["response"]["winner"]["pipeline_id"],
            "tfidf",
        )

        # ...and the headline figures are available without walking it.
        self.assertEqual(first["summary"]["consensus_size"], 3)

    def test_a_run_without_a_response_still_exports(self):
        lines = battle_log.iter_export([_run(response_json=None)], "jsonl")

        record = json.loads("".join(lines))

        self.assertIsNone(record["response"])
        self.assertIsNone(record["summary"]["consensus_size"])

    def test_unknown_format_raises(self):
        with self.assertRaises(ValueError):
            list(battle_log.iter_export([], "xlsx"))


class WinSharesTest(unittest.TestCase):
    def test_share_is_wins_over_battles_in_the_group(self):
        shares = battle_log.win_shares(
            [
                _run(winner_pipeline_id="tfidf"),
                _run(winner_pipeline_id="tfidf"),
                _run(winner_pipeline_id="sbert"),
            ]
        )

        self.assertEqual(
            shares,
            [
                {
                    "pipeline_id": "tfidf",
                    "wins": 2,
                    "battles": 3,
                    "win_share": 0.6667,
                },
                {
                    "pipeline_id": "sbert",
                    "wins": 1,
                    "battles": 3,
                    "win_share": 0.3333,
                },
            ],
        )

    def test_no_battles_yields_no_entries(self):
        self.assertEqual(battle_log.win_shares([]), [])

    def test_a_pipeline_with_no_wins_is_absent_rather_than_zero(self):
        """Zero wins is a pipeline that never appeared in the group.

        Listing it with a 0% share would read as "it ran and lost",
        which is a claim the table does not support.
        """

        shares = battle_log.win_shares([_run(winner_pipeline_id="tfidf")])

        self.assertEqual(
            [entry["pipeline_id"] for entry in shares],
            ["tfidf"],
        )


class BattleStatsTest(unittest.TestCase):
    def test_overall_and_query_kind_splits(self):
        stats = battle_log.battle_stats(
            [
                _run(id=1, query_kind="text", winner_pipeline_id="tfidf"),
                _run(id=2, query_kind="text", winner_pipeline_id="tfidf"),
                _run(id=3, query_kind="seed", winner_pipeline_id="sbert"),
                _run(id=4, query_kind="seed", winner_pipeline_id="sbert"),
            ]
        )

        self.assertEqual(stats["total_runs"], 4)
        self.assertEqual(len(stats["overall"]), 2)
        self.assertEqual(stats["overall"][0]["win_share"], 0.5)

        by_kind = {
            entry["query_kind"]: entry
            for entry in stats["by_query_kind"]
        }

        self.assertEqual(sorted(by_kind), ["seed", "text"])
        self.assertEqual(by_kind["text"]["total_runs"], 2)
        self.assertEqual(
            by_kind["text"]["overall"][0]["pipeline_id"],
            "tfidf",
        )
        self.assertEqual(
            by_kind["seed"]["overall"][0]["pipeline_id"],
            "sbert",
        )

    def test_subject_class_split_and_label_counts(self):
        stats = battle_log.battle_stats(
            [
                _run(
                    id=1,
                    subject_class="Machine Learning",
                    run_label="campaign-ml-1",
                ),
                _run(
                    id=2,
                    subject_class="Machine Learning",
                    run_label="campaign-ml-2",
                ),
                _run(id=3, subject_class=None, run_label=None),
                _run(id=4, subject_class="  ", run_label="  "),
            ]
        )

        self.assertEqual(stats["total_runs"], 4)
        self.assertEqual(stats["labelled_runs"], 2)
        self.assertEqual(stats["classified_runs"], 2)

        by_class = {
            entry["subject_class"]: entry
            for entry in stats["by_subject_class"]
        }

        self.assertIn("Machine Learning", by_class)
        # Untagged rows are grouped, not dropped: they are still runs.
        self.assertIn(battle_log.UNTAGGED_LABEL, by_class)
        self.assertEqual(by_class["Machine Learning"]["total_runs"], 2)

    def test_a_single_battle_split_is_omitted_and_reported(self):
        """A one-battle share is 0% or 100%, which reads like a result."""

        stats = battle_log.battle_stats(
            [
                _run(id=1, subject_class="Machine Learning"),
                _run(id=2, subject_class="Machine Learning"),
                _run(id=3, subject_class="Data Mining"),
            ]
        )

        by_class = {
            entry["subject_class"]
            for entry in stats["by_subject_class"]
        }

        self.assertNotIn("Data Mining", by_class)

        omitted = {
            entry["label"]: entry
            for entry in stats["omitted"]["subject_class"]
        }

        self.assertIn("Data Mining", omitted)
        self.assertEqual(omitted["Data Mining"]["battles"], 1)

    def test_empty_history_is_reported_not_crashed(self):
        stats = battle_log.battle_stats([])

        self.assertEqual(stats["total_runs"], 0)
        self.assertEqual(stats["overall"], [])
        self.assertEqual(stats["by_query_kind"], [])


class CorpusStateTest(unittest.TestCase):
    """corpus_snapshot: the fingerprint every recorded run carries."""

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()

        # addCleanup is LIFO, so the session is registered first in
        # order to be closed last -- disposing the engine underneath an
        # open session is what makes SQLite complain.
        corpus_state.clear_cache()
        self.addCleanup(corpus_state.clear_cache)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

    def _paper(self, title: str, valid: bool = True):
        from app.models.models import Paper

        self.db.add(
            Paper(
                title=title,
                prepared_text=title,
                publication_year=2024,
                is_valid_for_recommendation=valid,
            )
        )
        self.db.commit()

    def test_counts_only_valid_papers(self):
        self._paper("valid one")
        self._paper("valid two")
        self._paper("not valid", valid=False)

        snapshot = corpus_state.corpus_snapshot(self.db, now=0.0)

        self.assertEqual(snapshot["corpus_size"], 2)

    def test_version_is_stable_for_an_unchanged_corpus(self):
        self._paper("valid one")

        first = corpus_state.corpus_snapshot(self.db, now=0.0)
        second = corpus_state.corpus_snapshot(self.db, now=1.0)

        self.assertEqual(
            first["corpus_version"],
            second["corpus_version"],
        )
        self.assertTrue(first["corpus_version"].startswith("v1-n1-"))

    def test_version_changes_when_the_corpus_grows(self):
        self._paper("valid one")
        before = corpus_state.corpus_snapshot(self.db, now=0.0)

        self._paper("valid two")
        after = corpus_state.corpus_snapshot(self.db, now=100.0)

        self.assertNotEqual(before["corpus_version"], after["corpus_version"])

    def test_snapshot_is_cached_but_expires(self):
        self._paper("valid one")

        corpus_state.clear_cache()
        first = corpus_state.corpus_snapshot(self.db, now=0.0)

        # A paper added mid-campaign must not be invisible for long.
        self._paper("valid two")
        cached = corpus_state.corpus_snapshot(self.db, now=1.0)
        self.assertEqual(cached["corpus_size"], first["corpus_size"])

        refreshed = corpus_state.corpus_snapshot(
            self.db,
            now=corpus_state.CACHE_TTL_SECONDS + 10.0,
        )
        self.assertEqual(refreshed["corpus_size"], 2)

    def test_a_broken_query_reports_no_corpus_rather_than_zero(self):
        with mock.patch.object(
            corpus_state,
            "_query",
            side_effect=RuntimeError("no such table"),
        ):
            snapshot = corpus_state.corpus_snapshot(self.db, now=0.0)

        # 0 would read as "the corpus was empty" and quietly drag a
        # mean down.
        self.assertIsNone(snapshot["corpus_size"])
        self.assertIsNone(snapshot["corpus_version"])


# ============================================================
# API
# ============================================================

class BattleLogApiTest(unittest.TestCase):
    """The four new routes plus the run write, against a temp DB."""

    def setUp(self):
        # File-backed (not :memory:) because TestClient runs the app in
        # a worker thread; an in-memory DB can't cross threads.
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)

        self.engine = create_engine(
            "sqlite:///"
            + os.path.join(
                self._temporary_directory.name,
                "battles.db",
            )
        )
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        self.db = self.factory()
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        corpus_state.clear_cache()
        self.addCleanup(corpus_state.clear_cache)

        # The export stream opens its own session, because FastAPI
        # closes the request dependency before a streaming body is
        # sent -- so the test has to redirect the factory too, or the
        # download would silently carry the real repository's history.
        from app import api

        patcher = mock.patch.object(api, "SessionLocal", self.factory)
        patcher.start()
        self.addCleanup(patcher.stop)

        # One valid paper, so a recorded run's corpus_size is a real
        # count rather than a fixture artefact.
        from app.models.models import Paper

        self.db.add(
            Paper(
                title="A valid paper",
                prepared_text="A valid paper",
                publication_year=2024,
                is_valid_for_recommendation=True,
            )
        )
        self.db.commit()

        # The archive route writes under storage/exports/. Point the
        # storage module at the temporary directory so a test run
        # cannot leave a file next to the real exports.
        from app.services import storage

        self._original_exports = storage.EXPORTS_DIR
        storage.EXPORTS_DIR = (
            Path(self._temporary_directory.name) / "exports"
        )
        self.addCleanup(
            setattr,
            storage,
            "EXPORTS_DIR",
            self._original_exports,
        )

    # ----------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------

    def _client(self):
        from fastapi.testclient import TestClient

        from app.api import app
        from app.database import get_session

        def override_get_session():
            yield self.db

        app.dependency_overrides[get_session] = override_get_session
        self.addCleanup(app.dependency_overrides.clear)

        return TestClient(app)

    def _seed_runs(self, count: int = 3):
        for index in range(count):
            self.db.add(
                BattleRun(
                    query=f"query {index}",
                    seed_paper_id=None,
                    top_k=5,
                    winner_pipeline_id=(
                        "tfidf" if index % 2 == 0 else "sbert"
                    ),
                    winner_metric="independence_weighted_consensus",
                    winner_value=0.7,
                    avg_consensus_rank=1.5,
                    run_label=f"campaign-{index}",
                    subject_class="Machine Learning",
                    query_kind="text",
                    response_json=_response().model_dump_json(),
                    corpus_size=145,
                    corpus_version="v1-n145-abcdef123456",
                )
            )

        self.db.commit()

    def _rows(self):
        return self.db.query(BattleRun).order_by(BattleRun.id).all()

    # ----------------------------------------------------------
    # Recording
    # ----------------------------------------------------------

    def test_a_recorded_battle_stores_the_whole_response(self):
        response = _response()

        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: response,
        ):
            result = client.post(
                "/api/recommendations/compare",
                json={
                    "query": "ranking",
                    "top_k": 5,
                    "run_label": "campaign-ml-text-5",
                    "subject_class": "Machine Learning",
                },
            )

        self.assertEqual(result.status_code, 200)

        rows = self._rows()

        self.assertEqual(len(rows), 1)

        run = rows[0]

        # The winner columns are unchanged -- the same values the
        # summary used to carry.
        self.assertEqual(run.winner_pipeline_id, "tfidf")
        self.assertEqual(run.winner_metric, "independence_weighted_consensus")
        self.assertEqual(run.winner_value, 0.75)
        self.assertEqual(run.avg_consensus_rank, 1.5)

        # ...and the agreement structure now survives the request.
        stored = json.loads(run.response_json)

        self.assertEqual(len(stored["consensus"]), 3)
        self.assertEqual(len(stored["pairwise"]), 2)
        self.assertEqual(len(stored["pipelines"]), 3)

    def test_a_recorded_battle_captures_its_provenance(self):
        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            client.post(
                "/api/recommendations/compare",
                json={
                    "query": "ranking",
                    "top_k": 5,
                    "run_label": "  campaign-ml-text-5  ",
                    "subject_class": "Machine Learning",
                },
            )

        run = self._rows()[0]

        self.assertEqual(run.run_label, "campaign-ml-text-5")
        self.assertEqual(run.subject_class, "Machine Learning")
        self.assertEqual(run.query_kind, "text")
        self.assertEqual(run.top_k, 5)
        # The fixture repository's own fingerprint, computed for real:
        # one valid paper, on index version 1.
        self.assertEqual(run.corpus_size, 1)
        self.assertTrue(run.corpus_version.startswith("v1-n1-"))

    def test_an_untagged_run_records_no_label(self):
        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            client.post(
                "/api/recommendations/compare",
                json={"query": "ranking", "top_k": 5},
            )

        run = self._rows()[0]

        self.assertIsNone(run.run_label)
        self.assertIsNone(run.subject_class)

    def test_a_blank_label_stores_null_not_empty_string(self):
        """An empty string reads as "labelled" to any presence check."""

        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            client.post(
                "/api/recommendations/compare",
                json={
                    "query": "ranking",
                    "top_k": 5,
                    "run_label": "   ",
                },
            )

        self.assertIsNone(self._rows()[0].run_label)

    def test_query_kind_is_seed_for_a_seed_run(self):
        from app.models.models import Paper

        seed = Paper(
            title="Seed",
            prepared_text="Seed",
            publication_year=2024,
            is_valid_for_recommendation=True,
        )
        self.db.add(seed)
        self.db.commit()

        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            response = client.post(
                "/api/recommendations/compare",
                json={
                    "seed_paper_id": seed.id,
                    "top_k": 5,
                    "run_label": "campaign-ml-seed-5",
                },
            )

        self.assertEqual(response.status_code, 200)

        run = self._rows()[0]

        self.assertEqual(run.query_kind, "seed")
        self.assertIsNone(run.query)

    def test_diversification_knobs_record_only_when_mmr_ran(self):
        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            client.post(
                "/api/recommendations/compare",
                json={"query": "ranking", "top_k": 5},
            )
            client.post(
                "/api/recommendations/compare",
                json={
                    "query": "ranking",
                    "top_k": 5,
                    "mmr_lambda": 0.7,
                    "mmr_pool": 30,
                    "custom_weights": {
                        "tfidf": 1,
                        "sbert": 0,
                        "metadata": 0,
                    },
                },
            )

        plain, diversified = self._rows()

        # The request's default pool must not be recorded as a choice
        # that was never made.
        self.assertIsNone(plain.mmr_pool)
        self.assertIsNone(plain.mmr_lambda)
        self.assertIsNone(plain.custom_weights)

        self.assertEqual(diversified.mmr_lambda, 0.7)
        self.assertEqual(diversified.mmr_pool, 30)
        self.assertEqual(
            json.loads(diversified.custom_weights),
            {"tfidf": 1.0, "sbert": 0.0, "metadata": 0.0},
        )

    def test_lab_simulations_are_still_not_recorded(self):
        """record_battle=false must keep the Lab out of the tally."""

        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: _response(),
        ):
            client.post(
                "/api/recommendations/compare",
                json={
                    "query": "ranking",
                    "top_k": 5,
                    "record_battle": False,
                },
            )

        self.assertEqual(self._rows(), [])

    def test_a_battle_with_no_winner_is_not_recorded(self):
        empty = _response()
        empty.winner = None

        client = self._client()

        with mock.patch(
            "app.api.compare_pipelines",
            lambda **kwargs: empty,
        ):
            client.post(
                "/api/recommendations/compare",
                json={"query": "ranking", "top_k": 5},
            )

        self.assertEqual(self._rows(), [])

    # ----------------------------------------------------------
    # Export
    # ----------------------------------------------------------

    def test_csv_export_is_one_row_per_run(self):
        self._seed_runs(3)

        response = self._client().get(
            "/api/evaluation/battles/export",
            params={"format": "csv"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.headers["content-type"])

        rows = list(
            csv.DictReader(
                io.StringIO(response.content.decode("utf-8"))
            )
        )

        self.assertEqual(len(rows), 3)
        self.assertEqual(
            list(rows[0].keys()),
            list(battle_log.CSV_COLUMNS),
        )
        self.assertEqual(rows[0]["run_label"], "campaign-0")
        self.assertEqual(rows[0]["consensus_size"], "3")

    def test_jsonl_export_carries_the_full_response(self):
        self._seed_runs(2)

        response = self._client().get(
            "/api/evaluation/battles/export",
            params={"format": "jsonl"},
        )

        self.assertEqual(response.status_code, 200)

        lines = response.content.decode("utf-8").strip().split("\n")

        self.assertEqual(len(lines), 2)

        record = json.loads(lines[0])

        self.assertEqual(len(record["response"]["consensus"]), 3)
        self.assertEqual(len(record["response"]["pairwise"]), 2)

    def test_export_is_named_and_downloadable(self):
        self._seed_runs(1)

        response = self._client().get(
            "/api/evaluation/battles/export",
            params={"format": "csv"},
        )

        disposition = response.headers["content-disposition"]

        self.assertIn("attachment", disposition)
        self.assertIn("battle_runs-", disposition)
        self.assertIn(".csv", disposition)

    def test_unknown_export_format_is_rejected(self):
        response = self._client().get(
            "/api/evaluation/battles/export",
            params={"format": "xlsx"},
        )

        self.assertEqual(response.status_code, 400)

    def test_export_of_an_empty_history_is_still_valid(self):
        response = self._client().get(
            "/api/evaluation/battles/export",
            params={"format": "csv"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("winner_pipeline_id", response.text)

    # ----------------------------------------------------------
    # Archive / delete
    # ----------------------------------------------------------

    def test_archive_writes_a_file_then_clears_the_table(self):
        self._seed_runs(3)

        response = self._client().post(
            "/api/evaluation/battles/archive"
        )

        self.assertEqual(response.status_code, 200)

        payload = response.json()

        self.assertEqual(payload["archived"], 3)
        self.assertEqual(payload["deleted"], 3)
        self.assertEqual(self._rows(), [])

        path = os.path.join(
            self._temporary_directory.name,
            "exports",
            payload["filename"],
        )

        self.assertTrue(os.path.exists(path), path)
        self.assertTrue(payload["filename"].endswith(".jsonl"))

        # The response carries a repo-relative path, not the machine's
        # absolute one, so a person reading the log can still find it.
        self.assertEqual(
            payload["path"],
            f"storage/exports/{payload['filename']}",
        )

        with open(path, "r", encoding="utf-8") as handle:
            records = [
                json.loads(line)
                for line in handle.read().strip().split("\n")
            ]

        self.assertEqual(len(records), 3)
        self.assertEqual(records[0]["run_label"], "campaign-0")
        self.assertEqual(len(records[0]["response"]["consensus"]), 3)

    def test_archive_of_an_empty_history_still_reports_cleanly(self):
        response = self._client().post(
            "/api/evaluation/battles/archive"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["archived"], 0)

    def test_delete_requires_explicit_confirmation(self):
        self._seed_runs(2)

        refused = self._client().delete(
            "/api/evaluation/battles"
        )

        self.assertEqual(refused.status_code, 400)
        self.assertEqual(len(self._rows()), 2)

    def test_delete_with_confirmation_clears_the_table(self):
        self._seed_runs(2)

        response = self._client().delete(
            "/api/evaluation/battles",
            params={"confirm": "true"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"], 2)
        self.assertEqual(self._rows(), [])

    # ----------------------------------------------------------
    # Stats
    # ----------------------------------------------------------

    def test_stats_report_win_shares_overall_and_by_query_kind(self):
        self._seed_runs(4)

        response = self._client().get(
            "/api/evaluation/battles/stats"
        )

        self.assertEqual(response.status_code, 200)

        payload = response.json()

        self.assertEqual(payload["total_runs"], 4)
        self.assertEqual(payload["labelled_runs"], 4)
        self.assertEqual(payload["classified_runs"], 4)

        overall = {
            entry["pipeline_id"]: entry
            for entry in payload["overall"]
        }

        self.assertEqual(overall["tfidf"]["wins"], 2)
        self.assertEqual(overall["tfidf"]["battles"], 4)
        self.assertAlmostEqual(overall["tfidf"]["win_share"], 0.5)

        by_kind = {
            entry["query_kind"]: entry
            for entry in payload["by_query_kind"]
        }

        self.assertEqual(by_kind["text"]["total_runs"], 4)
        self.assertAlmostEqual(
            by_kind["text"]["overall"][0]["win_share"],
            0.5,
        )

    def test_stats_on_an_empty_history(self):
        response = self._client().get(
            "/api/evaluation/battles/stats"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total_runs"], 0)

    # ----------------------------------------------------------
    # Existing history route
    # ----------------------------------------------------------

    def test_paginated_history_gains_the_research_columns(self):
        """Additive only: the old keys keep their values."""

        self._seed_runs(1)

        payload = self._client().get(
            "/api/evaluation/battles"
        ).json()

        run = payload["runs"][0]

        for key in (
            "id",
            "query",
            "seed_paper_id",
            "top_k",
            "winner_pipeline_id",
            "winner_metric",
            "winner_value",
            "avg_consensus_rank",
            "created_at",
        ):
            self.assertIn(key, run)

        self.assertEqual(run["run_label"], "campaign-0")
        self.assertEqual(run["query_kind"], "text")
        self.assertEqual(run["corpus_size"], 145)

        # The blob stays out of the paginated payload -- the JSONL
        # export is what moves it.
        self.assertNotIn("response_json", run)

        # The seeded run has no recorded margin, so it is not a decisive
        # win; it is reported under `verdicts` instead of in the tally.
        self.assertEqual(payload["tally"], [])
        self.assertEqual(sum(payload["verdicts"].values()), 1)


if __name__ == "__main__":
    unittest.main()

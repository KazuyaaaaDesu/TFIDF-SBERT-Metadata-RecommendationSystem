"""
One-time migration: adds the research-log columns to the existing
battle_runs table without touching any existing row.

Before this column set existed, the Arena wrote one row per battle
carrying only the winner's summary. The consensus votes, per-pipeline
ranks and pairwise overlaps were computed, sent to the browser, and
then thrown away. The columns added here preserve them, plus the run's
identity (label / subject class / query kind), the knobs it ran with
(mmr_lambda, mmr_pool, custom_weights) and the corpus it ran against
(corpus_size, corpus_version), which is what makes a past run analysable
after the fact. See app/models/models.py:BattleRun.

Nothing in the recommendation path reads these columns, so a database
that never runs this script still recommends exactly as before -- the
run write simply has nowhere to put the extra values. See the
"enrichment_notes" column's docstring for the same argument.

Usage:
    python scripts/migrate_add_battle_research_log.py

Safe to run more than once -- it checks whether each column already
exists first and skips the ones that do. Existing rows are never
updated except for query_kind, which is backfilled from `query IS NULL`
(a fact already stored on the row, not a new judgement).
"""

import os
import sqlite3

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))          # scripts/
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)                      # project root
DB_PATH = os.path.join(_PROJECT_ROOT, "app", "data", "academic_repository.db")
TABLE_NAME = "battle_runs"

# (column, SQLite type). Every one is nullable with no default: SQLite
# fills an added column with NULL, which is the honest value for a run
# that happened before the column existed.
NEW_COLUMNS = [
    ("run_label", "VARCHAR(200)"),
    ("subject_class", "VARCHAR(100)"),
    ("query_kind", "VARCHAR(20)"),
    ("mmr_lambda", "FLOAT"),
    ("mmr_pool", "INTEGER"),
    ("custom_weights", "TEXT"),
    ("response_json", "TEXT"),
    ("corpus_size", "INTEGER"),
    ("corpus_version", "VARCHAR(100)"),
]


def column_exists(cursor, table: str, column: str) -> bool:
    cursor.execute(f"PRAGMA table_info({table})")
    existing_columns = [row[1] for row in cursor.fetchall()]
    return column in existing_columns


def main():
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH} -- nothing to migrate.")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        cursor.execute(
            f"SELECT COUNT(*) FROM sqlite_master "
            f"WHERE type='table' AND name='{TABLE_NAME}'"
        )
        if not cursor.fetchone()[0]:
            print(
                f"'{TABLE_NAME}' does not exist yet -- run "
                f"scripts/init_script.py first. Nothing to do."
            )
            return

        added = []

        for column, column_type in NEW_COLUMNS:
            if column_exists(cursor, TABLE_NAME, column):
                continue

            cursor.execute(
                f"ALTER TABLE {TABLE_NAME} ADD COLUMN {column} {column_type}"
            )
            added.append(column)

        # --------------------------------------------------------
        # Backfill query_kind only.
        # --------------------------------------------------------
        # A run either carried query text or a seed paper (the route
        # rejects both at once), so this copies a fact already stored
        # on the row rather than inferring anything. Every other new
        # column stays NULL: a run label cannot be invented after the
        # fact, and guessing one would be worse than admitting the run
        # is untagged -- which is exactly the state that proves the
        # campaign's tally excludes pre-campaign walkthroughs.

        if column_exists(cursor, TABLE_NAME, "query_kind"):
            cursor.execute(
                f"UPDATE {TABLE_NAME} "
                f"SET query_kind = CASE "
                f"WHEN query IS NULL THEN 'seed' ELSE 'text' END "
                f"WHERE query_kind IS NULL"
            )
            backfilled = cursor.rowcount
        else:
            backfilled = 0

        conn.commit()

        if added:
            print(
                f"Added {len(added)} column(s) to {TABLE_NAME}: "
                f"{', '.join(added)}. Existing rows are untouched apart "
                f"from query_kind."
            )
        else:
            print(f"{TABLE_NAME} already has every research-log column.")

        print(
            f"Backfilled query_kind on {backfilled} row(s) from "
            f"`query IS NULL`."
        )

    finally:
        conn.close()


if __name__ == "__main__":
    main()

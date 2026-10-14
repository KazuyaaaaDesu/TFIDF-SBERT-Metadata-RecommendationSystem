from sqlalchemy import inspect, text
from app.database import engine

# Columns expected by the current pipeline-comparison code.
REQUIRED_COLUMNS = {
    "run_label": "TEXT",
    "subject_class": "TEXT",
    "query_kind": "TEXT",
    "mmr_lambda": "REAL",
    "mmr_pool": "INTEGER",
    "custom_weights": "TEXT",
    "response_json": "TEXT",
    "corpus_size": "INTEGER",
    "corpus_version": "TEXT",
    "margin": "REAL",
    "decisive": "INTEGER",
    "judged_basis": "TEXT",
    "judged_leader": "TEXT",
    "judgement_json": "TEXT",
}

with engine.begin() as connection:
    inspector = inspect(connection)

    if "battle_runs" not in inspector.get_table_names():
        raise RuntimeError(
            "Table battle_runs does not exist. "
            "Run your existing database initialization first."
        )

    existing_columns = {
        column["name"]
        for column in inspector.get_columns("battle_runs")
    }

    for column_name, column_type in REQUIRED_COLUMNS.items():
        if column_name not in existing_columns:
            connection.execute(
                text(
                    f'ALTER TABLE battle_runs '
                    f'ADD COLUMN "{column_name}" {column_type}'
                )
            )
            print(f"Added column: {column_name}")
        else:
            print(f"Already exists: {column_name}")

print("Migration completed.")
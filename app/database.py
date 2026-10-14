
"""
Database engine and session setup.

Uses SQLite as specified in the Data Layer (Chapter 3, 3.5.4).
create_all() creates missing tables, while additive migrations below
update existing tables without deleting their data.
"""

import os

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.models.models import Base


# ------------------------------------------------------------
# DATABASE PATH
# ------------------------------------------------------------

# Resolve relative to this file, not the current working directory.
_DB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "data",
)
os.makedirs(_DB_DIR, exist_ok=True)

# RESEARCH_DB_PATH can point to a separate database for testing.
_DB_PATH = os.environ.get("RESEARCH_DB_PATH") or os.path.join(
    _DB_DIR,
    "academic_repository.db",
)

DATABASE_URL = f"sqlite:///{_DB_PATH}"


# ------------------------------------------------------------
# DATABASE ENGINE
# ------------------------------------------------------------

engine = create_engine(
    DATABASE_URL,
    connect_args={
        "check_same_thread": False,
        # Wait for another writer rather than failing immediately.
        "timeout": 30,
    },
    pool_size=int(os.environ.get("DB_POOL_SIZE", "10")),
    max_overflow=int(os.environ.get("DB_POOL_OVERFLOW", "30")),
    pool_timeout=float(os.environ.get("DB_POOL_TIMEOUT", "30")),
    pool_pre_ping=True,
)


@event.listens_for(engine, "connect")
def _configure_sqlite(dbapi_connection, _connection_record):
    """Configure SQLite for concurrent reads and writes."""
    cursor = dbapi_connection.cursor()

    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA cache_size=-16000")
    finally:
        cursor.close()


# Keep ORM objects usable after a commit.
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    bind=engine,
)


# ------------------------------------------------------------
# USERS TABLE MIGRATION
# ------------------------------------------------------------

def _ensure_columns() -> None:
    """Add columns missing from the existing users table."""
    with engine.begin() as conn:
        columns = {
            row[1]
            for row in conn.execute(
                text("PRAGMA table_info(users)")
            )
        }

        if columns and "is_admin" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE users "
                    "ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"
                )
            )
            print("[DB MIGRATION] Added users.is_admin")


# ------------------------------------------------------------
# ADDITIVE SCHEMA MIGRATIONS
# ------------------------------------------------------------

# create_all() does not alter existing tables. These definitions
# describe columns that may be missing from older database files.
#
# SQLite supports ALTER TABLE ... ADD COLUMN. Existing records are
# retained, and nullable columns remain NULL for historical records
# unless a default is explicitly specified.

_ADDED_COLUMNS = {
    "battle_runs": [
        # Research run identity
        ("run_label", "VARCHAR(200)"),
        ("subject_class", "VARCHAR(100)"),
        ("query_kind", "VARCHAR(20)"),

        # Recommendation settings
        ("mmr_lambda", "FLOAT"),
        ("mmr_pool", "INTEGER"),
        ("custom_weights", "TEXT"),

        # Full comparison results and corpus snapshot
        ("response_json", "TEXT"),
        ("corpus_size", "INTEGER"),
        ("corpus_version", "VARCHAR(100)"),

        # Evaluation verdict and judging
        ("margin", "FLOAT"),
        ("decisive", "BOOLEAN"),
        ("judged_basis", "VARCHAR(16)"),
        ("judged_leader", "VARCHAR(50)"),
        ("judgement_json", "TEXT"),
    ],
    "tournament_runs": [
        ("status", "VARCHAR(16) NOT NULL DEFAULT 'done'"),
        ("progress_done", "INTEGER NOT NULL DEFAULT 0"),
        ("progress_total", "INTEGER NOT NULL DEFAULT 0"),
        ("settings_json", "TEXT"),
        ("error", "TEXT"),
        ("busy_seconds", "FLOAT NOT NULL DEFAULT 0"),
        ("finished_at", "DATETIME"),
    ],
}


def _ensure_added_columns() -> None:
    """
    Add missing columns to existing tables.

    This function is idempotent: running it again does not add
    duplicate columns. A single transaction covers all additions.
    """
    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            # Table names come from the fixed dictionary above.
            existing = {
                row[1]
                for row in conn.execute(
                    text(f'PRAGMA table_info("{table}")')
                )
            }

            # create_all() creates tables missing from the database.
            if not existing:
                continue

            for name, ddl in columns:
                if name in existing:
                    continue

                # Column names and definitions come from the fixed
                # migration dictionary, not from user input.
                conn.execute(
                    text(
                        f'ALTER TABLE "{table}" '
                        f'ADD COLUMN "{name}" {ddl}'
                    )
                )

                print(
                    f"[DB MIGRATION] Added {table}.{name}"
                )

                # Keep the in-memory set in sync for this run.
                existing.add(name)


# ------------------------------------------------------------
# AUTHOR BACKFILL
# ------------------------------------------------------------

def backfill_authors() -> int:
    """
    Structure the author string of papers that have no author rows.

    Existing display strings are preserved. Only papers without
    existing paper_authors entries are processed.

    Returns the number of papers structured.
    """
    from app.models.models import Paper, PaperAuthor, _author_rows
    from app.services.author_names import parse_author_list

    with SessionLocal() as session:
        # Prevent synchronization hooks from rewriting display strings.
        session.info["skip_author_sync"] = True

        have = {
            row[0]
            for row in session.query(
                PaperAuthor.paper_id
            ).distinct()
        }

        done = 0

        papers = session.query(Paper).filter(
            Paper.author.isnot(None),
            Paper.author != "",
        )

        for paper in papers:
            if paper.id in have:
                continue

            names = parse_author_list(paper.author)

            if not names:
                continue

            paper.authors = _author_rows(names)
            done += 1

        session.commit()

    if done:
        print(f"[DB MIGRATION] Backfilled authors for {done} papers")

    return done


# ------------------------------------------------------------
# DATABASE INITIALIZATION
# ------------------------------------------------------------

def init_db() -> None:
    """
    Create missing tables and migrate existing tables.

    Migration order:
    1. Create missing tables from the current SQLAlchemy models.
    2. Add the users.is_admin column if needed.
    3. Add missing battle_runs and tournament_runs columns.
    4. Backfill structured author records.
    """
    Base.metadata.create_all(bind=engine)

    _ensure_columns()
    _ensure_added_columns()
    backfill_authors()


# ------------------------------------------------------------
# DATABASE SESSION DEPENDENCY
# ------------------------------------------------------------

def get_session():
    """
    FastAPI dependency that yields a SQLAlchemy database session.
    """
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()

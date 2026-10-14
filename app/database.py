#"""
#Database engine and session setup.

#Uses SQLite as specified in the Data Layer (Chapter 3, 3.5.4).
#create_all() is used instead of Alembic migrations since the schema is
#fixed for the scope of this thesis prototype.


import os

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.models.models import Base

# Resolved relative to this file's own folder (app/), not the current
# working directory -- so the database is always found at app/data/
# regardless of where a script that imports this module is run from.
_DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(_DB_DIR, exist_ok=True)
# RESEARCH_DB_PATH points the app at another database file (a throwaway copy
# for testing destructive actions, say). Unset, it is app/data/.
_DB_PATH = os.environ.get("RESEARCH_DB_PATH") or os.path.join(
    _DB_DIR, "academic_repository.db"
)
DATABASE_URL = f"sqlite:///{_DB_PATH}"

# check_same_thread=False is needed because frameworks like FastAPI/Flask
# may handle a single SQLite connection across different threads.
#
# Pool sizing: SQLAlchemy's defaults (5 + 10 overflow, 30s checkout timeout)
# are far too small for this app. Every request holds a connection for its
# whole lifetime, and recommendation requests can hold it for seconds while
# vectorizing/scoring, so a modest burst of parallel clicks exhausted the
# pool and every following request failed with a 30s QueuePool timeout
# (observed as a wall of 500s during stress testing).
engine = create_engine(
    DATABASE_URL,
    connect_args={
        "check_same_thread": False,
        # pysqlite default is 5s; wait out a competing writer instead of
        # raising "database is locked" the moment a write collides.
        "timeout": 30,
    },
    pool_size=int(os.environ.get("DB_POOL_SIZE", "10")),
    max_overflow=int(os.environ.get("DB_POOL_OVERFLOW", "30")),
    pool_timeout=float(os.environ.get("DB_POOL_TIMEOUT", "30")),
    pool_pre_ping=True,
)


@event.listens_for(engine, "connect")
def _configure_sqlite(dbapi_connection, _connection_record):
    """Per-connection pragmas for a read-heavy, concurrently-written SQLite DB."""
    cursor = dbapi_connection.cursor()
    try:
        # WAL lets readers proceed while a writer commits -- without it a
        # single in-flight write blocks every concurrent reader.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA cache_size=-16000")
    finally:
        cursor.close()


# expire_on_commit=False keeps ORM objects usable after commit() so a
# request can commit (releasing its connection back to the pool) before
# doing expensive CPU/GPU work, instead of pinning a connection for the
# whole request.
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    bind=engine,
)


def _ensure_columns() -> None:
    """Additive schema tweaks for databases created before a column existed.

    create_all() only creates missing tables -- it never ALTERs an
    existing one -- so columns added after the first release are
    patched in here (SQLite supports ADD COLUMN directly).
    """
    with engine.connect() as conn:
        columns = {
            row[1]
            for row in conn.execute(text("PRAGMA table_info(users)"))
        }

        if "is_admin" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE users "
                    "ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"
                )
            )
            conn.commit()


def backfill_authors() -> int:
    """Structure the author string of every paper that has none yet.

    ``paper_authors`` is new, so papers stored before it have a
    ``papers.author`` string and no parts. Re-assigning the same text
    would not register as a change, so the parts are built directly.
    Idempotent: only papers without any author row are touched.
    Returns the number of papers structured.
    """
    from app.models.models import Paper, PaperAuthor, _author_rows
    from app.services.author_names import parse_author_list

    with SessionLocal() as session:
        # Keep the stored display strings exactly as they are.
        session.info["skip_author_sync"] = True
        have = {
            row[0]
            for row in session.query(PaperAuthor.paper_id).distinct()
        }
        done = 0

        for paper in session.query(Paper).filter(
            Paper.author.isnot(None), Paper.author != ""
        ):
            if paper.id in have:
                continue

            names = parse_author_list(paper.author)

            if not names:
                continue

            paper.authors = _author_rows(names)
            done += 1

        session.commit()

    return done


# Columns added to tables that may already exist in a user's database
# (create_all never alters an existing table). SQLite supports ADD COLUMN;
# each default is what an already-stored row should read as.
_ADDED_COLUMNS = {
    "battle_runs": [
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
    with engine.connect() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {
                row[1]
                for row in conn.execute(text(f"PRAGMA table_info({table})"))
            }

            if not existing:
                continue  # table not created yet; create_all makes it whole

            for name, ddl in columns:
                if name not in existing:
                    conn.execute(
                        text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                    )

        conn.commit()


def init_db() -> None:
    """Create all tables if they don't already exist."""
    Base.metadata.create_all(bind=engine)
    _ensure_columns()
    _ensure_added_columns()
    backfill_authors()


def get_session():
    """
    Dependency-style generator for use with FastAPI's Depends(),
    or call next(get_session()) manually in scripts.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

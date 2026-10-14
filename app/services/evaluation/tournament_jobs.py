"""
Durable tournaments.

A tournament scores every pipeline on hundreds of queries, which takes
minutes. Run inside one web request it dies with the connection: a
laptop that goes to sleep, a page reload or a closed tab loses the lot.

Here a run is a *job* that lives on the server and is saved as it goes:

    - ``create_run`` chooses the queries, writes a ``TournamentRun`` row
      (settings and the chosen query ids included) and returns at once;
    - a worker thread scores the queries one by one and commits each
      query's scores the moment they exist;
    - the client polls ``status_payload`` and can attach, detach and
      re-attach at will (the run does not depend on any browser);
    - if the server itself stops, ``mark_interrupted`` flags the orphaned
      run on the next start and ``resume_run`` continues it from the
      first unscored query. Nothing already scored is redone.

When the last query is done, the verdict is computed from the stored
scores (``tournament.assemble_result``), exactly as for a one-shot run.

The worker takes a session *factory*, because every thread needs its own
database session. The search callable is injectable for tests.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import Callable

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.models import TournamentQueryScore, TournamentRun
from app.services.evaluation import loo_qrels, stats, tournament
from app.services.evaluation.corpus_state import corpus_snapshot
from app.services.recommendation.pipeline_config import PIPELINE_NAMES

STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_INTERRUPTED = "interrupted"
STATUS_ERROR = "error"

# In-process state only: which runs have a live worker, which were asked
# to stop, and what each is doing right now. None of it needs to survive
# a restart -- the database row is the source of truth.
_LOCK = threading.Lock()
_THREADS: dict[int, threading.Thread] = {}
_STOP: set[int] = set()
_NOW: dict[int, dict] = {}

SessionFactory = Callable[[], Session]


# ------------------------------------------------------------
# Creating and starting
# ------------------------------------------------------------


def create_run(
    db: Session,
    *,
    pipelines=None,
    top_k: int = 10,
    n_queries: int = tournament.DEFAULT_QUERIES,
    min_refs: int = loo_qrels.DEFAULT_MIN_REFS,
    primary_metric: str = "ndcg",
    seed: int = 0,
    alpha: float = stats.DEFAULT_ALPHA,
    resamples: int = 2000,
    custom_weights: dict[str, float] | None = None,
    label: str | None = None,
    queries: list[loo_qrels.LooQuery] | None = None,
) -> TournamentRun:
    """
    Choose the queries and write the run, without starting it.

    Raises ``ValueError`` for bad arguments or when the repository has
    fewer than two usable queries (so a run that could never produce a
    verdict is refused up front, not after minutes of work).
    """

    names = tournament._validate(
        list(pipelines) if pipelines else list(PIPELINE_NAMES),
        top_k,
        primary_metric,
        custom_weights,
    )

    if not 2 <= n_queries <= tournament.MAX_QUERIES:
        raise ValueError(
            f"n_queries must be between 2 and {tournament.MAX_QUERIES}."
        )

    pool = (
        queries
        if queries is not None
        else loo_qrels.build_loo_queries(
            db, n=n_queries, min_refs=min_refs, seed=seed
        )
    )

    if len(pool) < 2:
        raise ValueError(
            "Fewer than two papers have enough resolved references "
            f"(need at least {min_refs} each). Link references or gather "
            "literature first."
        )

    corpus = corpus_snapshot(db)
    settings = {
        "pipelines": names,
        "top_k": top_k,
        "primary_metric": primary_metric,
        "seed": seed,
        "alpha": alpha,
        "resamples": resamples,
        "min_refs": min_refs,
        "custom_weights": custom_weights,
        "label": label,
        "query_ids": [q.seed_paper_id for q in pool],
        "dropped": [],
    }

    run = TournamentRun(
        kind=tournament.KIND_LOO,
        label=(label or None) and str(label)[:120],
        primary_metric=primary_metric,
        top_k=top_k,
        n_queries=len(pool),
        dropped_queries=0,
        min_refs=min_refs,
        seed=seed,
        pipelines=json.dumps(names),
        outcome="pending",
        result_json="{}",
        corpus_size=corpus["corpus_size"],
        corpus_version=corpus["corpus_version"],
        status=STATUS_INTERRUPTED,  # until a worker actually starts
        progress_done=0,
        progress_total=len(pool),
        settings_json=json.dumps(settings),
    )
    db.add(run)
    db.commit()

    return run


def start_run(
    session_factory: SessionFactory,
    run_id: int,
    *,
    run_search=None,
    queries: list[loo_qrels.LooQuery] | None = None,
) -> bool:
    """Start (or resume) the worker for ``run_id``. False if one is live."""

    with _LOCK:
        thread = _THREADS.get(run_id)

        if thread is not None and thread.is_alive():
            return False

        _STOP.discard(run_id)
        worker = threading.Thread(
            target=_execute,
            args=(session_factory, run_id, run_search, queries),
            daemon=True,
            name=f"tournament-{run_id}",
        )
        _THREADS[run_id] = worker

    # Flip to running before returning so the first status poll is right.
    with session_factory() as db:
        run = db.get(TournamentRun, run_id)

        if run is None:
            return False

        run.status = STATUS_RUNNING
        run.error = None
        run.finished_at = None
        db.commit()

    worker.start()

    return True


def stop_run(run_id: int) -> bool:
    """Ask a live worker to stop after its current query. The run is
    left ``interrupted`` and can be resumed."""

    with _LOCK:
        thread = _THREADS.get(run_id)

        if thread is None or not thread.is_alive():
            return False

        _STOP.add(run_id)

        return True


def mark_interrupted(db: Session) -> int:
    """Flag runs left ``running`` by a server that stopped. Call at
    startup, before any worker exists. Returns how many were flagged."""

    runs = (
        db.query(TournamentRun)
        .filter(TournamentRun.status == STATUS_RUNNING)
        .all()
    )

    for run in runs:
        run.status = STATUS_INTERRUPTED

    db.commit()

    return len(runs)


def _settings_of(run: TournamentRun) -> dict | None:
    """The settings needed to re-run the statistics: the saved ones, or --
    for runs made before settings were saved -- rebuilt from the run's own
    stored result (which records the pipelines, metric, k, seed and
    resamples it was analysed with)."""

    if run.settings_json:
        return json.loads(run.settings_json)

    try:
        saved = json.loads(run.result_json or "{}")
        verdict = saved["verdict"]
        return {
            "pipelines": saved["pipelines"],
            "top_k": saved["top_k"],
            "primary_metric": saved["primary_metric"],
            "seed": saved["seed"],
            "min_refs": saved.get("min_refs") or run.min_refs or 0,
            "alpha": verdict.get("alpha", stats.DEFAULT_ALPHA),
            "resamples": verdict.get("resamples") or 2000,
            "label": saved.get("label"),
            "dropped": saved.get("dropped", []),
            "custom_weights": saved.get("custom_weights"),
        }
    except (KeyError, TypeError, ValueError):
        return None


def reanalyze_run(db: Session, run_id: int) -> bool:
    """
    Recompute a finished run's statistics from its stored per-query scores.

    The scores never change; the analysis can (for example when a better
    test replaced a worse one for 0/1 metrics). This re-derives the verdict
    with the current code and overwrites the stored one. Returns False for
    a run that is not finished or was not created as a durable job (it has
    no saved settings to rebuild from).
    """

    run = db.get(TournamentRun, run_id)

    if run is None or run.status != STATUS_DONE:
        return False

    settings = _settings_of(run)

    if settings is None:
        return False

    _finalize(db, run, settings)

    return run.status == STATUS_DONE


def discard_run(db: Session, run_id: int) -> bool:
    """Delete an unfinished run and its scores. Finished runs are kept."""

    run = db.get(TournamentRun, run_id)

    if run is None or run.status == STATUS_DONE:
        return False

    with _LOCK:
        thread = _THREADS.get(run_id)

        if thread is not None and thread.is_alive():
            return False  # stop it first

    db.query(TournamentQueryScore).filter(
        TournamentQueryScore.run_id == run_id
    ).delete()
    db.delete(run)
    db.commit()

    return True


# ------------------------------------------------------------
# The worker
# ------------------------------------------------------------


def _scored_ids(db: Session, run_id: int) -> set[int]:
    return {
        row[0]
        for row in db.query(TournamentQueryScore.seed_paper_id)
        .filter(TournamentQueryScore.run_id == run_id)
        .distinct()
    }


def _execute(session_factory, run_id, run_search, preset_queries) -> None:
    db = session_factory()

    try:
        _work(db, run_id, run_search, preset_queries)
    except Exception as error:  # the run stays resumable
        db.rollback()
        print(f"TOURNAMENT {run_id} FAILED: {error}")
        run = db.get(TournamentRun, run_id)

        if run is not None:
            run.status = STATUS_ERROR
            run.error = str(error)[:500]
            run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()

        with _LOCK:
            _STOP.discard(run_id)
            _NOW.pop(run_id, None)


def _work(db, run_id, run_search, preset_queries) -> None:
    run = db.get(TournamentRun, run_id)
    settings = json.loads(run.settings_json)
    names = settings["pipelines"]
    top_k = settings["top_k"]
    custom_weights = settings.get("custom_weights")
    search = run_search or tournament._default_search()

    ids = settings["query_ids"]
    available = {
        q.seed_paper_id: q
        for q in (
            preset_queries
            if preset_queries is not None
            else loo_qrels.build_loo_queries(
                db, min_refs=settings["min_refs"], paper_ids=ids
            )
        )
    }

    finished = _scored_ids(db, run_id) | {
        item["seed_paper_id"] for item in settings["dropped"]
    }

    for position, paper_id in enumerate(ids):
        if paper_id in finished:
            continue

        with _LOCK:
            if run_id in _STOP:
                run.status = STATUS_INTERRUPTED
                db.commit()

                return

        query = available.get(paper_id)
        began = time.monotonic()

        with _LOCK:
            _NOW[run_id] = {
                "title": (query.title if query else "") or f"paper {paper_id}",
                "position": position + 1,
            }

        if query is None:
            per_pipeline, reason = None, "no longer eligible"
        else:
            per_pipeline, reason = tournament.score_query(
                db,
                query,
                names,
                top_k=top_k,
                search=search,
                custom_weights=custom_weights,
            )

        if per_pipeline is None:
            settings["dropped"].append(
                {"seed_paper_id": paper_id, "reason": reason}
            )
            run.settings_json = json.dumps(settings)
        else:
            db.add_all(
                TournamentQueryScore(
                    run_id=run_id,
                    pipeline_id=name,
                    seed_paper_id=paper_id,
                    num_relevant=len(query.relevance),
                    ndcg=values["ndcg"],
                    mrr=values["mrr"],
                    recall=values["recall"],
                    hit=values["hit"],
                )
                for name, values in per_pipeline.items()
            )

        run.progress_done = len(finished) + 1
        run.dropped_queries = len(settings["dropped"])
        run.busy_seconds = (run.busy_seconds or 0.0) + (
            time.monotonic() - began
        )
        finished.add(paper_id)
        db.commit()  # this query is now safe, whatever happens next

    _finalize(db, run, settings)


def _finalize(db: Session, run: TournamentRun, settings: dict) -> None:
    names = settings["pipelines"]
    scores = {name: {key: [] for key in tournament.METRIC_KEYS} for name in names}

    rows = (
        db.query(TournamentQueryScore)
        .filter(TournamentQueryScore.run_id == run.id)
        .order_by(
            TournamentQueryScore.seed_paper_id, TournamentQueryScore.pipeline_id
        )
        .all()
    )

    for row in rows:
        for key in tournament.METRIC_KEYS:
            scores[row.pipeline_id][key].append(getattr(row, key))

    try:
        result = tournament.assemble_result(
            names=names,
            scores=scores,
            dropped=settings["dropped"],
            top_k=settings["top_k"],
            primary_metric=settings["primary_metric"],
            min_refs=settings["min_refs"],
            seed=settings["seed"],
            alpha=settings["alpha"],
            resamples=settings["resamples"],
            label=settings.get("label"),
        )
    except ValueError as error:
        run.status = STATUS_ERROR
        run.error = str(error)
        run.finished_at = datetime.utcnow()
        db.commit()

        return

    result["run_id"] = run.id
    verdict = result["verdict"]

    run.result_json = json.dumps(
        {**result, "custom_weights": settings.get("custom_weights")}
    )
    run.n_queries = result["n_queries"]
    run.outcome = verdict["outcome"]
    run.winner_pipeline_id = verdict["winner"]
    run.status = STATUS_DONE
    run.error = None
    run.finished_at = datetime.utcnow()
    db.commit()


# ------------------------------------------------------------
# Reading status
# ------------------------------------------------------------


def _partial_means(db: Session, run: TournamentRun) -> dict[str, float]:
    column = getattr(TournamentQueryScore, run.primary_metric)

    return {
        pipeline: float(mean)
        for pipeline, mean in db.query(
            TournamentQueryScore.pipeline_id, func.avg(column)
        )
        .filter(TournamentQueryScore.run_id == run.id)
        .group_by(TournamentQueryScore.pipeline_id)
    }


def status_payload(db: Session, run: TournamentRun) -> dict:
    """The live view of a run: progress, rate, estimate, running means."""

    done = run.progress_done or 0
    total = run.progress_total or run.n_queries or 0
    busy = run.busy_seconds or 0.0
    per_query = busy / done if done else None
    remaining = max(0, total - done)

    with _LOCK:
        live = _THREADS.get(run.id)
        now = dict(_NOW.get(run.id, {}))
        worker_alive = live is not None and live.is_alive()

    status = run.status

    # A row that says "running" with no worker behind it is a run whose
    # server went away (and has not restarted through mark_interrupted).
    if status == STATUS_RUNNING and not worker_alive:
        status = STATUS_INTERRUPTED

    return {
        "run_id": run.id,
        "status": status,
        "label": run.label,
        "pipelines": json.loads(run.pipelines),
        "primary_metric": run.primary_metric,
        "top_k": run.top_k,
        "done": done,
        "total": total,
        "dropped": run.dropped_queries or 0,
        "busy_seconds": round(busy, 1),
        "seconds_per_query": round(per_query, 2) if per_query else None,
        "eta_seconds": (
            round(per_query * remaining) if per_query is not None else None
        ),
        "current": now or None,
        "partial_means": _partial_means(db, run),
        "outcome": run.outcome if status == STATUS_DONE else None,
        "winner_pipeline_id": run.winner_pipeline_id,
        "error": run.error,
        "created_at": run.created_at.isoformat(),
    }


def latest_unfinished(db: Session) -> TournamentRun | None:
    """The newest run that is not done (running, interrupted or failed)."""

    return (
        db.query(TournamentRun)
        .filter(TournamentRun.status != STATUS_DONE)
        .order_by(TournamentRun.id.desc())
        .first()
    )

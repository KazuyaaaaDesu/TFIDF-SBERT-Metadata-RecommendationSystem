"""
Battle-run export and statistics -- the Chapter IV aggregates.

``battle_runs`` is a flat table of one row per Arena battle, so every
question the evaluation chapter asks ("which pipeline wins text
queries", "does the hybrid still win within a single subject class",
"how often do the two lexical pipelines agree at top-10") is either a
group-by over that table or a reshape of the ``response_json`` blob
each row now carries.

Everything in this module is pure: it takes plain dicts (one per run)
and returns strings or dictionaries. No session, no file, no request.
The API layer supplies the rows and does the streaming, which keeps
the interesting part -- what a row means in the thesis -- testable
without a database or an HTTP client.

Two export shapes, deliberately different:

    - ``csv``:  one row per run, flattened and spreadsheet-friendly.
               The ranked lists are summed into counts and averages so
               the file stays wide-and-short; nothing is dropped that
               a cell could carry.
    - ``jsonl``: one JSON object per line, each carrying the run's
               ``response_json`` in full, so no computed structure is
               lost. The flattened numbers appear again as ``summary``
               so a consumer that only reads one shape still gets the
               headline figures.

The row dicts here carry the same keys ``GET /api/evaluation/battles``
returns, plus the research-log columns. ``query_kind`` is nullable
because the pre-campaign rows predate the backfill on some databases;
every aggregation treats a missing value as its own bucket rather than
dropping the run, since silently dropping data from a results table is
worse than an ``(untagged)`` label.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterable, Iterator, Mapping, Sequence

# The scalar columns, in the order a spreadsheet wants them: identity
# first (when it was run and what it was called), then what was asked,
# then the knobs, then the outcome, then the corpus it happened on.
SCALAR_COLUMNS: tuple[str, ...] = (
    "id",
    "created_at",
    "run_label",
    "subject_class",
    "query_kind",
    "query",
    "seed_paper_id",
    "top_k",
    "winner_pipeline_id",
    "winner_metric",
    "winner_value",
    "avg_consensus_rank",
    "mmr_lambda",
    "mmr_pool",
    "custom_weights",
    "corpus_size",
    "corpus_version",
    "margin",
    "decisive",
    "judged_basis",
    "judged_leader",
)

# Header of the CSV export: the scalars, then the derived columns.
# The derived ones come last because they are computed, not stored --
# someone reading only the first twenty-one knows they are looking at
# values straight out of the table.
CSV_COLUMNS: tuple[str, ...] = SCALAR_COLUMNS + (
    "pipeline_count",
    "consensus_size",
    "mean_consensus_votes",
    "top_consensus_votes",
    "top_consensus_paper_id",
    "pair_count",
    "mean_overlap",
    "mean_rank_gap",
)

EXPORT_FORMATS: tuple[str, ...] = ("csv", "jsonl")

# A win share from a single battle is either 0.0 or 1.0, which reads
# like a finding and is not one. Splits thinner than this are left out
# of /stats and the omission is visible in the payload's `omitted`
# list, so the number of battles behind every reported share stays
# inspectable and no bucket can be mistaken for a measurement.
MIN_BATTLES_PER_SPLIT = 2

# Bucket label for a run with no subject class. A run still counts; it
# just is not attributed to a class.
UNTAGGED_LABEL = "(untagged)"

ROUND_PLACES = 4


def _number(value: float | None, places: int = ROUND_PLACES) -> float | None:
    if value is None:
        return None

    return round(float(value), places)


def _mean(values: Sequence[float]) -> float | None:
    if not values:
        return None

    return sum(values) / len(values)


def bucket_label(value: object, fallback: str = UNTAGGED_LABEL) -> str:
    """A run's group name, or the untagged label when it has none.

    An empty string is treated as untagged too: a text field that was
    focused and cleared would otherwise become its own bucket in the
    export and its own row in /stats.
    """

    if value is None:
        return fallback

    text = str(value).strip()

    return text or fallback


def summarise_response(response_json: str | None) -> dict:
    """Headline figures from one stored CompareResponse.

    Everything here is derived from a blob that already exists on the
    row -- no ranking, scoring or consensus is redone, and nothing
    this returns feeds back into a battle. Unparseable or missing
    blobs (every pre-campaign run) yield all-None rather than an
    error, so a partial history still exports.
    """

    empty = {
        "pipeline_count": None,
        "consensus_size": None,
        "mean_consensus_votes": None,
        "top_consensus_votes": None,
        "top_consensus_paper_id": None,
        "pair_count": None,
        "mean_overlap": None,
        "mean_rank_gap": None,
    }

    if not response_json:
        return empty

    try:
        payload = json.loads(response_json)
    except (TypeError, ValueError):
        return empty

    if not isinstance(payload, dict):
        return empty

    consensus = payload.get("consensus")
    consensus = consensus if isinstance(consensus, list) else []

    pairwise = payload.get("pairwise")
    pairwise = pairwise if isinstance(pairwise, list) else []

    pipelines = payload.get("pipelines")
    pipelines = pipelines if isinstance(pipelines, list) else []

    votes = [
        float(entry["votes"])
        for entry in consensus
        if isinstance(entry, dict)
        and isinstance(entry.get("votes"), (int, float))
    ]

    top = next(
        (
            entry
            for entry in consensus
            if isinstance(entry, dict) and isinstance(entry.get("votes"), (int, float))
        ),
        None,
    )

    overlaps = [
        float(pair["overlap"])
        for pair in pairwise
        if isinstance(pair, dict)
        and isinstance(pair.get("overlap"), (int, float))
    ]

    # A pair with no shared paper carries no mean rank gap; averaging
    # those nulls as zeros would report "the pipelines agree in rank"
    # for a pair that never overlapped at all.
    rank_gaps = [
        float(pair["mean_rank_gap"])
        for pair in pairwise
        if isinstance(pair, dict)
        and isinstance(pair.get("mean_rank_gap"), (int, float))
    ]

    return {
        "pipeline_count": len(pipelines) or None,
        "consensus_size": len(consensus) or None,
        "mean_consensus_votes": _number(_mean(votes), 2),
        "top_consensus_votes": (
            int(top["votes"])
            if top is not None and isinstance(top.get("votes"), (int, float))
            else None
        ),
        "top_consensus_paper_id": (
            top.get("paper_id") if top is not None else None
        ),
        "pair_count": len(pairwise) or None,
        "mean_overlap": _number(_mean(overlaps), 2),
        "mean_rank_gap": _number(_mean(rank_gaps), 2),
    }


def custom_weights_text(run: Mapping) -> str:
    """``custom_weights`` as one flat cell, or empty for a preset run.

    The column stores JSON, which a spreadsheet shows as an object
    literal. Rendering it as ``tfidf=0.10; sbert=0.90`` keeps the CSV
    readable and sortable without asking the reader to parse JSON.
    """

    raw = run.get("custom_weights")

    if not raw:
        return ""

    try:
        weights = json.loads(raw)
    except (TypeError, ValueError):
        return str(raw)

    if not isinstance(weights, dict):
        return str(raw)

    return "; ".join(
        f"{signal}={_number(weights[signal], 4)}"
        for signal in sorted(weights)
        if weights[signal] is not None
    )


def csv_row(run: Mapping) -> dict:
    """One flattened CSV record: scalars plus the derived figures."""

    row = {
        column: run.get(column)
        for column in SCALAR_COLUMNS
    }

    row["custom_weights"] = custom_weights_text(run)
    row.update(summarise_response(run.get("response_json")))

    return row


def csv_line(run: Mapping) -> str:
    """One CSV record, already newline-terminated.

    Written by hand rather than through ``csv.writer`` per row so a
    streaming export can emit records one at a time and never hold
    more than one in memory. The quoting rules are csv.QUOTE_MINIMAL
    with \\r\\n line endings, which is what ``csv.writer`` produces for
    the same values.
    """

    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=list(CSV_COLUMNS),
        lineterminator="\r\n",
        restval="",
    )
    writer.writerow(csv_row(run))

    return buffer.getvalue()


def csv_header() -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=list(CSV_COLUMNS),
        lineterminator="\r\n",
    )
    writer.writeheader()

    return buffer.getvalue()


def jsonl_line(run: Mapping) -> str:
    """One JSONL record: the scalars, the derived summary, and the
    whole CompareResponse.

    ``response`` is the parsed ``response_json`` rather than the raw
    text: the point of the JSONL export is that nothing computed is
    lost, and a nested object is what an analysis script wants. The
    raw text is not repeated beside it -- on a long campaign that
    would double the file for no gain.
    """

    response_json = run.get("response_json")

    try:
        response = json.loads(response_json) if response_json else None
    except (TypeError, ValueError):
        response = None

    record = {column: run.get(column) for column in SCALAR_COLUMNS}
    record["custom_weights"] = run.get("custom_weights")
    record["summary"] = summarise_response(response_json)
    record["response"] = response

    return json.dumps(record, ensure_ascii=False, default=str) + "\n"


def iter_export(
    runs: Iterable[Mapping],
    export_format: str,
) -> Iterator[str]:
    """Stream an export as text chunks, one run at a time.

    The generator holds a single run, not the table: a campaign's
    history is small, but every row can carry a full CompareResponse
    and the export is expected to grow into a dataset.
    """

    if export_format == "csv":
        yield csv_header()

        for run in runs:
            yield csv_line(run)

        return

    if export_format == "jsonl":
        for run in runs:
            yield jsonl_line(run)

        return

    raise ValueError(
        f"Unknown export format: {export_format!r}. "
        f"Expected one of {', '.join(EXPORT_FORMATS)}."
    )


# ============================================================
# STATISTICS
# ============================================================

def win_shares(runs: Sequence[Mapping]) -> list[dict]:
    """Win shares per pipeline over one group of runs.

    A share is wins / battles in the group, to the same four decimals
    ``compare_service`` rounds winner_value to, so a share read here
    and a value read off the Arena agree digit for digit. ``battles``
    travels with every entry because a share without its denominator
    cannot be judged.

    Ordered by wins descending, then pipeline id, so the response is
    stable between calls on the same data.
    """

    battles = len(runs)

    if battles == 0:
        return []

    totals: dict[str, int] = {}

    for run in runs:
        pipeline_id = run.get("winner_pipeline_id")

        if not pipeline_id:
            continue

        totals[pipeline_id] = totals.get(pipeline_id, 0) + 1

    return sorted(
        (
            {
                "pipeline_id": pipeline_id,
                "wins": wins,
                "battles": battles,
                "win_share": _number(wins / battles),
            }
            for pipeline_id, wins in totals.items()
        ),
        key=lambda entry: (-entry["wins"], entry["pipeline_id"]),
    )


def split_runs(
    runs: Sequence[Mapping],
    column: str,
    *,
    minimum: int = MIN_BATTLES_PER_SPLIT,
) -> tuple[dict[str, list[dict]], list[dict]]:
    """Group runs by one column; return the groups and what was cut.

    Buckets smaller than ``minimum`` are dropped from the first value
    and described in the second, so a caller can tell "no seed runs
    were recorded" from "the seed split was too thin to report" and
    can never present a 0%-or-100% share as a result.
    """

    grouped: dict[str, list[dict]] = {}

    for run in runs:
        grouped.setdefault(bucket_label(run.get(column)), []).append(run)

    kept: dict[str, list[dict]] = {}
    omitted: list[dict] = []

    for label in sorted(grouped):
        group = grouped[label]

        if len(group) < minimum:
            omitted.append(
                {
                    "label": label,
                    "battles": len(group),
                    "reason": (
                        f"fewer than {minimum} battles in this bucket"
                    ),
                }
            )
            continue

        kept[label] = group

    return kept, omitted


def battle_stats(runs: Sequence[Mapping]) -> dict:
    """The aggregate the evaluation chapter's results section needs.

    Three views of the same table:

        - overall: every recorded battle;
        - by query kind: text runs against seed-paper runs, since the
          campaign runs both and they are not interchangeable;
        - by subject class: the six classes, each as its own tally.

    ``labelled_runs`` counts the runs that carry the label or class the
    splits are drawn from. The pre-campaign walkthroughs have neither,
    so they land in the untagged bucket of the second and third views
    and leave the first untouched -- which is the honest answer for a
    history that cannot be split further.
    """

    overall = win_shares(runs)

    by_query_kind, omitted_query_kinds = split_runs(runs, "query_kind")
    by_subject_class, omitted_subject_classes = split_runs(
        runs,
        "subject_class",
    )

    return {
        "total_runs": len(runs),
        "labelled_runs": sum(
            1 for run in runs if (run.get("run_label") or "").strip()
        ),
        "classified_runs": sum(
            1
            for run in runs
            if str(run.get("subject_class") or "").strip()
        ),
        "min_battles_per_split": MIN_BATTLES_PER_SPLIT,
        "overall": overall,
        "by_query_kind": [
            {
                "query_kind": label,
                "total_runs": len(group),
                "overall": win_shares(group),
            }
            for label, group in by_query_kind.items()
        ],
        "by_subject_class": [
            {
                "subject_class": label,
                "total_runs": len(group),
                "overall": win_shares(group),
            }
            for label, group in by_subject_class.items()
        ],
        "omitted": {
            "query_kind": omitted_query_kinds,
            "subject_class": omitted_subject_classes,
        },
    }

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit
from pathlib import Path

import requests
from fastapi import FastAPI, Depends, Form, HTTPException, UploadFile, File, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError

from app.database import engine, init_db, get_session, SessionLocal
from app.models.models import (
    Paper,
    PersonalLibrary,
    BattleRun,
    Announcement,
    User,
    TournamentRun,
    TournamentQueryScore,
)
from app.services import library_folders
from app.services.catalog import (
    DEFAULT_CATEGORIES,
    DEFAULT_DOCUMENT_TYPES,
    DEFAULT_SUBJECTS,
    merge_defaults,
)
from app.repositories.queries import filter_papers

from app.services.fts_search import ensure_fts_index

from app.services.upload_paper import (
    IMPORT_LOCK,
    MAX_PUBLICATION_YEAR,
    REVIEWED_FIELDS,
    MIN_PUBLICATION_YEAR,
    build_paper,
    extract_metadata,
    upload_paper_from_pdf,
    complete_paper_manually,
)
from app.services.bib_extraction import extract_metadata_from_bib
from app.services.ris_enw_extraction import (
    extract_metadata_from_enw,
    extract_metadata_from_ris,
)
from app.services.extraction import extract_metadata_from_pdf
from app.services.latex_extraction import extract_metadata_from_tex
from app.services.classification import classify_paper
from app.services.validation import validate_paper
from app.services.duplicate_detection import (
    DuplicatePaperError,
    find_duplicate_paper,
)
from app.services.citations import (
    clustered_works,
    refresh_paper_citations,
    link_reference_rows,
)
from app.services.web_connections import (
    EXTRA_SOURCES,
    fetch_neighborhood,
    fetch_web_neighborhood,
    resolve_work_titles,
)
from app.services.attachment_lock import attachment_lock
from app.services.enrichment_queue import (
    get_enrichment_status,
    enqueue_paper_enrichment,
)
from app.services.identifier_resolver import (
    resolve_identifier,
    IdentifierLookupError,
)
from app.services.metadata_enrichment import generate_keywords_if_missing
from app.services.web_search import (
    search_web,
    VALID_SORTS as WEB_SEARCH_SORTS,
    WebSearchError,
)
from app.services.connected_graph import build_connected_graph
from app.services.text_preparation import refresh_prepared_text

from app.services.storage import (
    delete_paper_file,
    get_paper_file_path,
    exports_dir,
)

from app.services.metadata_sync import sync_metadata
from app.services.literature_gather import (
    expand_references,
    gather_cited_works,
)
from app.services.evaluation import battle_judge, battle_series, loo_qrels, recipe_sweep, tournament_jobs
from app.services.evaluation.tournament import (
    eligible_query_count,
    export_tournament,
    run_summary as tournament_run_summary,
    run_tournament,
)
from app.services.evaluation.battle_log import (
    EXPORT_FORMATS,
    battle_stats,
    iter_export,
)
from app.services.evaluation.corpus_state import corpus_snapshot

from app.services.local_user import get_or_create_default_user

from app.services.recommendation.search_service import (
    search_papers as run_search,
)
from app.services.recommendation.pipeline_config import build_custom_weights

from app.services.recommendation.trace_service import (
    RecommendationTraceRequest,
    RecommendationTraceResponse,
    run_traced_search,
)

from app.services.recommendation.compare_service import (
    CompareRequest,
    CompareResponse,
    compare_pipelines,
    compare_pipelines_stream,
    compare_web_results,
    rank_web_results,
)

from app.services.url_safety import UnsafeUrlError, assert_public_http_url, safe_get
from app.services.pdf_finder import (
    find_pdf_candidates,
    download_and_attach_pdf,
)

from app.schemas import (
    PaperOut,
    PaperUpdate,
    RepositoryStats,
    LibraryEntryOut,
    SearchResultOut as SearchResultOutBase,
    PdfCandidateOut,
    AttachPdfRequest,
    IdentifierLookupRequest,
    MetadataImportRequest,
    AdminLoginIn,
    AdminTokenOut,
    AdminMeOut,
    AdminPasswordChange,
    AnnouncementIn,
    AnnouncementUpdate,
    AnnouncementOut,
    LibraryFeaturesOut,
    LibraryFeaturesIn,
    PaperIdsIn,
    RenameFilesIn,
    MarkPapersIn,
)

from app.services.merge_duplicates import merge_group

from app.services.admin_auth import (
    create_admin_token,
    ensure_admin_user,
    hash_password,
    verify_admin_token,
    verify_password,
)
from app.services.site_config import (
    get_library_features,
    set_library_features,
)

from app.services.research_chat import (
    ResearchChatRequest,
    ResearchChatResponse,
    answer_research_question,
)
from app.services.chat_suggestions import (
    SuggestionRequest,
    SuggestionResponse,
    suggest_followups,
)

app = FastAPI(title="Re:Search API")


# ============================================================
# RECOMMENDATION INDEX STATUS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

RECOMMENDATION_STATUS_PATH = (
    PROJECT_ROOT
    / "storage"
    / "recommendation_index_status.json"
)


def get_recommendation_index_status() -> bool:
    """
    Returns True when the recommendation index needs to be rebuilt.
    """

    if not RECOMMENDATION_STATUS_PATH.exists():
        return False

    try:
        with open(
            RECOMMENDATION_STATUS_PATH,
            "r",
            encoding="utf-8",
        ) as file:
            data = json.load(file)

        return bool(data.get("stale", False))

    except Exception:
        return False


def set_recommendation_index_stale(stale: bool):
    """
    Persist whether the recommendation index is stale.
    """

    RECOMMENDATION_STATUS_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        RECOMMENDATION_STATUS_PATH,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            {"stale": stale},
            file,
            indent=2,
        )


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # Extra origins, comma separated (a second dev server for testing).
        *[
            origin.strip()
            for origin in os.environ.get("RESEARCH_CORS_ORIGINS", "").split(",")
            if origin.strip()
        ],
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# STARTUP
# ============================================================

@app.on_event("startup")
def startup():
    init_db()

    # Battles recorded before margins existed: recover how close each call
    # was wherever the full result lists were kept.
    try:
        with SessionLocal() as session:
            backfill_battle_verdicts(session)
    except Exception as error:
        logging.getLogger(__name__).warning(
            "Could not backfill battle verdicts: %s", error
        )

    # A tournament that was running when the server last stopped has no
    # worker any more. Flag it so the Arena offers "resume" instead of a
    # progress bar that never moves.
    try:
        with SessionLocal() as session:
            tournament_jobs.mark_interrupted(session)
    except Exception as error:
        logging.getLogger(__name__).warning(
            "Could not flag interrupted tournaments: %s", error
        )

    # Library Mode: make sure the site-editor account and the default
    # feature states exist before the first request.
    _seed_library_site()

    # P1-A: ranked repository search uses an FTS5 index. It is purely
    # an optimization, so a failure here must never stop the app from
    # booting -- search falls back to the legacy ILIKE path instead.
    try:
        if not ensure_fts_index(engine):
            logging.getLogger(__name__).warning(
                "SQLite build has no FTS5 support; repository search "
                "will use the ILIKE fallback."
            )
    except Exception as error:
        logging.getLogger(__name__).warning(
            "FTS5 index setup failed; repository search will use the "
            "ILIKE fallback: %s",
            error,
        )

    # Pre-load the S-BERT model on a background thread so the first
    # recommendation request doesn't pay the load cost (and so the load
    # itself happens outside any request's DB session).
    def _warm_up():
        try:
            from app.services.recommendation.sbert_pipeline import (
                warm_up_model,
            )

            warm_up_model()
        except Exception as error:
            print(f"S-BERT model warm-up failed: {error}")

    threading.Thread(
        target=_warm_up,
        name="sbert-warmup",
        daemon=True,
    ).start()


# ============================================================
# FILE HELPERS
# ============================================================

def resolve_stored_file(stored_path: str | None) -> Path:
    """
    Convert the database stored path such as:

        papers/60.pdf

    into the actual storage path:

        storage/papers/60.pdf
    """

    if not stored_path:
        raise HTTPException(
            status_code=404,
            detail="Paper file not found.",
        )

    path = Path(get_paper_file_path(stored_path))

    if not path.exists() or not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Paper file not found.",
        )

    return path


# ============================================================
# RECOMMENDATION REBUILD
# ============================================================

def rebuild_recommendation_data():
    """
    Rebuild classification, validation, TF-IDF and S-BERT
    recommendation data after repository changes.
    """

    script_path = (
        Path(__file__).resolve().parent.parent
        / "scripts"
        / "rebuild_recommendation.py"
    )

    if not script_path.exists():
        raise FileNotFoundError(
            "Recommendation rebuild script not found."
        )

    # stdout streams live to the server log (progress output stays
    # visible); stderr goes to a temp file so a non-zero exit -- what
    # used to surface as a featureless 500 -- carries the script's own
    # traceback.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as err_file:
        result = subprocess.run(
            [
                sys.executable,
                str(script_path),
            ],
            check=False,
            stderr=err_file,
            cwd=str(script_path.parent.parent),
        )

        if result.returncode != 0:
            err_file.seek(0)
            stderr_tail = err_file.read()[-2000:]
            print(stderr_tail)

            raise RuntimeError(
                f"rebuild_recommendation.py exited with code "
                f"{result.returncode}: {stderr_tail.strip()}"
            )


# ============================================================
# RECOMMENDATION INDEX STATUS
# ============================================================

@app.get("/api/recommendations/status")
def recommendation_status():
    return {
        "stale": get_recommendation_index_status(),
    }


# ============================================================
# PAPERS
# ============================================================

class PaperListOut(PaperOut):
    """
    PaperOut plus the optional FTS relevance snippet and the count
    of near-duplicate records collapsed out of a relevance result
    list.

    Only the repository list endpoint returns this model; the extra
    fields are additive, so existing clients can ignore them.
    """

    snippet: str | None = Field(
        default=None,
        validation_alias="search_snippet",
    )

    duplicate_count: int = 0


@app.get(
    "/api/papers",
    response_model=list[PaperListOut],
)
def list_papers(
    search: str | None = None,
    subject: str | None = None,
    category: str | None = None,
    document_type: str | None = None,
    min_year: int | None = None,
    max_year: int | None = None,
    sort_by: str | None = None,
    limit: int | None = None,
    db: Session = Depends(get_session),
):
    papers = filter_papers(
        db,
        search=search,
        subject=subject,
        category=category,
        document_type=document_type,
        min_year=min_year,
        max_year=max_year,
        sort_by=sort_by,
    )

    if limit is not None:
        papers = papers[:limit]

    return papers


# ============================================================
# REPOSITORY STATS
# ============================================================

@app.get(
    "/api/papers/stats",
    response_model=RepositoryStats,
)
def get_repository_stats(
    db: Session = Depends(get_session),
):
    subject_expr = func.coalesce(
        func.nullif(Paper.subject_category, ""),
        "Uncategorized",
    )
    rows = (
        db.query(subject_expr, func.count(Paper.id))
        .group_by(subject_expr)
        .order_by(func.min(Paper.id))
        .all()
    )

    by_subject: dict[str, int] = {subject: count for subject, count in rows}

    return RepositoryStats(
        total_papers=sum(by_subject.values()),
        by_subject=by_subject,
        category_count=len(by_subject),
    )


# ============================================================
# PDF VIEWER
# ============================================================

@app.get("/api/papers/{paper_id}/pdf")
def get_paper_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    stored_path = paper.stored_path

    if not stored_path:
        raise HTTPException(
            status_code=404,
            detail="Paper does not have a stored file.",
        )

    if not stored_path.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=404,
            detail="This paper does not have a PDF file.",
        )

    path = resolve_stored_file(stored_path)

    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
        },
    )


# ============================================================
# FIND PDF ONLINE
# ============================================================

@app.get(
    "/api/papers/{paper_id}/find-pdf",
    response_model=list[PdfCandidateOut],
)
def find_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Search-only step: looks for a legal open-access PDF matching this
    paper (Unpaywall, Crossref, Semantic Scholar, arXiv, OpenAlex)
    and returns candidates for the user to review.

    Metadata enrichment is also attempted using the same candidates.
    Nothing is downloaded here.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    if paper.stored_path and paper.stored_path.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="This paper already has a stored PDF.",
        )

    # --------------------------------------------------------
    # Find PDF candidates
    # --------------------------------------------------------

    try:
        candidates = find_pdf_candidates(paper)

    except Exception as error:
        print()
        print("FIND PDF FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="Could not search for a PDF right now.",
        ) from error

    # --------------------------------------------------------
    # Best-effort metadata enrichment
    # --------------------------------------------------------

    try:
        from app.services.metadata_enrichment import enrich_paper_metadata

        changed = enrich_paper_metadata(
            paper,
            candidates,
        )

        if changed:
            validate_paper(paper)
            refresh_prepared_text(paper)
            set_recommendation_index_stale(True)

    except Exception as error:
        print("WARNING: Metadata enrichment failed:")
        print(error)

    # --------------------------------------------------------
    # Persist changes made by find_pdf_candidates() or enrichment
    # --------------------------------------------------------

    if db.is_modified(paper):
        db.commit()
        db.refresh(paper)

    return [
        PdfCandidateOut(**candidate.to_dict())
        for candidate in candidates
    ]

@app.post(
    "/api/papers/{paper_id}/attach-pdf",
    response_model=PaperOut,
)
def attach_pdf(
    paper_id: int,
    payload: AttachPdfRequest,
    db: Session = Depends(get_session),
):
    """
    Confirm step: downloads the PDF at the given URL (a candidate the
    user picked from /find-pdf), verifies it, and stores it the same
    way an uploaded PDF is stored. Then runs the same metadata
    extraction the normal PDF-upload path uses on the newly downloaded
    file, backfilling whatever the paper is still missing
    (title/abstract/keywords/publication_year). A field the paper
    already has -- e.g. a title from its original BibTeX import -- is
    never overwritten.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    # --------------------------------------------------------
    # Attachment race guard
    #
    # The background enrichment queue may auto-attach a PDF for this
    # paper concurrently with this request (both start right after
    # upload). The per-paper lock serializes check + download so the
    # two can never write {paper_id}.pdf at the same time; whoever
    # gets there second re-reads stored_path and no-ops instead of
    # downloading again.
    # --------------------------------------------------------

    with attachment_lock(paper_id):
        db.refresh(paper)

        if (
            paper.stored_path
            and paper.stored_path.lower().endswith(".pdf")
        ):
            return paper

        try:
            stored_path = download_and_attach_pdf(
                paper_id,
                payload.url,
                paper.title,
                paper.doi,
            )

        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            )

        except Exception as error:

            print()
            print("ATTACH PDF FAILED")
            print(error)

            raise HTTPException(
                status_code=502,
                detail="Could not download the PDF from that link.",
            )

    paper.stored_path = stored_path

    # --------------------------------------------------------
    # Extract metadata from the file we just downloaded and use
    # it to backfill whatever the paper is still missing -- the
    # same fields a normal PDF upload extracts. A field already
    # on the paper is left alone.
    # --------------------------------------------------------

    changed_recommendation_fields = False

    try:
        full_path = get_paper_file_path(stored_path)
        extracted = extract_metadata_from_pdf(full_path)

    except Exception as error:

        print()
        print("METADATA EXTRACTION FAILED FOR ATTACHED PDF")
        print(error)

        extracted = {}

    backfill_fields = (
        "title",
        "abstract",
        "keywords",
        "publication_year",
    )

    for field in backfill_fields:
        current_value = getattr(paper, field, None)

        is_blank = (
            current_value is None
            or (
                isinstance(current_value, str)
                and not current_value.strip()
            )
        )

        extracted_value = extracted.get(field)

        if is_blank and extracted_value:
            setattr(paper, field, extracted_value)
            changed_recommendation_fields = True

            if field == "keywords":
                paper.keywords_source = extracted.get(
                    "keywords_source"
                )
                paper.keywords_generated = extracted.get(
                    "keywords_generated",
                    False,
                )

    if not paper.subject_category:
        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: classification failed after attach-pdf")
            print(error)

    try:
        validate_paper(paper)
        refresh_prepared_text(paper)
    except Exception as error:
        print("WARNING: validation/prepared-text refresh failed after attach-pdf")
        print(error)

    db.commit()
    db.refresh(paper)

    if changed_recommendation_fields:
        set_recommendation_index_stale(True)

        print(
            f"Recommendation index is stale for paper {paper.id}. "
            "Rebuild required."
        )

    return paper


# ============================================================
# BACKGROUND ENRICHMENT STATUS
# ============================================================

@app.get("/api/papers/{paper_id}/enrichment-status")
def enrichment_status(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Status of the background enrichment job enqueued when this paper
    was imported ("queued" | "running" | "done" | "failed", or "idle"
    if nothing was ever enqueued for it). Lets the frontend refresh
    the paper once enrichment has filled in its missing fields.
    """
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return {
        "paper_id": paper_id,
        "status": get_enrichment_status(paper_id) or "idle",
    }


# ============================================================
# GET SINGLE PAPER
# ============================================================

@app.get(
    "/api/papers/{paper_id}",
    response_model=PaperOut,
)
def get_paper(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return paper


# ============================================================
# UPDATE PAPER
# ============================================================

@app.patch(
    "/api/papers/{paper_id}",
    response_model=PaperOut,
)
def update_paper(
    paper_id: int,
    updates: PaperUpdate,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    update_data = updates.model_dump(
        exclude_unset=True
    )

    try:
        paper = complete_paper_manually(
            db,
            paper,
            **update_data,
        )
    except StaleDataError as error:
        # The row vanished between the lookup and the UPDATE -- the
        # paper was deleted by another request while this one edited it.
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        ) from error

    except Exception as error:
        print("PAPER METADATA UPDATE FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to update paper metadata.",
        ) from error

    set_recommendation_index_stale(True)

    return paper



# ============================================================
# DELETE PAPER
# ============================================================

@app.delete("/api/papers/{paper_id}")
def delete_paper(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    stored_path = paper.stored_path

    try:
        if stored_path:
            delete_paper_file(stored_path)

    except Exception as error:
        print("Could not delete stored paper file:")
        print(error)

    db.delete(paper)
    db.commit()

    set_recommendation_index_stale(True)

    return {
        "status": "deleted"
    }


# ============================================================
# DELETE PDF (keep the bibliographic record)
# ============================================================

@app.delete(
    "/api/papers/{paper_id}/pdf",
    response_model=PaperOut,
)
def delete_paper_pdf(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """
    Remove only the stored PDF file (and stored_path), keeping the
    paper's metadata intact so the record can be re-attached to a
    different open-access copy later.
    """

    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    if not paper.stored_path:
        raise HTTPException(
            status_code=400,
            detail="This paper has no stored file.",
        )

    try:
        delete_paper_file(paper.stored_path)
    except Exception as error:
        print("Could not delete stored PDF file:")
        print(error)

    paper.stored_path = None
    db.commit()
    db.refresh(paper)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# PREVIEW PAPER
# ============================================================

def _duplicate_summary(
    db: Session,
    paper: Paper,
) -> dict | None:
    """The stored paper this one would be rejected as a copy of, if any."""

    try:
        match = find_duplicate_paper(
            db,
            title=paper.title,
            doi=paper.doi,
        )
    except Exception as error:
        print("WARNING: Preview duplicate check failed")
        print(error)

        return None

    if match is None:
        return None

    return {"id": match.id, "title": match.title}


def _paper_preview_payload(
    paper: Paper,
    pdf_candidates: list,
    duplicate_of: dict | None = None,
) -> dict:
    """
    The shared preview response shape: what saving this paper would
    persist, plus any discovered PDF candidates. Used by both the
    file preview and the identifier (DOI/arXiv) preview so the two
    flows can never drift apart.
    """
    return {
        "title": paper.title,
        "author": paper.author,
        "abstract": paper.abstract,
        "keywords": paper.keywords,
        "publication_year": paper.publication_year,
        "doi": paper.doi,
        "subject_category": paper.subject_category,
        "document_type": paper.document_type,
        "citation_count": paper.citation_count,
        "is_valid_for_recommendation": (
            paper.is_valid_for_recommendation
        ),
        "missing_fields": paper.missing_fields,
        "source_filename": paper.source_filename,
        "extraction_method": paper.extraction_method,
        "pdf_candidates": [
            candidate.to_dict()
            for candidate in pdf_candidates
        ],
        "duplicate_of": duplicate_of,
    }


# One upload may be this big. A PDF of a thesis is a few MB; this only
# stops a runaway or hostile file from filling the disk.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

ACCEPTED_UPLOAD_SUFFIXES = (".pdf", ".bib", ".tex", ".ris", ".enw")

_ACCEPTED_FILES_MESSAGE = (
    "Only PDF, BibTeX (.bib), RIS (.ris), EndNote (.enw), "
    "and LaTeX (.tex) files are accepted."
)


def _save_upload_to_temp(file: UploadFile) -> tuple[str, str]:
    """
    Copy an uploaded file to a temp file, checking its type and size on
    the way. Returns (path, suffix); the caller removes the file.
    """

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="A filename is required.",
        )

    suffix = os.path.splitext(file.filename)[1].lower()

    if suffix not in ACCEPTED_UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=_ACCEPTED_FILES_MESSAGE,
        )

    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(
            suffix=suffix,
            delete=False,
        ) as tmp:
            tmp_path = tmp.name
            total = 0
            head = b""

            while True:
                chunk = file.file.read(1024 * 1024)

                if not chunk:
                    break

                if not head:
                    head = chunk[:1024]

                total += len(chunk)

                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "That file is too large (the limit is "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."
                        ),
                    )

                tmp.write(chunk)

        if total == 0:
            raise HTTPException(
                status_code=400,
                detail="That file is empty.",
            )

        if suffix == ".pdf" and not head.lstrip().startswith(b"%PDF-"):
            raise HTTPException(
                status_code=400,
                detail="That file is not a valid PDF.",
            )

        if suffix != ".pdf" and b"\x00" in head:
            raise HTTPException(
                status_code=400,
                detail=(
                    "That looks like a binary file, not a text "
                    f"citation ({suffix})."
                ),
            )

        return tmp_path, suffix

    except BaseException:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

        raise


@app.post("/api/papers/preview")
def preview_paper(
    file: UploadFile = File(...),
    candidates: bool = False,
    db: Session = Depends(get_session),
):
    """
    Extract and validate paper metadata without creating a database record.

    This is the first step of the upload flow. The frontend can show the
    extracted metadata for editing, while the actual database insert and
    file storage only happen through /api/papers/upload after the user
    clicks Save. The response says whether the paper is already stored
    (`duplicate_of`) so the review form can warn before saving.

    Searching the web for PDF candidates takes several seconds, so it only
    runs when asked for (`?candidates=true`); the review form does not
    need it.
    """

    tmp_path, suffix = _save_upload_to_temp(file)

    try:
        try:
            metadata = extract_metadata(tmp_path, suffix)
        except Exception as error:
            print()
            print("PAPER PREVIEW EXTRACTION FAILED")
            print(error)

            raise HTTPException(
                status_code=422,
                detail=(
                    "Could not read metadata from that file. "
                    "Check that it is a valid "
                    f"{suffix[1:].upper()} file."
                ),
            ) from error

        paper = build_paper(metadata, file.filename, suffix)

        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: Paper preview classification failed")
            print(error)

        try:
            validate_paper(paper)
        except Exception as error:
            print("WARNING: Paper preview validation failed")
            print(error)

        try:
            refresh_prepared_text(paper)
        except Exception as error:
            print("WARNING: Paper preview text preparation failed")
            print(error)

        pdf_candidates = []

        if candidates and suffix in (".bib", ".tex") and paper.title:
            try:
                pdf_candidates = find_pdf_candidates(paper)
            except Exception as error:
                print("WARNING: Paper preview PDF discovery failed")
                print(error)

        return _paper_preview_payload(
            paper,
            pdf_candidates,
            _duplicate_summary(db, paper),
        )

    except HTTPException:
        raise

    except Exception as error:
        print()
        print("PAPER PREVIEW FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to preview the paper.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ============================================================
# PREVIEW BY IDENTIFIER (DOI / arXiv / link)
# ============================================================

@app.post("/api/papers/preview-identifier")
def preview_identifier(
    payload: IdentifierLookupRequest,
    db: Session = Depends(get_session),
):
    """
    Resolve a pasted DOI, arXiv id, or link to either into the same
    preview payload POST /api/papers/preview returns for an uploaded
    file.

    Nothing is persisted and no file exists yet -- the frontend shows
    the metadata for review and only then calls POST
    /api/papers/import-metadata. Keywords are generated locally (YAKE
    on title+abstract) because identifier imports have no extraction
    step and keywords are required for recommendation validity.
    """
    try:
        resolved = resolve_identifier(payload.identifier)

    except IdentifierLookupError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        )

    if resolved is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not read that identifier. Paste a DOI "
                "(10.xxxx/...), an arXiv id (2106.03762), or a link "
                "to either."
            ),
        )

    paper = Paper(
        title=resolved.get("title"),
        author=resolved.get("author"),
        abstract=resolved.get("abstract"),
        keywords=resolved.get("keywords"),
        publication_year=resolved.get("publication_year"),
        doi=resolved.get("doi"),
        subject_category=resolved.get("subject_category"),
        document_type=resolved.get("document_type"),
        citation_count=resolved.get("citation_count"),
        source_filename=resolved.get("source_filename"),
        extraction_method="identifier",
    )

    try:
        generate_keywords_if_missing(paper)
    except Exception as error:
        print("WARNING: Identifier preview keyword generation failed")
        print(error)

    # Classify after keyword generation (the rules read keywords) so
    # the preview shows the subject/category the paper will be filed
    # under, and the Upload form can reflect it in its dropdowns.
    try:
        classify_paper(paper)
    except Exception as error:
        print("WARNING: Identifier preview classification failed")
        print(error)

    try:
        validate_paper(paper)
    except Exception as error:
        print("WARNING: Identifier preview validation failed")
        print(error)

    try:
        refresh_prepared_text(paper)
    except Exception as error:
        print("WARNING: Identifier preview text preparation failed")
        print(error)

    return _paper_preview_payload(
        paper,
        [],
        _duplicate_summary(db, paper),
    )


# ============================================================
# UPLOAD PAPER
# ============================================================

@app.post(
    "/api/papers/upload",
    response_model=PaperOut,
)
def upload_paper(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    author: str | None = Form(None),
    abstract: str | None = Form(None),
    keywords: str | None = Form(None),
    publication_year: str | None = Form(None),
    doi: str | None = Form(None),
    subject_category: str | None = Form(None),
    document_type: str | None = Form(None),
    citation_count: str | None = Form(None),
    cleared: str | None = Form(None),
    db: Session = Depends(get_session),
):
    """
    Import a PDF, BibTeX, RIS, EndNote or LaTeX file.

    The optional form fields are the reviewer's corrections from the
    Upload form; they are laid over the extracted metadata *before* the
    duplicate check and the save, so one request is one atomic import.
    A field that is omitted keeps its extracted value. Form posts cannot
    tell "left out" from "left blank", so a field the reviewer emptied is
    named in `cleared` (comma-separated) instead.
    """

    reviewed: dict = {
        "title": title,
        "author": author,
        "abstract": abstract,
        "keywords": keywords,
        "doi": doi,
        "subject_category": subject_category,
        "document_type": document_type,
    }

    for name in (cleared or "").split(","):
        name = name.strip()

        if name in REVIEWED_FIELDS:
            reviewed[name] = ""

    for name, raw in (
        ("publication_year", publication_year),
        ("citation_count", citation_count),
    ):
        if raw is None:
            continue

        cleaned = raw.strip()

        if not cleaned:
            reviewed[name] = ""
            continue

        try:
            number = int(cleaned)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"{name.replace('_', ' ').capitalize()} must be a whole number.",
            )

        if name == "publication_year" and not (
            MIN_PUBLICATION_YEAR <= number <= MAX_PUBLICATION_YEAR
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Publication year must be between "
                    f"{MIN_PUBLICATION_YEAR} and {MAX_PUBLICATION_YEAR}."
                ),
            )

        if name == "citation_count" and number < 0:
            raise HTTPException(
                status_code=422,
                detail="Citation count cannot be negative.",
            )

        reviewed[name] = number

    tmp_path, _suffix = _save_upload_to_temp(file)

    try:
        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            file.filename,
            reviewed,
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except ValueError as error:
        # An unsupported or unreadable file: say why, not just "failed".
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:

        print()
        print("PAPER UPLOAD FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the paper.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# IMPORT FROM METADATA (no source file)
# ============================================================

@app.post(
    "/api/papers/import-metadata",
    response_model=PaperOut,
)
def import_from_metadata(
    payload: MetadataImportRequest,
    db: Session = Depends(get_session),
):
    """
    Create a paper directly from reviewed metadata -- the save step
    of the "Add by identifier" flow (DOI / arXiv / link), where there
    is no source file to upload.

    Duplicate detection runs first (the same DOI/title guard the
    other import paths were always meant to have). A PDF, if wanted,
    comes from pdf_url here or from the background enrichment queue
    afterwards -- the record itself is committed either way.
    """
    title = (payload.title or "").strip()

    if not title:
        raise HTTPException(
            status_code=400,
            detail="Title is required before saving.",
        )

    if payload.publication_year is not None and not (
        MIN_PUBLICATION_YEAR <= payload.publication_year <= MAX_PUBLICATION_YEAR
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Publication year must be between "
                f"{MIN_PUBLICATION_YEAR} and {MAX_PUBLICATION_YEAR}."
            ),
        )

    if payload.citation_count is not None and payload.citation_count < 0:
        raise HTTPException(
            status_code=422,
            detail="Citation count cannot be negative.",
        )

    if payload.pdf_url:
        try:
            assert_public_http_url(payload.pdf_url)
        except UnsafeUrlError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            ) from error

    return _save_metadata_import(db, payload, title)


def _save_metadata_import(
    db: Session,
    payload: MetadataImportRequest,
    title: str,
) -> Paper:
    """Save a reviewed record; the duplicate check and insert run one at a time."""

    with IMPORT_LOCK:
        duplicate = find_duplicate_paper(
            db,
            title=title,
            doi=payload.doi,
        )

        if duplicate is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Looks like a duplicate of paper #{duplicate.id}: "
                    f"{duplicate.title}"
                ),
            )

        paper = Paper(
            title=title,
            author=(payload.author or "").strip() or None,
            abstract=(payload.abstract or "").strip() or None,
            keywords=(payload.keywords or "").strip() or None,
            publication_year=payload.publication_year,
            doi=payload.doi,
            subject_category=payload.subject_category,
            document_type=payload.document_type,
            citation_count=payload.citation_count,
            source_filename=payload.source_filename,
            extraction_method="metadata",
        )

        try:
            generate_keywords_if_missing(paper)
        except Exception as error:
            print("WARNING: Identifier import keyword generation failed")
            print(error)

        # Fill-only: assigns only when the caller didn't supply a subject
        # (web imports never do; the Upload form's dropdowns win when the
        # user picked something).
        try:
            classify_paper(paper)
        except Exception as error:
            print("WARNING: Identifier import classification failed")
            print(error)

        try:
            validate_paper(paper)
        except Exception as error:
            print("WARNING: Identifier import validation failed")
            print(error)

        try:
            refresh_prepared_text(paper)
        except Exception as error:
            print("WARNING: Identifier import text preparation failed")
            print(error)

        try:
            db.add(paper)
            db.commit()
            db.refresh(paper)

        except Exception:
            db.rollback()

            raise HTTPException(
                status_code=500,
                detail="Failed to save the paper.",
            )

    # Optional explicit PDF (the user picked a candidate). Best-effort:
    # the paper is already saved, and if this fails the background
    # queue will still search for one.
    if payload.pdf_url:
        try:
            with attachment_lock(paper.id):
                db.refresh(paper)

                if not (paper.stored_path or "").lower().endswith(".pdf"):
                    paper.stored_path = download_and_attach_pdf(
                        paper.id,
                        payload.pdf_url,
                        paper.title,
                        paper.doi,
                    )
                    db.commit()
                    db.refresh(paper)

        except Exception as error:
            db.rollback()
            print("WARNING: Could not attach the provided PDF:")
            print(error)

    enqueue_paper_enrichment(paper.id)
    set_recommendation_index_stale(True)

    return paper


# ============================================================
# WEB SEARCH (OpenAlex + Crossref)
# ============================================================

@app.get("/api/search-web")
def search_web_endpoint(
    q: str,
    year_min: int | None = None,
    year_max: int | None = None,
    peer_reviewed: bool = True,
    open_access: bool = False,
    sources: str = "openalex,crossref",
    sort: str = "relevance",
    limit: int = 15,
):
    """
    Search the open scholarly web through legitimate APIs (OpenAlex
    and Crossref -- no Google Scholar scraping). Peer-reviewed
    publication types only by default; retracted works and datasets/
    patents are excluded. Results are normalized, deduplicated across
    sources, and returned with provenance so the UI can show which
    API answered.

    The frontend imports a chosen hit via POST /api/papers/
    import-metadata, which also runs duplicate detection.
    """
    query = (q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if sort not in WEB_SEARCH_SORTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"sort must be one of: {', '.join(WEB_SEARCH_SORTS)}."
            ),
        )

    requested_sources = tuple(
        source.strip()
        for source in sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv", "doaj")
    )

    try:
        results = search_web(
            query,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access,
            sources=requested_sources,
            sort=sort,
            limit=max(1, min(limit, 25)),
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    except Exception as error:
        print()
        print("WEB SEARCH FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="The web search failed unexpectedly.",
        )

    return [result.to_dict() for result in results]


# ============================================================
# MANUAL REBUILD OF RECOMMENDATION INDEX
# ============================================================

@app.post("/api/recommendations/rebuild")
def rebuild_recommendations():
    try:
        rebuild_recommendation_data()

        set_recommendation_index_stale(False)

        return {
            "success": True,
            "message": "Recommendation index rebuilt successfully.",
        }

    except Exception as error:
        print("RECOMMENDATION REBUILD FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to rebuild recommendation index.",
        )


# ============================================================
# GOOGLE SCHOLAR CITATION IMPORT
# ============================================================

SCHOLAR_EXPORT_URL_PATTERN = re.compile(
    r"^https://(?:scholar\.googleusercontent\.com|scholar\.google\.com)"
    r"/scholar\.(bib|enw|ris)",
    re.IGNORECASE,
)

_SCHOLAR_HOSTS = {"scholar.googleusercontent.com", "scholar.google.com"}

_SCHOLAR_CONTENT_SIGNATURES = {
    "bib": (r"@\w+\s*\{",),
    "enw": (r"(?m)^%0\s",),
    "ris": (r"(?im)^TY\s*-",),
}


def _fetch_scholar_export(url: str) -> tuple[str, str]:
    """Fetch a Google Scholar BibTeX / EndNote / RefMan export URL.

    Returns ``(format, text)`` for the ``scholar.bib``, ``scholar.enw``
    and ``scholar.ris`` links of the Google Scholar Cite dialog.
    Raises ``HTTPException`` with the established error semantics.
    """

    match = SCHOLAR_EXPORT_URL_PATTERN.match(url)

    if match is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Only Google Scholar BibTeX, EndNote, "
                "and RefMan links are accepted."
            ),
        )

    export_format = match.group(1).lower()

    try:
        response = safe_get(
            url,
            host_ok=lambda hop: (urlsplit(hop).hostname or "")
            in _SCHOLAR_HOSTS,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 "
                    "(Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 "
                    "(KHTML, like Gecko) "
                    "Chrome/124.0.0.0 "
                    "Safari/537.36"
                ),
                "Accept": (
                    "text/plain, "
                    "application/x-bibtex, "
                    "*/*"
                ),
            },
            timeout=10,
        )

    except UnsafeUrlError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except requests.RequestException as error:

        print("GOOGLE SCHOLAR REQUEST FAILED")
        print(error)

        raise HTTPException(
            status_code=502,
            detail="Could not reach Google Scholar.",
        )

    if not response.ok:

        status_code = response.status_code

        if status_code in (
            403,
            429,
            503,
        ):
            raise HTTPException(
                status_code=502,
                detail=(
                    "Google Scholar is temporarily "
                    "blocking automated requests. "
                    "Please try again later."
                ),
            )

        raise HTTPException(
            status_code=502,
            detail=(
                f"Google Scholar returned "
                f"HTTP {status_code}."
            ),
        )

    content = response.text.strip()

    signature_patterns = _SCHOLAR_CONTENT_SIGNATURES[
        export_format
    ]

    if not any(
        re.search(pattern, content, re.IGNORECASE)
        for pattern in signature_patterns
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "The Google Scholar link did not "
                f"return a valid {export_format.upper()} citation."
            ),
        )

    return export_format, content


@app.post(
    "/api/papers/import-url",
    response_model=PaperOut,
)
def import_paper_from_url(
    url: str,
    db: Session = Depends(get_session),
):
    """Import a Google Scholar BibTeX / EndNote / RefMan link directly."""

    url = url.strip()

    export_format, content = _fetch_scholar_export(url)

    with tempfile.NamedTemporaryFile(
        suffix=f".{export_format}",
        delete=False,
        mode="w",
        encoding="utf-8",
    ) as tmp:

        tmp.write(content)
        tmp_path = tmp.name

    try:
        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            f"google-scholar.{export_format}",
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except Exception as error:

        print("SCHOLAR IMPORT FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the citation.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


class LinkFetchRequest(BaseModel):
    url: str


@app.post("/api/papers/fetch-link")
def fetch_dropped_link(payload: LinkFetchRequest):
    """Fetch any dropped http(s) link server-side and return citation text.

    Returns ``{"format": bib|ris|enw|doi, "text", "url"}``. Nothing is
    persisted; the Upload page feeds it to the normal preview flow.
    """

    from app.services.link_fetch import LinkFetchError, fetch_link

    try:
        return fetch_link(payload.url)
    except LinkFetchError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail)


@app.post("/api/papers/scholar-fetch")
def fetch_scholar_export_url(
    payload: LinkFetchRequest | None = None,
    url: str | None = None,
):
    """Fetch a Google Scholar export link and return its text.

    The upload drop zone uses this endpoint for the review flow:
    nothing is persisted here. The frontend builds a file from
    ``{"format", "text"}`` and runs it through the normal
    preview -> review -> save path, exactly like the Chrome
    extension path. The URL comes in the JSON body (the frontend)
    or, for older callers, the query string.
    """

    from app.services.link_fetch import clean_url

    url = clean_url((payload.url if payload else None) or url or "")

    export_format, content = _fetch_scholar_export(url)

    return {
        "format": export_format,
        "text": content,
        "url": url,
    }


# ============================================================
# DIRECT BIBTEX IMPORT
# ============================================================

@app.post(
    "/api/papers/import-bibtex",
    response_model=PaperOut,
)
def import_bibtex(
    payload: dict,
    db: Session = Depends(get_session),
):
    bibtex = payload.get("bibtex")

    if not bibtex or not isinstance(
        bibtex,
        str,
    ):
        raise HTTPException(
            status_code=400,
            detail="BibTeX content is required.",
        )

    if not re.search(
        r"@\w+\s*\{",
        bibtex,
        re.IGNORECASE,
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid BibTeX content.",
        )

    with tempfile.NamedTemporaryFile(
        suffix=".bib",
        delete=False,
        mode="w",
        encoding="utf-8",
    ) as tmp:

        tmp.write(bibtex)
        tmp_path = tmp.name

    try:
        filename = "google-scholar.bib"

        paper = upload_paper_from_pdf(
            db,
            tmp_path,
            filename,
        )

    except DuplicatePaperError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from error

    except Exception as error:

        print("BIBTEX IMPORT FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Failed to import the citation.",
        )

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    set_recommendation_index_stale(True)

    return paper


# ============================================================
# PERSONAL LIBRARY
# ============================================================

@app.get(
    "/api/library",
    response_model=list[LibraryEntryOut],
)
def get_library(
    db: Session = Depends(get_session),
):
    user = get_or_create_default_user(db)

    entries = (
        db.query(PersonalLibrary)
        .options(selectinload(PersonalLibrary.paper))
        .filter(
            PersonalLibrary.user_id == user.id
        )
        .all()
    )

    return entries


# ============================================================
# AUTO-ASSIGN KEYWORDS FOR LIBRARY PAPERS
# ============================================================

@app.post("/api/library/assign-keywords")
def assign_library_keywords(
    db: Session = Depends(get_session),
):
    """
    Automatic keyword assigner: generates YAKE keywords for every
    library paper that has none, then revalidates recommendation
    status and the prepared recommendation text.

    Runs entirely locally (no network) -- the My Library page calls
    this on load so saved papers always show keywords without the
    user doing anything. Must stay registered BEFORE
    /api/library/{paper_id}, or "assign-keywords" would be parsed
    as a paper id.
    """
    user = get_or_create_default_user(db)

    entries = (
        db.query(PersonalLibrary)
        .filter(PersonalLibrary.user_id == user.id)
        .all()
    )

    paper_ids = [entry.paper_id for entry in entries]

    if not paper_ids:
        return {
            "checked": 0,
            "updated": 0,
            "paper_ids": [],
        }

    papers = (
        db.query(Paper)
        .filter(Paper.id.in_(paper_ids))
        .all()
    )

    updated_ids: list[int] = []

    for paper in papers:
        if paper.keywords and paper.keywords.strip():
            continue

        try:
            if not generate_keywords_if_missing(paper):
                continue

            validate_paper(paper)
            refresh_prepared_text(paper)
            updated_ids.append(paper.id)

        except Exception as error:
            print(
                "WARNING: Keyword assignment failed for paper "
                f"id={paper.id}: {error}"
            )
            db.rollback()

    if updated_ids:
        db.commit()
        set_recommendation_index_stale(True)

    return {
        "checked": len(paper_ids),
        "updated": len(updated_ids),
        "paper_ids": updated_ids,
    }


# ============================================================
# SAVE PAPER TO LIBRARY
# ============================================================

# ============================================================
# LIBRARY FOLDERS
# (registered before the "/api/library/{paper_id}" routes, so "folders"
# is never read as a paper id)
# ============================================================

class FolderCreate(BaseModel):
    name: str
    parent_id: int | None = None


class FolderUpdate(BaseModel):
    name: str | None = None
    # Present and null moves the folder to the top level; absent leaves it.
    parent_id: int | None = None


class FolderPapers(BaseModel):
    paper_ids: list[int]
    action: str = "add"


def _folder_call(fn):
    try:
        return fn()
    except library_folders.FolderError as error:
        raise HTTPException(status_code=error.status, detail=error.message) from error


@app.get("/api/library/folders")
def get_library_folders(db: Session = Depends(get_session)):
    user = get_or_create_default_user(db)

    return library_folders.overview(db, user.id)


@app.post("/api/library/folders", status_code=201)
def create_library_folder(
    request: FolderCreate, db: Session = Depends(get_session)
):
    user = get_or_create_default_user(db)
    folder = _folder_call(
        lambda: library_folders.create_folder(
            db, user.id, request.name, request.parent_id
        )
    )

    return {"id": folder.id, "name": folder.name, "parent_id": folder.parent_id}


@app.patch("/api/library/folders/{folder_id}")
def update_library_folder(
    folder_id: int, request: FolderUpdate, db: Session = Depends(get_session)
):
    user = get_or_create_default_user(db)
    fields = request.model_fields_set
    changes: dict = {}

    if "name" in fields:
        changes["name"] = request.name

    if "parent_id" in fields:
        changes["parent_id"] = request.parent_id

    folder = _folder_call(
        lambda: library_folders.update_folder(db, user.id, folder_id, **changes)
    )

    return {"id": folder.id, "name": folder.name, "parent_id": folder.parent_id}


@app.delete("/api/library/folders/{folder_id}")
def delete_library_folder(folder_id: int, db: Session = Depends(get_session)):
    user = get_or_create_default_user(db)
    removed = _folder_call(
        lambda: library_folders.delete_folder(db, user.id, folder_id)
    )

    return {"status": "deleted", "folders_removed": removed}


@app.post("/api/library/folders/{folder_id}/papers")
def set_library_folder_papers(
    folder_id: int, request: FolderPapers, db: Session = Depends(get_session)
):
    user = get_or_create_default_user(db)

    return _folder_call(
        lambda: library_folders.set_membership(
            db, user.id, folder_id, request.paper_ids, request.action
        )
    )


@app.post("/api/library/{paper_id}")
def save_to_library(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    user = get_or_create_default_user(db)

    existing = (
        db.query(PersonalLibrary)
        .filter(
            PersonalLibrary.user_id == user.id,
            PersonalLibrary.paper_id == paper_id,
        )
        .first()
    )

    if existing:
        return {
            "status": "already_saved"
        }

    entry = PersonalLibrary(
        user_id=user.id,
        paper_id=paper_id,
    )

    db.add(entry)

    try:
        db.commit()

    except IntegrityError:
        # Lost the check-then-insert race against a concurrent save of
        # the same paper (double-click / two tabs): the UNIQUE constraint
        # did its job, so report the same outcome as the pre-check.
        db.rollback()
        return {
            "status": "already_saved"
        }

    # Automatic keyword assignment: a freshly saved paper without
    # keywords gets them right away (local YAKE, best-effort).
    try:
        if generate_keywords_if_missing(paper):
            validate_paper(paper)
            refresh_prepared_text(paper)
            db.commit()
            set_recommendation_index_stale(True)

    except Exception as error:
        print(
            "WARNING: Keyword assignment on save failed for paper "
            f"id={paper.id}: {error}"
        )
        db.rollback()

    return {
        "status": "saved"
    }


# ============================================================
# REMOVE PAPER FROM LIBRARY
# ============================================================

@app.delete("/api/library/{paper_id}")
def remove_from_library(
    paper_id: int,
    db: Session = Depends(get_session),
):
    user = get_or_create_default_user(db)

    entry = (
        db.query(PersonalLibrary)
        .filter(
            PersonalLibrary.user_id == user.id,
            PersonalLibrary.paper_id == paper_id,
        )
        .first()
    )

    if not entry:
        # Idempotent on purpose: a double-click (or a second tab) racing
        # the first DELETE must not surface "Paper is not in the library"
        # as an error after the paper was successfully removed.
        return {
            "status": "not_saved"
        }

    db.delete(entry)
    # A paper that leaves the library leaves its folders too.
    library_folders.clear_paper(db, user.id, paper_id)
    db.commit()

    return {
        "status": "removed"
    }


# ============================================================
# RECOMMENDATIONS
# ============================================================

IMPLEMENTED_PIPELINES = {
    "tfidf",
    "sbert",
    "tfidf_sbert",
    "tfidf_metadata",
    "sbert_metadata",
    "tfidf_sbert_metadata",
}

# The dial-allocated pipeline: the six presets plus "custom".
ALL_PIPELINE_IDS = IMPLEMENTED_PIPELINES | {"custom"}


class SearchResultOut(SearchResultOutBase):
    """
    One ranked result from /api/recommendations, plus the weighted
    per-component contributions that produced its score:

        components = {
            "tfidf": w_tfidf * s'_tfidf,
            "sbert": w_sbert * s'_sbert,
            "metadata": w_metadata * s_meta,
        }

    Additive and optional: producers that do not compute a breakdown
    (e.g. the traced/compare paths) serialize ``components: null``,
    and older clients can ignore the extra field entirely.
    """

    components: dict[str, float] | None = None

# Keep recommendation work and response sizes bounded at the API boundary.
# Pagination operates over this bounded ranked result set.
MAX_RECOMMENDATION_TOP_K = 100
DEFAULT_RECOMMENDATION_PAGE_SIZE = 20


def _resolve_custom_weights(
    pipeline: str,
    w_tfidf: float | None,
    w_sbert: float | None,
    w_metadata: float | None,
) -> dict[str, float] | None:
    """
    Normalize the dial allocation for pipeline="custom"; returns None
    for the presets. Raises 400 on misuse (missing/partial weights,
    or weights supplied with a preset pipeline).
    """
    provided = (
        w_tfidf is not None,
        w_sbert is not None,
        w_metadata is not None,
    )

    if pipeline == "custom":
        if not all(provided):
            raise HTTPException(
                status_code=400,
                detail=(
                    "The custom pipeline requires w_tfidf, "
                    "w_sbert and w_metadata."
                ),
            )

        try:
            return build_custom_weights(
                w_tfidf,  # type: ignore[arg-type]
                w_sbert,  # type: ignore[arg-type]
                w_metadata,  # type: ignore[arg-type]
            )

        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            )

    if any(provided):
        raise HTTPException(
            status_code=400,
            detail=(
                "w_tfidf/w_sbert/w_metadata may only be used "
                "with pipeline=custom."
            ),
        )

    return None


def _resolve_custom_recipe(
    custom_weights: dict[str, float] | None,
) -> dict[str, float] | None:
    """
    Normalize a Lab recipe dict ({tfidf, sbert, metadata}, any
    non-negative scale) the same way build_custom_weights does for
    the query and trace endpoints. Returns None when no recipe was
    supplied, and raises 400 for invalid values.
    """

    if custom_weights is None:
        return None

    try:
        return build_custom_weights(
            float(custom_weights.get("tfidf") or 0.0),
            float(custom_weights.get("sbert") or 0.0),
            float(custom_weights.get("metadata") or 0.0),
        )

    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "custom_weights must be non-negative numbers with "
                "at least one value greater than 0."
            ),
        ) from error


@app.get(
    "/api/recommendations",
    response_model=list[SearchResultOut],
)
def get_recommendations(
    pipeline: str,
    query: str | None = None,
    seed_paper_id: int | None = None,
    top_k: int = 10,
    page: int | None = None,
    page_size: int | None = None,
    mmr_lambda: float | None = None,
    mmr_pool: int = 50,
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
    db: Session = Depends(get_session),
):
    """Return ranked recommendations, optionally paged.

    ``top_k`` is limited to 100. Existing callers that omit ``page`` and
    ``page_size`` receive the same bare list response as before. When either
    pagination parameter is supplied, the response remains a list and contains
    the requested page of that bounded top-K result set. ``page`` is 1-based;
    a missing page defaults to 1 and a missing page size defaults to 20.
    """

    # --------------------------------------------------------
    # Validate pipeline
    # --------------------------------------------------------

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    # --------------------------------------------------------
    # Require either query OR seed paper
    # --------------------------------------------------------

    if not query and seed_paper_id is None:
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    # --------------------------------------------------------
    # Do not allow both at the same time
    # --------------------------------------------------------

    if query and seed_paper_id is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either a query or seed_paper_id, "
                "not both."
            ),
        )

    # --------------------------------------------------------
    # Validate top_k
    # --------------------------------------------------------

    if top_k <= 0 or top_k > MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "top_k must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    if page is not None and page < 1:
        raise HTTPException(
            status_code=400,
            detail="page must be greater than 0.",
        )

    if page_size is not None and not 1 <= page_size <= MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "page_size must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    if mmr_lambda is not None and not 0.0 <= mmr_lambda <= 1.0:
        raise HTTPException(
            status_code=400,
            detail="mmr_lambda must be between 0 and 1.",
        )

    if not 1 <= mmr_pool <= MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "mmr_pool must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    # --------------------------------------------------------
    # Validate seed paper
    # --------------------------------------------------------

    if seed_paper_id is not None:
        seed_paper = (
            db.query(Paper)
            .filter(Paper.id == seed_paper_id)
            .first()
        )

        if not seed_paper:
            raise HTTPException(
                status_code=404,
                detail="Seed paper not found.",
            )

    # --------------------------------------------------------
    # Run recommendation search
    # --------------------------------------------------------

    try:
        results = run_search(
            db=db,
            query=query,
            seed_paper_id=seed_paper_id,
            pipeline=pipeline,
            top_k=top_k,
            custom_weights=custom_weights,
            mmr_lambda=mmr_lambda,
            mmr_pool=mmr_pool,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("RECOMMENDATION SEARCH FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Recommendation search failed.",
        ) from error

    if page is not None or page_size is not None:
        requested_page = page or 1
        requested_page_size = page_size or DEFAULT_RECOMMENDATION_PAGE_SIZE
        start = (requested_page - 1) * requested_page_size
        return results[start : start + requested_page_size]

    return results


# ============================================================
# RECOMMENDATION EXECUTION TRACE
# ============================================================

@app.post(
    "/api/recommendations/trace",
    response_model=RecommendationTraceResponse,
)
def get_recommendation_trace(
    request: RecommendationTraceRequest,
    db: Session = Depends(get_session),
):
    """
    Run the recommendation search with instrumentation attached.

    Returns the same ranked results as /api/recommendations, plus an
    ordered list of trace events showing the actual intermediate
    values at every step of the computation (prepared query text,
    component scores, normalization bounds, weighted combination,
    ranking) -- for the mathematical visualization in the UI.
    """

    # --------------------------------------------------------
    # Require either query OR seed paper
    # --------------------------------------------------------

    if (
        not request.query
        and request.seed_paper_id is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    # --------------------------------------------------------
    # Do not allow both at the same time
    # --------------------------------------------------------

    if (
        request.query
        and request.seed_paper_id is not None
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either a query or seed_paper_id, "
                "not both."
            ),
        )

    # --------------------------------------------------------
    # Validate seed paper
    # --------------------------------------------------------

    if request.seed_paper_id is not None:
        seed_paper = (
            db.query(Paper)
            .filter(Paper.id == request.seed_paper_id)
            .first()
        )

        if not seed_paper:
            raise HTTPException(
                status_code=404,
                detail="Seed paper not found.",
            )

    custom_weights = _resolve_custom_weights(
        request.pipeline,
        request.w_tfidf,
        request.w_sbert,
        request.w_metadata,
    )

    # --------------------------------------------------------
    # Run the traced search
    # --------------------------------------------------------

    try:
        return run_traced_search(
            db=db,
            query=request.query,
            seed_paper_id=request.seed_paper_id,
            pipeline=request.pipeline,
            top_k=request.top_k,
            custom_weights=custom_weights,
            mmr_lambda=request.mmr_lambda,
            mmr_pool=request.mmr_pool,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("RECOMMENDATION TRACE FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Recommendation trace failed.",
        ) from error

# ============================================================
# PIPELINE COMPARISON ("PIPELINE BATTLE")
# ============================================================

def _clean_tag(value: str | None) -> str | None:
    """A trimmed research tag, or None when it carries nothing.

    An empty string in the database is a lie of omission: it reads as
    "the researcher labelled this run" to anything that only checks
    for presence. Normalising here means the split in
    evaluation/battle_log.py can treat "" and NULL as the same
    untagged bucket.
    """

    if value is None:
        return None

    trimmed = value.strip()

    return trimmed or None


def _record_battle_run(
    *,
    db: Session,
    result: CompareResponse,
    query: str | None,
    seed_paper_id: int | None,
    top_k: int,
    custom_weights: dict[str, float] | None,
    mmr_lambda: float | None,
    mmr_pool: int,
    run_label: str | None,
    subject_class: str | None,
) -> BattleRun:
    """Write one recorded battle, with everything needed to analyse it later.

    Kept apart from the route for one reason: once the campaign is
    collecting data, this function must never be able to influence a
    result. It is handed the finished CompareResponse and the request
    values it was run with, and it only reads -- it re-derives no
    score, recomputes no consensus, and re-picks no winner, so a bug
    here can cost a run its label but cannot change what the pipeline
    decided.

    ``response_json`` is the whole point of the table's research
    half. The consensus entries with their vote counts and average
    ranks, the per-pipeline ranked lists, and every pairwise overlap
    and mean rank gap exist only in this object; without the blob they
    are returned to the browser and lost, which is why the Arena used
    to keep a winner summary and nothing else.

    ``mmr_pool`` is stored only when diversification actually ran:
    a plain Arena battle leaves the request's default 50 in place,
    and recording that as though it had been chosen would put a knob
    in the export that was never used.
    """

    corpus = corpus_snapshot(db)

    run = BattleRun(
        query=query,
        seed_paper_id=seed_paper_id,
        top_k=top_k,
        winner_pipeline_id=result.winner.pipeline_id,
        winner_metric=result.winner.metric,
        winner_value=result.winner.value,
        avg_consensus_rank=result.winner.avg_consensus_rank,
        run_label=_clean_tag(run_label),
        subject_class=_clean_tag(subject_class),
        # The route already rejects a request carrying both a query and
        # a seed paper, so which one is set IS the query kind. Storing
        # it means the campaign's text-vs-seed split is a group-by on
        # an indexed column rather than a CASE over nullable text.
        query_kind="seed" if seed_paper_id is not None else "text",
        mmr_lambda=mmr_lambda,
        mmr_pool=mmr_pool if mmr_lambda is not None else None,
        custom_weights=(
            json.dumps(custom_weights) if custom_weights else None
        ),
        response_json=result.model_dump_json(),
        corpus_size=corpus["corpus_size"],
        corpus_version=corpus["corpus_version"],
        margin=result.winner.margin,
        decisive=result.winner.decisive,
    )

    judgement = result.judgement

    if judgement:
        run.judged_basis = judgement["basis"]
        run.judged_leader = judgement.get("leader")
        run.judgement_json = json.dumps(judgement)

    db.add(run)
    db.commit()

    return run


def _validate_compare_request(request: CompareRequest, db: Session) -> None:
    """Shared by the one-shot and the streaming compare routes."""

    if not request.query and request.seed_paper_id is None:
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id.",
        )

    if request.query and request.seed_paper_id is not None:
        raise HTTPException(
            status_code=400,
            detail="Provide either a query or seed_paper_id, not both.",
        )

    if request.seed_paper_id is not None:
        seed_paper = (
            db.query(Paper).filter(Paper.id == request.seed_paper_id).first()
        )

        if not seed_paper:
            raise HTTPException(status_code=404, detail="Seed paper not found.")


def _finish_compare(
    db: Session,
    request: CompareRequest,
    result: CompareResponse,
    custom_weights,
) -> CompareResponse:
    """Judge a seed-paper battle and record the run.

    Runs with no winner (empty repository) are not recorded, and Lab
    simulations opt out so they don't pollute the Arena's records.
    Everything past the winner summary is provenance, written from
    values the run already has (see _record_battle_run).
    """

    # A seed-paper battle has ground truth: the paper's own references.
    # Score the lists against it (best-effort; never costs the battle).
    if request.seed_paper_id is not None:
        try:
            result.judgement = battle_judge.judge_seed_battle(
                db, result.model_dump(), request.seed_paper_id
            )
        except Exception as error:
            print(f"BATTLE JUDGEMENT FAILED: {error}")

    if result.winner is not None and request.record_battle:
        recorded = _record_battle_run(
            db=db,
            result=result,
            query=request.query,
            seed_paper_id=request.seed_paper_id,
            top_k=request.top_k,
            custom_weights=custom_weights,
            mmr_lambda=request.mmr_lambda,
            mmr_pool=request.mmr_pool,
            run_label=request.run_label,
            subject_class=request.subject_class,
        )
        result.battle_id = recorded.id

    return result


def _compare_kwargs(request: CompareRequest, custom_weights) -> dict:
    return dict(
        query=request.query,
        seed_paper_id=request.seed_paper_id,
        top_k=request.top_k,
        custom_weights=custom_weights,
        mmr_lambda=request.mmr_lambda,
        mmr_pool=request.mmr_pool,
    )


@app.post(
    "/api/recommendations/compare",
    response_model=CompareResponse,
)
def compare_recommendation_pipelines(
    request: CompareRequest,
    db: Session = Depends(get_session),
):
    """
    Run all six recommendation pipelines against the same query or
    seed paper and return the ranked results side by side, plus
    consensus ranking and pairwise agreement statistics -- the raw
    material for the thesis evaluation chapter.
    """

    _validate_compare_request(request, db)
    custom_weights = _resolve_custom_recipe(request.custom_weights)

    try:
        result = compare_pipelines(
            db=db, **_compare_kwargs(request, custom_weights)
        )

        return _finish_compare(db, request, result, custom_weights)

    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    except Exception as error:
        print()
        print("PIPELINE COMPARISON FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Pipeline comparison failed.",
        ) from error


@app.post("/api/recommendations/compare/stream")
def compare_recommendation_pipelines_stream(
    request: CompareRequest,
    db: Session = Depends(get_session),
):
    """The same battle, reported as it happens (newline-delimited JSON).

    Events: ``start`` (the pipeline ids, in run order), one ``pipeline``
    per finished pipeline (its results and seconds), then ``done`` with
    the full response exactly as the one-shot route returns it, or
    ``error``. Validation failures are ordinary HTTP errors, sent before
    the stream opens.
    """

    _validate_compare_request(request, db)
    custom_weights = _resolve_custom_recipe(request.custom_weights)

    def lines():
        # The request's session may be closed before a streamed body is
        # finished, so the stream works on its own.
        with SessionLocal() as session:
            try:
                for event in compare_pipelines_stream(
                    db=session, **_compare_kwargs(request, custom_weights)
                ):
                    kind = event[0]

                    if kind == "start":
                        payload = {"event": "start", "pipelines": event[1]}
                    elif kind == "pipeline":
                        payload = {
                            "event": "pipeline",
                            "id": event[1].id,
                            "seconds": round(event[2], 3),
                            "results": [r.model_dump() for r in event[1].results],
                        }
                    else:
                        done = _finish_compare(
                            session, request, event[1], custom_weights
                        )
                        payload = {
                            "event": "done",
                            "response": done.model_dump(mode="json"),
                        }

                    yield json.dumps(payload) + "\n"
            except ValueError as error:
                yield json.dumps({"event": "error", "detail": str(error)}) + "\n"
            except Exception as error:
                print(f"PIPELINE COMPARISON FAILED: {error}")
                yield json.dumps(
                    {"event": "error", "detail": "Pipeline comparison failed."}
                ) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


# ============================================================
# RECIPE SWEEP — the Lab's blend explorer
# ============================================================

class RecipeSweepRequest(BaseModel):
    n_queries: int = Field(default=30, ge=4, le=100)
    k: int = Field(default=10, ge=1, le=25)
    step: int = 10
    min_refs: int = Field(default=3, ge=1, le=20)
    seed: int = Field(default=0, ge=0)


@app.post("/api/evaluation/recipe-sweep")
def run_recipe_sweep(request: RecipeSweepRequest):
    """Score a grid of signal blends on leave-one-out queries.

    Streams newline-delimited JSON: ``start``, ``progress`` per query,
    then ``done`` with the result (see evaluation/recipe_sweep.py).
    Nothing is stored: a sweep is an experiment, not a record.
    """

    if request.step not in recipe_sweep.ALLOWED_STEPS:
        raise HTTPException(
            status_code=400,
            detail=f"step must be one of {list(recipe_sweep.ALLOWED_STEPS)}.",
        )

    def lines():
        with SessionLocal() as session:
            try:
                for event in recipe_sweep.run_sweep(
                    session,
                    n_queries=request.n_queries,
                    k=request.k,
                    step=request.step,
                    min_refs=request.min_refs,
                    seed=request.seed,
                ):
                    yield json.dumps(event) + "\n"
            except Exception as error:
                print(f"RECIPE SWEEP FAILED: {error}")
                yield json.dumps(
                    {"event": "error", "detail": "The sweep failed."}
                ) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


# ============================================================
# BATTLE SERIES — many queries under one label, one board
# ============================================================

class SeriesQueriesRequest(BaseModel):
    text: str = ""


@app.post("/api/evaluation/battle-series/queries")
def clean_battle_series_queries(request: SeriesQueriesRequest):
    """Normalise a pasted query list (one per line)."""

    return battle_series.clean_queries(request.text)


@app.get("/api/evaluation/battle-series/sample")
def sample_battle_series_seeds(
    n: int = Query(10, ge=1, le=battle_series.MAX_SERIES),
    seed: int = Query(0, ge=0),
    db: Session = Depends(get_session),
):
    """Seed papers for a series, sampled across publication years from
    the papers that have resolved references (so every battle in the
    series can be judged automatically)."""

    queries = loo_qrels.build_loo_queries(
        db, n=n, min_refs=1, seed=seed
    )

    return {
        "eligible": loo_qrels.count_eligible(db, 1),
        "papers": [
            {
                "id": q.seed_paper_id,
                "title": q.title,
                "year": q.year,
                "n_refs": q.n_refs,
            }
            for q in queries
        ],
    }


@app.get("/api/evaluation/battle-series/labels")
def list_battle_series_labels(db: Session = Depends(get_session)):
    """Run labels in use, most recent first, with their battle counts."""

    rows = (
        db.query(
            BattleRun.run_label,
            func.count(BattleRun.id),
            func.max(BattleRun.created_at),
        )
        .filter(BattleRun.run_label.isnot(None), BattleRun.run_label != "")
        .group_by(BattleRun.run_label)
        .order_by(func.max(BattleRun.created_at).desc())
        .limit(30)
        .all()
    )

    return [
        {"label": label, "battles": count, "last": last.isoformat() if last else None}
        for label, count, last in rows
    ]


@app.get("/api/evaluation/battle-series/summary")
def summarise_battle_series(
    label: str = Query(..., min_length=1, max_length=200),
    db: Session = Depends(get_session),
):
    """Pool every recorded battle carrying ``label``."""

    runs = (
        db.query(BattleRun)
        .filter(
            BattleRun.run_label == label,
            BattleRun.winner_metric == CURRENT_BATTLE_METRIC,
        )
        .order_by(BattleRun.id)
        .all()
    )

    return {
        "label": label,
        **battle_series.series_summary(
            [
                {
                    "query": run.query,
                    "seed_paper_id": run.seed_paper_id,
                    "response_json": run.response_json,
                    "judgement_json": run.judgement_json,
                }
                for run in runs
            ]
        ),
    }


# ============================================================
# PIPELINE COMPARISON OVER THE WEB ("WEB BATTLE")
# ============================================================

class WebCompareRequest(BaseModel):
    """Battle the pipelines over live web search hits instead of the
    repository. Same shape as CompareRequest, minus seed_paper_id —
    a web battle always runs on a query."""

    q: str
    top_k: int = 5
    sources: str = "openalex,crossref,arxiv"
    sort: str = "relevance"
    peer_reviewed: bool = True
    open_access: bool = False
    custom_weights: dict[str, float] | None = None


@app.post(
    "/api/recommendations/web-compare",
    response_model=CompareResponse,
)
def web_compare_recommendation_pipelines(
    request: WebCompareRequest,
):
    """
    Fetch live hits from the open scholarly web (OpenAlex, Crossref,
    arXiv), vectorize them on the fly with the same stored TF-IDF
    vectorizer and S-BERT model, and battle the six pipelines (plus
    an optional custom recipe) over those external candidates. The
    response is a standard CompareResponse, so the Arena and Lab
    render it exactly like a repository battle. Web battles are
    exploratory and never recorded to the battle history.
    """

    query = (request.q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if request.sort not in WEB_SEARCH_SORTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"sort must be one of: {', '.join(WEB_SEARCH_SORTS)}."
            ),
        )

    requested_sources = tuple(
        source.strip()
        for source in request.sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv", "doaj")
    )

    try:
        hits = search_web(
            query,
            year_min=None,
            year_max=None,
            peer_reviewed=request.peer_reviewed,
            open_access_only=request.open_access,
            sources=requested_sources,
            sort=request.sort,
            limit=max(10, min(request.top_k * 3, 30)),
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    custom_weights = _resolve_custom_recipe(request.custom_weights)

    try:
        result = compare_web_results(
            query=query,
            hits=hits,
            top_k=request.top_k,
            custom_weights=custom_weights,
        )
        return result

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("WEB PIPELINE COMPARISON FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Web pipeline comparison failed.",
        ) from error


@app.get("/api/recommendations/web")
def recommend_from_web(
    q: str,
    pipeline: str,
    top_k: int = 20,
    year_min: int | None = None,
    year_max: int | None = None,
    peer_reviewed: bool = True,
    open_access: bool = False,
    sources: str = "openalex,crossref,arxiv",
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
):
    """
    Recommend from the open web with ONE of the pipelines.

    Fetches live hits from OpenAlex, Crossref and arXiv (the same
    sources as the web search), vectorizes them on the fly with the
    stored TF-IDF vectorizer and the S-BERT model, and ranks them with
    the chosen pipeline's weights (or the custom dial allocation). Each
    row is the web hit plus its rank, final score and component scores.
    Web recommendations are exploratory and are never recorded.
    """

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    query = (q or "").strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Enter a search query.",
        )

    if top_k <= 0 or top_k > 25:
        raise HTTPException(
            status_code=400,
            detail="top_k must be between 1 and 25 for web results.",
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    from app.services.recommendation.pipeline_config import (
        get_pipeline_weights,
    )

    weights = (
        custom_weights
        if pipeline == "custom"
        else get_pipeline_weights(pipeline)
    )

    requested_sources = tuple(
        source.strip()
        for source in sources.split(",")
        if source.strip() in ("openalex", "crossref", "arxiv", "doaj")
    )

    try:
        hits = search_web(
            query,
            year_min=year_min,
            year_max=year_max,
            peer_reviewed=peer_reviewed,
            open_access_only=open_access,
            sources=requested_sources,
            sort="relevance",
            limit=25,
        )

    except WebSearchError as error:
        raise HTTPException(
            status_code=502,
            detail="The web search services could not be reached.",
        ) from error

    try:
        return rank_web_results(
            query=query,
            hits=hits,
            weights=weights,
            top_k=top_k,
        )

    except Exception as error:
        print()
        print("WEB RECOMMENDATION FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Web recommendation failed.",
        ) from error


# ============================================================
# BATTLE HISTORY
# ============================================================

@app.get("/api/evaluation/battles")
def get_battle_history(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_session),
):
    """
    Battle history, paginated, newest first — plus the win tally
    across ALL recorded runs so the Arena page's champion board
    stays correct no matter which page is displayed.

    Every recorded pipeline-battle run is logged; the tally counts
    wins per pipeline over the whole table.
    """

    page = max(1, page)
    page_size = max(1, min(page_size, 100))

    total = db.query(BattleRun).count()
    pages = max(1, (total + page_size - 1) // page_size)

    runs = (
        db.query(BattleRun)
        .order_by(
            BattleRun.created_at.desc(),
            BattleRun.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # A "win" only counts when it was decisive: the consensus share is a
    # near coin-flip most of the time, so wins by a hair are not wins. Runs
    # scored by the older vote-count rule, and runs whose margin cannot be
    # recovered, are counted separately instead of being mixed in.
    tally_rows = (
        db.query(
            BattleRun.winner_pipeline_id,
            func.count(BattleRun.id),
        )
        .filter(BattleRun.winner_metric == CURRENT_BATTLE_METRIC)
        .filter(BattleRun.decisive.is_(True))
        .group_by(BattleRun.winner_pipeline_id)
        .all()
    )

    return {
        "runs": [_battle_run_dict(run) for run in runs],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "tally": [
            {
                "pipeline_id": pipeline_id,
                "wins": wins,
            }
            for pipeline_id, wins in tally_rows
        ],
        "verdicts": _battle_verdict_counts(db),
    }


CURRENT_BATTLE_METRIC = "independence_weighted_consensus"


def _battle_verdict_counts(db: Session) -> dict:
    """How the recorded battles split by how trustworthy their verdict is."""

    current = BattleRun.winner_metric == CURRENT_BATTLE_METRIC

    def count(*conditions) -> int:
        return db.query(BattleRun).filter(*conditions).count()

    return {
        "decisive": count(current, BattleRun.decisive.is_(True)),
        "too_close": count(current, BattleRun.decisive.is_(False)),
        # current rule, but no margin was ever stored and no lists kept
        "unknown": count(current, BattleRun.decisive.is_(None)),
        # scored by the earlier vote-count rule: not comparable
        "legacy": count(BattleRun.winner_metric != CURRENT_BATTLE_METRIC),
        "judged": count(BattleRun.judged_basis.isnot(None)),
    }


# ============================================================
# BATTLE HISTORY — EXPORT / ARCHIVE / RESET / STATS
# ============================================================
#
# The four routes the campaign protocol needs. Chapter III collects a
# fixed set of formal runs and reports only those, with development
# walkthroughs excluded -- which means the tally has to be provably
# reset and exportable on the morning the campaign starts, not
# reconstructed afterwards from timestamps.

# Columns the export and the stats read, in one place so a new
# research-log column is added in three spots at most (here, the
# model, and SCALAR_COLUMNS in evaluation/battle_log.py).
_BATTLE_EXPORT_COLUMNS = (
    BattleRun.id,
    BattleRun.created_at,
    BattleRun.run_label,
    BattleRun.subject_class,
    BattleRun.query_kind,
    BattleRun.query,
    BattleRun.seed_paper_id,
    BattleRun.top_k,
    BattleRun.winner_pipeline_id,
    BattleRun.winner_metric,
    BattleRun.winner_value,
    BattleRun.avg_consensus_rank,
    BattleRun.mmr_lambda,
    BattleRun.mmr_pool,
    BattleRun.custom_weights,
    BattleRun.response_json,
    BattleRun.corpus_size,
    BattleRun.corpus_version,
    BattleRun.margin,
    BattleRun.decisive,
    BattleRun.judged_basis,
    BattleRun.judged_leader,
)


def _battle_run_dict(run: BattleRun) -> dict:
    """One recorded run as the API's plain-dict shape.

    Shared by the paginated history and the export, so the two can
    never disagree about a column's name or nullability.
    response_json is deliberately NOT included: the paginated list
    would carry six pipelines' worth of ranked lists per row, and the
    JSONL export exists precisely to move that around.
    """

    return {
        "id": run.id,
        "query": run.query,
        "seed_paper_id": run.seed_paper_id,
        "top_k": run.top_k,
        "winner_pipeline_id": run.winner_pipeline_id,
        "winner_metric": run.winner_metric,
        "winner_value": run.winner_value,
        "avg_consensus_rank": run.avg_consensus_rank,
        "run_label": run.run_label,
        "subject_class": run.subject_class,
        "query_kind": run.query_kind,
        "corpus_size": run.corpus_size,
        "corpus_version": run.corpus_version,
        "margin": run.margin,
        "decisive": run.decisive,
        "judged_basis": run.judged_basis,
        "judged_leader": run.judged_leader,
        "created_at": run.created_at.isoformat(),
    }


def _battle_run_payload(run) -> dict:
    """``_battle_run_dict`` plus the stored response blob.

    The export needs the blob and the paginated list does not, so it
    is added here rather than in the shared helper.
    """

    payload = _battle_run_dict(run)

    payload["custom_weights"] = run.custom_weights
    payload["mmr_lambda"] = run.mmr_lambda
    payload["mmr_pool"] = run.mmr_pool
    payload["response_json"] = run.response_json

    return payload


def _iter_battle_runs(db: Session):
    """Every recorded run, oldest first, as plain dicts.

    Ordered oldest-first because an exported file read by a person
    should run in the order the campaign did. The session is yielded
    rows one at a time rather than .all() so the export never holds
    the whole table -- and, more importantly, so the response body can
    start arriving while the rows are still being read.
    """

    for run in (
        db.query(*_BATTLE_EXPORT_COLUMNS)
        .order_by(BattleRun.created_at.asc(), BattleRun.id.asc())
        .yield_per(200)
    ):
        yield _battle_run_payload(run)


def _clear_battle_runs(db: Session) -> int:
    """Empty the table, returning how many rows went.

    A single DELETE ... WHERE true rather than loading and db.delete()ing
    each row: the table holds one row per run and a campaign archives
    in one go, and the ORM route would make the reset as slow as the
    largest history ever recorded.
    """

    deleted = (
        db.query(BattleRun)
        .delete()
    )

    db.commit()

    return int(deleted or 0)


# ============================================================
# TOURNAMENTS (statistically grounded battles)
#
# The single-bout Arena crowns a consensus winner with no ground truth
# and no uncertainty. A tournament scores every pipeline on many
# leave-one-out citation queries and lets paired tests decide; see
# app/services/evaluation/tournament.py and stats.py.
# ============================================================

class TournamentRequest(BaseModel):
    pipelines: list[str] | None = None
    top_k: int = 10
    n_queries: int = 60
    min_refs: int = 3
    primary_metric: str = "ndcg"
    seed: int = 0
    custom_weights: dict[str, float] | None = None
    label: str | None = None
    record: bool = True


@app.get("/api/evaluation/tournament/pool")
def tournament_pool(
    min_refs: int = 3,
    db: Session = Depends(get_session),
):
    """How many leave-one-out queries the repository can supply."""

    return eligible_query_count(db, max(1, min_refs))


@app.post("/api/evaluation/tournament")
def run_pipeline_tournament(
    request: TournamentRequest,
    db: Session = Depends(get_session),
):
    custom_weights = _resolve_custom_recipe(request.custom_weights)
    pipelines = request.pipelines

    if custom_weights and pipelines and "custom" not in pipelines:
        pipelines = [*pipelines, "custom"]

    try:
        return run_tournament(
            db,
            pipelines=pipelines,
            top_k=request.top_k,
            n_queries=request.n_queries,
            min_refs=request.min_refs,
            primary_metric=request.primary_metric,
            seed=request.seed,
            custom_weights=custom_weights,
            label=_clean_tag(request.label),
            record=request.record,
        )

    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    except Exception as error:
        print()
        print("TOURNAMENT FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Tournament failed.",
        ) from error


@app.get("/api/evaluation/tournament/history")
def tournament_history(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_session),
):
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    total = db.query(TournamentRun).count()

    runs = (
        db.query(TournamentRun)
        .order_by(TournamentRun.created_at.desc(), TournamentRun.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return {
        "runs": [tournament_run_summary(run) for run in runs],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


# ---- durable tournaments: run in the background, survive sleep -------
#
# POST /start returns at once; the run lives on the server and is saved
# query by query. Poll /status (or /active after a reload), /resume an
# interrupted one, /stop to pause, DELETE to discard an unfinished one.

@app.post("/api/evaluation/tournament/start")
def start_pipeline_tournament(
    request: TournamentRequest,
    db: Session = Depends(get_session),
):
    custom_weights = _resolve_custom_recipe(request.custom_weights)
    pipelines = request.pipelines

    if custom_weights and pipelines and "custom" not in pipelines:
        pipelines = [*pipelines, "custom"]

    live = tournament_jobs.latest_unfinished(db)

    if live is not None and tournament_jobs.status_payload(db, live)["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail=(
                "A tournament is already running. Wait for it to finish "
                "or stop it first."
            ),
        )

    try:
        run = tournament_jobs.create_run(
            db,
            pipelines=pipelines,
            top_k=request.top_k,
            n_queries=request.n_queries,
            min_refs=request.min_refs,
            primary_metric=request.primary_metric,
            seed=request.seed,
            custom_weights=custom_weights,
            label=_clean_tag(request.label),
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    tournament_jobs.start_run(SessionLocal, run.id)

    # The worker flipped the row to "running" from its own session.
    db.refresh(run)

    return tournament_jobs.status_payload(db, run)


@app.get("/api/evaluation/tournament/active")
def active_tournament(db: Session = Depends(get_session)):
    """The newest unfinished run (running / interrupted / failed), so a
    reloaded page can pick it up again; ``{"run": null}`` if none."""

    run = tournament_jobs.latest_unfinished(db)

    return {
        "run": tournament_jobs.status_payload(db, run) if run else None
    }


def _unfinished_run(db: Session, run_id: int) -> TournamentRun:
    run = db.get(TournamentRun, run_id)

    if run is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")

    return run


@app.get("/api/evaluation/tournament/{run_id}/status")
def tournament_status(run_id: int, db: Session = Depends(get_session)):
    return tournament_jobs.status_payload(db, _unfinished_run(db, run_id))


@app.post("/api/evaluation/tournament/{run_id}/resume")
def resume_tournament(run_id: int, db: Session = Depends(get_session)):
    run = _unfinished_run(db, run_id)

    if run.status == "done":
        raise HTTPException(status_code=409, detail="That tournament is finished.")

    if not tournament_jobs.start_run(SessionLocal, run_id):
        raise HTTPException(status_code=409, detail="That tournament is already running.")

    db.refresh(run)

    return tournament_jobs.status_payload(db, run)


@app.post("/api/evaluation/tournament/{run_id}/stop")
def stop_tournament(run_id: int, db: Session = Depends(get_session)):
    _unfinished_run(db, run_id)
    tournament_jobs.stop_run(run_id)

    return {"stopping": True}


@app.post("/api/evaluation/tournament/{run_id}/reanalyze")
def reanalyze_tournament(run_id: int, db: Session = Depends(get_session)):
    """Re-run the statistics on a finished run's stored scores (the scores
    are untouched; only the verdict is recomputed with the current tests)."""

    run = db.get(TournamentRun, run_id)

    if run is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")

    if not tournament_jobs.reanalyze_run(db, run_id):
        raise HTTPException(
            status_code=409,
            detail=(
                "Only a finished tournament started from this version can be "
                "re-analysed (older runs have no saved settings)."
            ),
        )

    return _tournament_detail(db, run_id)


@app.delete("/api/evaluation/tournament/{run_id}")
def discard_tournament(run_id: int, db: Session = Depends(get_session)):
    _unfinished_run(db, run_id)

    if not tournament_jobs.discard_run(db, run_id):
        raise HTTPException(
            status_code=409,
            detail="Only a stopped, unfinished tournament can be discarded.",
        )

    return {"status": "discarded"}


def _tournament_detail(db: Session, run_id: int) -> dict:
    run = db.get(TournamentRun, run_id)

    if run is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")

    # An unfinished run has no verdict yet (its result is an empty record).
    # Handing that out as if it were a result is what let a client read
    # `verdict.omnibus` of nothing, so say plainly that it is not ready.
    if run.status != "done":
        raise HTTPException(
            status_code=409,
            detail=(
                f"That tournament is {run.status}, not finished: it has no "
                "result yet."
            ),
        )

    scores = (
        db.query(TournamentQueryScore)
        .filter(TournamentQueryScore.run_id == run_id)
        .order_by(
            TournamentQueryScore.seed_paper_id,
            TournamentQueryScore.pipeline_id,
        )
        .all()
    )

    return {
        **json.loads(run.result_json),
        "run_id": run.id,
        "created_at": run.created_at.isoformat(),
        "query_scores": [
            {
                "pipeline_id": row.pipeline_id,
                "seed_paper_id": row.seed_paper_id,
                "num_relevant": row.num_relevant,
                "ndcg": row.ndcg,
                "mrr": row.mrr,
                "recall": row.recall,
                "hit": row.hit,
            }
            for row in scores
        ],
    }


@app.get("/api/evaluation/tournament/{run_id}")
def get_tournament(run_id: int, db: Session = Depends(get_session)):
    return _tournament_detail(db, run_id)


@app.get("/api/evaluation/tournament/{run_id}/export")
def export_tournament_run(
    run_id: int,
    format: str = "csv",
    db: Session = Depends(get_session),
):
    """Download a stored tournament: raw per-query scores (csv),
    the pairwise tests (pairwise) or the whole record (json)."""

    detail = _tournament_detail(db, run_id)

    try:
        filename, media_type, text = export_tournament(detail, format)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return Response(
        content=text,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ============================================================
# JUDGING BATTLES AGAINST GROUND TRUTH
#
# The consensus winner measures agreement, not quality. A judged battle
# scores the pipelines' lists against actual relevance: a seed paper's own
# references (automatic, see /api/recommendations/compare) or results a
# person ticked as relevant with the pipeline names hidden (below).
# ============================================================

class JudgeRequest(BaseModel):
    # The recorded battle to judge. Its stored lists are used, so the
    # client cannot judge lists the pipelines never returned.
    battle_id: int | None = None
    # Without a recorded battle (a web or Lab battle), the lists to judge.
    lists: dict[str, list[int]] | None = None
    top_k: int = 10
    # Paper ids the person ticked as relevant.
    relevant: list[int] = Field(default_factory=list)


@app.post("/api/evaluation/judge")
def judge_battle(
    request: JudgeRequest,
    db: Session = Depends(get_session),
):
    """Score a battle by the results a person judged relevant (human basis)."""

    run = None

    if request.battle_id is not None:
        run = db.get(BattleRun, request.battle_id)

        if run is None:
            raise HTTPException(status_code=404, detail="Battle not found.")

        if not run.response_json:
            raise HTTPException(
                status_code=409,
                detail="That battle kept no result lists, so it cannot be judged.",
            )

        response = json.loads(run.response_json)
        lists = battle_judge.lists_from_response(response)
        top_k = int(response.get("top_k", request.top_k))
    elif request.lists:
        lists, top_k = request.lists, request.top_k
    else:
        raise HTTPException(
            status_code=400,
            detail="Give a battle_id or the result lists to judge.",
        )

    pooled = {pid for ids in lists.values() for pid in ids}
    ticked = [pid for pid in dict.fromkeys(request.relevant) if pid in pooled]

    try:
        judgement = battle_judge.judge_lists(
            lists,
            {pid: 1 for pid in ticked},
            k=top_k,
            basis=battle_judge.BASIS_HUMAN,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    if run is not None:
        run.judged_basis = judgement["basis"]
        run.judged_leader = judgement.get("leader")
        run.judgement_json = json.dumps(judgement)
        db.commit()

    return judgement


@app.get("/api/evaluation/battles/judged")
def judged_battles_summary(db: Session = Depends(get_session)):
    """Quality per pipeline over every judged battle, with a verdict only
    once there are enough of them to support one."""

    rows = [
        {"judgement_json": text}
        for (text,) in db.query(BattleRun.judgement_json)
        .filter(BattleRun.judgement_json.isnot(None))
        .all()
    ]

    return battle_judge.judged_summary(rows)


def backfill_battle_verdicts(db: Session) -> int:
    """Recover margin/decisive for recorded battles that kept their lists.

    Older rows have a winner and its share but not the runner-up's, so
    they cannot say how close the call was. Where the full result lists
    were stored the consensus can be recomputed exactly, which settles it.
    Rows without lists are left unknown rather than guessed at.
    """

    from app.services.recommendation.compare_service import (
        PIPELINE_COMPONENTS,
        MIN_DECISIVE_MARGIN,
        consensus_shares,
    )

    done = 0

    rows = (
        db.query(BattleRun)
        .filter(BattleRun.winner_metric == CURRENT_BATTLE_METRIC)
        .filter(BattleRun.decisive.is_(None))
        .filter(BattleRun.response_json.isnot(None))
        .all()
    )

    for run in rows:
        # A custom recipe adds a pipeline whose components are not stored
        # with the battle; recomputing without it would change the answer.
        if run.custom_weights:
            continue

        try:
            data = json.loads(run.response_json)
            rank_maps = {
                p["id"]: {r["paper_id"]: i for i, r in enumerate(p["results"], 1)}
                for p in data["pipelines"]
                if p["id"] in PIPELINE_COMPONENTS
            }
            positions = {
                e["paper_id"]: i for i, e in enumerate(data["consensus"], 1)
            }
            shares, avg_ranks = consensus_shares(
                rank_maps=rank_maps,
                consensus_positions=positions,
                consensus_size=len(data["consensus"]),
                component_sets=PIPELINE_COMPONENTS,
            )
        except (KeyError, ValueError, TypeError):
            continue

        if len(shares) < 2:
            continue

        ordered = sorted(shares, key=lambda p: (-shares[p], avg_ranks[p]))
        margin = shares[ordered[0]] - shares[ordered[1]]
        run.margin = round(margin, 4)
        run.decisive = margin >= MIN_DECISIVE_MARGIN
        done += 1

    db.commit()

    return done


@app.get("/api/evaluation/battles/export")
def export_battle_history(format: str = "csv"):
    """
    The whole run history as a download: one row per run.

    `format=csv` is flattened for a spreadsheet -- scalars plus the
    consensus and pairwise figures summarised out of the stored
    response. `format=jsonl` is one JSON object per line carrying each
    run's CompareResponse in full, so the per-pipeline ranked lists,
    vote counts and overlap@k survive into analysis.

    Oldest run first, so the file reads in the order the campaign was
    run.

    No request session: a streamed body is produced after the request
    dependency has been torn down, so the generator opens its own (see
    `stream` below).
    """

    if format not in EXPORT_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown export format: {format!r}. "
                f"Use one of {', '.join(EXPORT_FORMATS)}."
            ),
        )

    # UTC, like every timestamp the table itself stores, so a filename
    # sitting in a folder can be compared against the runs inside it
    # without first working out a timezone.
    stamped = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"battle_runs-{stamped}.{format}"

    # The generator opens its own session: FastAPI finishes the request
    # dependency -- and closes its session -- before a streaming body
    # is sent, so a generator reading `db` here would be reading a
    # closed session halfway through a large export.
    def stream():
        db_stream = SessionLocal()

        try:
            for chunk in iter_export(
                _iter_battle_runs(db_stream),
                format,
            ):
                yield chunk
        finally:
            db_stream.close()

    return StreamingResponse(
        stream(),
        media_type=(
            "text/csv; charset=utf-8"
            if format == "csv"
            else "application/x-ndjson; charset=utf-8"
        ),
        headers={
            # The download is a snapshot of the research record, so it
            # gets a name a person can find again in a folder.
            "Content-Disposition": (
                f'attachment; filename="{filename}"'
            ),
        },
    )


@app.post("/api/evaluation/battles/archive")
def archive_battle_history(db: Session = Depends(get_session)):
    """
    Write the current history to a timestamped JSONL file under
    storage/exports/, then clear the table.

    This is the campaign workflow: archive whatever walkthroughs have
    accumulated, start the table clean, then run the campaign so the
    tally can only be describing formal runs.

    JSONL rather than CSV because the archive is the copy that has to
    stay analysable -- it carries every run's consensus and pairwise
    structure, which a flattened row cannot.

    The file is written in full before a single row is deleted. If the
    write fails the table is untouched, because losing a run nobody
    can see is worse than an archive that did not happen.
    """

    directory = exports_dir()
    stamped = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    path = directory / f"battle_runs-{stamped}.jsonl"

    archived = 0

    try:
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            for chunk in iter_export(
                _iter_battle_runs(db),
                "jsonl",
            ):
                handle.write(chunk)
                archived += chunk.count("\n")

            # fsync before any row is deleted: the file has to be on
            # disk, not merely in the buffer, before the table that
            # holds the only other copy is emptied.
            handle.flush()
            os.fsync(handle.fileno())

    except Exception as error:
        print("BATTLE ARCHIVE FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Could not write the battle archive; no rows were deleted.",
        ) from error

    deleted = _clear_battle_runs(db)

    return {
        "status": "archived",
        "archived": archived,
        "deleted": deleted,
        "filename": path.name,
        # Relative to the project root, the same convention the paper
        # file paths use -- an absolute path from a browser is a
        # machine detail nobody else can open.
        "path": f"storage/exports/{path.name}",
    }


@app.delete("/api/evaluation/battles")
def delete_battle_history(
    confirm: bool = Query(
        default=False,
        description=(
            "Must be true. Clears every recorded run with no copy "
            "kept anywhere."
        ),
    ),
    db: Session = Depends(get_session),
):
    """
    Clear the battle history for good.

    Destructive and unrecoverable: unlike /archive this writes nothing
    first, so `confirm=true` is required rather than assumed. The
    campaign protocol calls for archiving, not deleting -- a delete is
    for clearing a table that is about to be replaced.
    """

    if not confirm:
        raise HTTPException(
            status_code=400,
            detail=(
                "Refusing to clear the battle history without "
                "confirm=true. Use /api/evaluation/battles/archive to "
                "keep a copy."
            ),
        )

    deleted = _clear_battle_runs(db)

    return {
        "status": "deleted",
        "deleted": deleted,
    }


@app.get("/api/evaluation/battles/stats")
def get_battle_stats(db: Session = Depends(get_session)):
    """
    Win shares per pipeline over the recorded runs: overall, split by
    query kind, and split by subject class.

    The aggregate the results chapter is written from. Splits with
    fewer than battle_log.MIN_BATTLES_PER_SPLIT runs are omitted and
    listed in `omitted` instead, because a share taken from one battle
    is 0% or 100% and reads like a result.

    Runs that predate the research-log columns carry no query kind
    label of their own beyond the backfill and no subject class at
    all; they appear as (untagged) buckets rather than being dropped.
    """

    runs = [
        {
            "winner_pipeline_id": pipeline_id,
            "run_label": run_label,
            "subject_class": subject_class,
            "query_kind": query_kind,
        }
        for pipeline_id, run_label, subject_class, query_kind in (
            db.query(
                BattleRun.winner_pipeline_id,
                BattleRun.run_label,
                BattleRun.subject_class,
                BattleRun.query_kind,
            )
            .order_by(BattleRun.id.asc())
            .all()
        )
    ]

    return battle_stats(runs)


# ============================================================
# SIMILAR PAPERS GRAPH
# ============================================================

@app.get("/api/catalog")
def get_catalog(
    db: Session = Depends(get_session),
):
    """
    The repository taxonomy — subjects, categories and document
    types — as seed defaults merged with every value actually
    stored in the papers table. Adding a reference with a new
    subject or category automatically extends the catalog.

    `subject_categories` maps each subject to the categories that
    actually co-occur with it in the imported references, so the
    Upload form can auto-suggest categories matching the chosen
    subject. Subjects with no stored rows fall back to the seed
    category list.
    """

    rows = (
        db.query(Paper.subject_category, Paper.document_type)
        .all()
    )

    stored_subjects: list[str] = []
    stored_categories: list[str] = []
    stored_document_types: list[str] = []
    subject_categories: dict[str, list[str]] = {}

    for subject_category, document_type in rows:
        parts = (subject_category or "").split(":", 2)

        subject = parts[0].strip()
        if subject:
            stored_subjects.append(subject)

        if len(parts) > 1:
            category = parts[1].strip()
            if category:
                stored_categories.append(category)
                # Record the subject -> category co-occurrence seen
                # in the imported reference set.
                subject_categories.setdefault(subject, [])
                if category not in subject_categories[subject]:
                    subject_categories[subject].append(category)

        if document_type and document_type.strip():
            stored_document_types.append(document_type.strip())

    # Every known subject gets a suggestion list: stored
    # co-occurrences first, seed defaults as the fallback for
    # subjects the reference set hasn't classified yet.
    for subject in merge_defaults(
        DEFAULT_SUBJECTS,
        stored_subjects,
    ):
        subject_categories.setdefault(subject, list(DEFAULT_CATEGORIES))

    return {
        "subjects": merge_defaults(
            DEFAULT_SUBJECTS,
            stored_subjects,
        ),
        "categories": merge_defaults(
            DEFAULT_CATEGORIES,
            stored_categories,
        ),
        "document_types": merge_defaults(
            DEFAULT_DOCUMENT_TYPES,
            stored_document_types,
        ),
        "subject_categories": subject_categories,
    }


@app.get("/api/papers/{paper_id}/similar-graph")
def get_similar_papers_graph(
    paper_id: int,
    pipeline: str = "tfidf_sbert_metadata",
    top_k: int = 10,
    w_tfidf: float | None = None,
    w_sbert: float | None = None,
    w_metadata: float | None = None,
    db: Session = Depends(get_session),
):
    # --------------------------------------------------------
    # Validate pipeline
    # --------------------------------------------------------

    if pipeline not in ALL_PIPELINE_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported recommendation pipeline: {pipeline}. "
                f"Supported pipelines: "
                f"{', '.join(sorted(IMPLEMENTED_PIPELINES))}, custom"
            ),
        )

    custom_weights = _resolve_custom_weights(
        pipeline,
        w_tfidf,
        w_sbert,
        w_metadata,
    )

    # --------------------------------------------------------
    # Validate top_k
    # --------------------------------------------------------

    if top_k <= 0 or top_k > MAX_RECOMMENDATION_TOP_K:
        raise HTTPException(
            status_code=400,
            detail=(
                "top_k must be between 1 and "
                f"{MAX_RECOMMENDATION_TOP_K}."
            ),
        )

    # --------------------------------------------------------
    # Get selected paper
    # --------------------------------------------------------

    seed_paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not seed_paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    # --------------------------------------------------------
    # Make sure the seed can be used by the recommendation
    # system
    # --------------------------------------------------------

    if not seed_paper.is_valid_for_recommendation:
        raise HTTPException(
            status_code=400,
            detail=(
                "This paper is not valid for recommendation. "
                "Rebuild the recommendation index first."
            ),
        )

    if not seed_paper.prepared_text:
        raise HTTPException(
            status_code=400,
            detail=(
                "This paper has no prepared text and cannot "
                "be used for similarity search."
            ),
        )

    # --------------------------------------------------------
    # Run the EXISTING recommendation system
    # --------------------------------------------------------

    try:
        results = run_search(
            db=db,
            seed_paper_id=paper_id,
            pipeline=pipeline,
            top_k=top_k,
            custom_weights=custom_weights,
        )

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        print()
        print("SIMILAR PAPERS GRAPH FAILED")
        print(error)

        raise HTTPException(
            status_code=500,
            detail="Unable to generate similar papers graph.",
        ) from error

    # --------------------------------------------------------
    # Build the weighted graph (connectedpapers-js model):
    # origin star + pairwise edges, weighted shortest paths,
    # shared author/topic groups.
    # --------------------------------------------------------

    graph = build_connected_graph(
        seed=seed_paper,
        papers=[seed_paper] + [result["paper"] for result in results],
        pipeline=pipeline,
        weights=custom_weights,
    )

    # --------------------------------------------------------
    # Center node = selected paper
    # --------------------------------------------------------

    nodes = [
        {
            "id": seed_paper.id,
            "title": seed_paper.title,
            "author": seed_paper.author,
            "publication_year": seed_paper.publication_year,
            "abstract": seed_paper.abstract,
            "doi": seed_paper.doi,
            "citation_count": seed_paper.citation_count,
            "similarity": 1.0,
            "relationship": "current",
            "path": [seed_paper.id],
            "path_length": 0.0,
        }
    ]

    # --------------------------------------------------------
    # Similar-paper nodes (path = shortest weighted route back
    # to the origin, straight from the graph builder)
    # --------------------------------------------------------

    for result in results:
        paper = result["paper"]

        nodes.append(
            {
                "id": paper.id,
                "title": paper.title,
                "author": paper.author,
                "publication_year": paper.publication_year,
                "abstract": paper.abstract,
                "doi": paper.doi,
                "citation_count": paper.citation_count,
                "similarity": result["score"],
                "relationship": "similar",
                "path": graph["node_paths"].get(paper.id, []),
                "path_length": graph["path_lengths"].get(paper.id, 0.0),
            }
        )

    # --------------------------------------------------------
    # Return graph data
    # --------------------------------------------------------

    # Prior / derivative works: the external works the graph set
    # cites most (seminal references) and the works citing the most
    # graph papers (surveys / follow-ups). Clustered from the cached
    # OpenAlex neighborhood; empty when nothing overlaps yet.
    prior_works, derivative_works = clustered_works(
        db,
        [node["id"] for node in nodes],
    )

    # The local citation store keeps bare OpenAlex ids for unmatched
    # works; resolve real titles best-effort (cached) so the lists
    # read like the web scope. Offline -> the ids/DOIs stay.
    external_ids = [
        work["work_id"]
        for work in [*prior_works, *derivative_works]
        if not work.get("is_local")
    ]

    try:
        titles = resolve_work_titles(external_ids)
    except Exception:
        titles = {}

    for work in [*prior_works, *derivative_works]:
        title = titles.get(work["work_id"])

        if title:
            work["label"] = title
            work["title"] = title

    return {
        "paper_id": paper_id,
        "pipeline": pipeline,
        "start_id": graph["start_id"],
        "nodes": nodes,
        "edges": graph["edges"],
        # JSON object keys are strings -- keep the map honest instead
        # of letting Python ints silently stringify on the wire.
        "path_lengths": {
            str(node_id): distance
            for node_id, distance in graph["path_lengths"].items()
        },
        "common_authors": graph["common_authors"],
        "common_topics": graph["common_topics"],
        "common_references": graph["common_references"],
        "common_citers": graph["common_citers"],
        "prior_works": prior_works,
        "derivative_works": derivative_works,
    }


@app.get("/api/papers/{paper_id}/web-connections")
def paper_web_connections(
    paper_id: int,
    db: Session = Depends(get_session),
):
    """WEB scope of the similar-papers pane: OpenAlex neighborhood.

    Prior works = the paper's references (heavily-cited first);
    derivative works = the works citing it. Live OpenAlex lookups,
    no caching -- the endpoint reports a friendly reason when the
    paper has no DOI or OpenAlex is unreachable.
    """
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    result = fetch_web_neighborhood(paper)

    if not result.get("ok"):
        reason = result.get("reason")

        if reason == "no_doi":
            raise HTTPException(
                status_code=400,
                detail=(
                    "This paper has no DOI, so OpenAlex cannot "
                    "resolve its web connections."
                ),
            )

        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAlex could not be reached for this paper. "
                "Try again in a moment."
            ),
        )

    result["paper_id"] = paper.id

    return result


@app.get("/api/web/connections")
def web_result_connections(
    doi: str | None = Query(default=None, max_length=300),
    title: str | None = Query(default=None, max_length=400),
    work_id: str | None = Query(default=None, max_length=32),
    sources: str | None = Query(
        default=None,
        max_length=120,
        description=(
            "Comma-separated providers to union in. Defaults to "
            "semantic_scholar,crossref alongside OpenAlex; unknown names "
            "are ignored rather than rejected."
        ),
    ),
):
    """Related works for a web result that is not in the library.

    The same citation neighborhood a saved paper gets, resolved by DOI,
    else provider work id, else a title match. OpenAlex leads (it is the
    only source that returns each neighbor's own reference list, which
    the edge structure is built from); Semantic Scholar and Crossref are
    unioned in so a work one graph has never cited still shows its
    neighbors from the other.

    Replies 200 with empty lists and `resolved: false` when nothing
    could be matched, so the client can show an empty state rather than
    an error. A failing extra source is not an error -- it simply
    contributes nothing.
    """
    if sources is None:
        wanted = tuple(EXTRA_SOURCES)
    else:
        wanted = tuple(
            name.strip()
            for name in sources.split(",")
            if name.strip() in EXTRA_SOURCES
        )

    result = fetch_neighborhood(
        doi=doi,
        title=title,
        work_id=work_id,
        sources=wanted,
    )

    if result.get("ok"):
        result["resolved"] = True
        return result

    if result.get("reason") == "no_doi" or (
        result.get("reason") == "lookup_failed"
        and not result.get("detail")
    ):
        return {
            "ok": True,
            "resolved": False,
            "doi": None,
            "work_id": None,
            "prior_works": [],
            "derivative_works": [],
            "edges": [],
            "sources": ["openalex", *wanted],
            "source_counts": {},
        }

    raise HTTPException(
        status_code=502,
        detail=(
            "OpenAlex could not be reached for this result. "
            "Try again in a moment."
        ),
    )


class GatherLiteratureRequest(BaseModel):
    limit: int = 300
    rebuild_index: bool = True


# One gather at a time: it writes many papers and rebuilds the index.
# Progress lives in memory so the Arena can draw a live meter; a
# restart simply forgets a finished job.
_GATHER_LOCK = threading.Lock()
_GATHER_JOB: dict = {"state": "idle"}


def _gather_snapshot() -> dict:
    with _GATHER_LOCK:
        return {**_GATHER_JOB, "recent": list(_GATHER_JOB.get("recent", []))}


def _gather_update(**fields) -> None:
    with _GATHER_LOCK:
        _GATHER_JOB.update(fields)


def _run_gather_job(limit: int, rebuild_index: bool) -> None:
    """Worker thread: gather, then (optionally) rebuild the index."""

    session = SessionLocal()
    recent: list[str] = []

    def on_progress(summary, batches_done, batches_total, title):
        if title:
            recent.append(title)
            del recent[:-5]

        _gather_update(
            phase="fetching",
            batches_done=batches_done,
            batches_total=batches_total,
            recent=list(recent),
            **{
                key: summary[key]
                for key in (
                    "unresolved_references",
                    "considered",
                    "added",
                    "already_in_library",
                    "skipped_no_abstract",
                    "failed_batches",
                    "rows_linked",
                )
            },
        )

    def on_expand(summary, batches_done, batches_total):
        _gather_update(
            phase="references",
            ref_batches_done=batches_done,
            ref_batches_total=batches_total,
            papers_expanded=summary["papers_expanded"],
            papers_considered=summary["papers_considered"],
            ref_rows_added=summary["rows_added"],
        )

    try:
        with IMPORT_LOCK:
            # 1. Give papers that have no cached references theirs, so
            #    they can be queries (a gather leaves most of the library
            #    as cited-but-never-looked-up works).
            expanded = expand_references(session, on_progress=on_expand)

            # 2. Link every cached reference to the papers it names.
            _gather_update(phase="linking")
            link_reference_rows(session)

            # 3. Import the most-cited references still unresolved.
            _gather_update(phase="fetching")
            summary = gather_cited_works(
                session, limit=limit, on_progress=on_progress
            )

        summary["references"] = expanded

        summary["index_rebuilt"] = False

        if summary["added"] > 0:
            set_recommendation_index_stale(True)

            if rebuild_index:
                _gather_update(phase="indexing")

                try:
                    rebuild_recommendation_data()
                    set_recommendation_index_stale(False)
                    summary["index_rebuilt"] = True
                except Exception as error:
                    print("RECOMMENDATION REBUILD FAILED AFTER GATHER")
                    print(error)

        _gather_update(
            state="done",
            phase="done",
            summary=summary,
            finished_at=time.time(),
        )

    except Exception as error:
        print("LITERATURE GATHER FAILED")
        print(error)
        _gather_update(
            state="error",
            error=str(error),
            finished_at=time.time(),
        )

    finally:
        session.close()


@app.post("/api/citations/gather-literature")
def gather_literature(request: GatherLiteratureRequest):
    """
    Start gathering the library's most-cited unresolved references as
    papers (from OpenAlex) so leave-one-out tournaments have resolved
    ground truth, then rebuild the recommendation index so the new
    papers can be retrieved. Runs in the background; poll
    ``GET /api/citations/gather-literature/status``.
    """

    if not 1 <= request.limit <= 1000:
        raise HTTPException(
            status_code=400,
            detail="limit must be between 1 and 1000.",
        )

    with _GATHER_LOCK:
        if _GATHER_JOB.get("state") == "running":
            raise HTTPException(
                status_code=409,
                detail="A literature gather is already running.",
            )

        _GATHER_JOB.clear()
        _GATHER_JOB.update(
            state="running",
            phase="references",
            limit=request.limit,
            batches_done=0,
            batches_total=0,
            added=0,
            rows_linked=0,
            skipped_no_abstract=0,
            already_in_library=0,
            recent=[],
            started_at=time.time(),
        )

    threading.Thread(
        target=_run_gather_job,
        args=(request.limit, request.rebuild_index),
        daemon=True,
    ).start()

    return _gather_snapshot()


@app.get("/api/citations/gather-literature/status")
def gather_literature_status():
    snapshot = _gather_snapshot()

    if snapshot.get("started_at"):
        end = snapshot.get("finished_at") or time.time()
        snapshot["elapsed"] = round(end - snapshot["started_at"], 1)

    return snapshot


# ------------------------------------------------------------
# SYNC (refresh metadata from Crossref, then rebuild the index)
#
# The Repository's Sync button used to only rebuild the recommendation
# index, so records never changed. It now first refreshes each paper's
# metadata (see app/services/metadata_sync.py) and then rebuilds the
# index so the refreshed text is what gets scored. One run at a time;
# progress is polled from the status route.
# ------------------------------------------------------------

class SyncRequest(BaseModel):
    force: bool = False
    rebuild_index: bool = True


_SYNC_LOCK = threading.Lock()
_SYNC_JOB: dict = {"state": "idle"}


def _sync_update(**fields) -> None:
    with _SYNC_LOCK:
        _SYNC_JOB.update(fields)


def _run_sync_job(force: bool, rebuild_index: bool) -> None:
    session = SessionLocal()

    def on_progress(summary, done, total):
        _sync_update(
            phase="metadata",
            done=done,
            total=total,
            considered=summary["considered"],
            changed=summary["changed"],
            not_found=summary["not_found"],
            failed=summary["failed"],
            fields=summary["fields"],
        )

    try:
        with IMPORT_LOCK:
            summary = sync_metadata(
                session, force=force, on_progress=on_progress
            )

        summary["index_rebuilt"] = False

        # Even with nothing to change, the index may already be stale
        # (edits made earlier), so Sync still honours its old job.
        if rebuild_index:
            _sync_update(phase="indexing")

            try:
                rebuild_recommendation_data()
                set_recommendation_index_stale(False)
                summary["index_rebuilt"] = True
            except Exception as error:
                print("RECOMMENDATION REBUILD FAILED AFTER SYNC")
                print(error)
        elif summary["changed"]:
            set_recommendation_index_stale(True)

        _sync_update(
            state="done",
            phase="done",
            summary=summary,
            finished_at=time.time(),
        )

    except Exception as error:
        print("METADATA SYNC FAILED")
        print(error)
        _sync_update(
            state="error", error=str(error), finished_at=time.time()
        )

    finally:
        session.close()


@app.post("/api/papers/sync")
def start_sync(request: SyncRequest | None = None):
    request = request or SyncRequest()

    with _SYNC_LOCK:
        if _SYNC_JOB.get("state") == "running":
            raise HTTPException(
                status_code=409,
                detail="A sync is already running.",
            )

        _SYNC_JOB.clear()
        _SYNC_JOB.update(
            state="running",
            phase="metadata",
            done=0,
            total=0,
            changed=0,
            started_at=time.time(),
        )

    threading.Thread(
        target=_run_sync_job,
        args=(request.force, request.rebuild_index),
        daemon=True,
    ).start()

    with _SYNC_LOCK:
        return dict(_SYNC_JOB)


@app.get("/api/papers/sync/status")
def sync_status():
    with _SYNC_LOCK:
        snapshot = dict(_SYNC_JOB)

    if snapshot.get("started_at"):
        end = snapshot.get("finished_at") or time.time()
        snapshot["elapsed"] = round(end - snapshot["started_at"], 1)

    return snapshot


@app.post("/api/citations/link-references")
def link_citation_references(db: Session = Depends(get_session)):
    """Match cached references/citers to local papers by OpenAlex id,
    so leave-one-out tournaments have resolved ground truth."""

    return link_reference_rows(db)


@app.post("/api/papers/{paper_id}/citations/refresh")
def refresh_paper_citations_endpoint(
    paper_id: int,
    db: Session = Depends(get_session),
):
    paper = (
        db.query(Paper)
        .filter(Paper.id == paper_id)
        .first()
    )

    if not paper:
        raise HTTPException(
            status_code=404,
            detail="Paper not found.",
        )

    return refresh_paper_citations(db, paper)


# ============================================================
# RESEARCH ASSISTANT
# ============================================================

@app.post(
    "/api/research-chat",
    response_model=ResearchChatResponse,
)
def research_chat(
    request: ResearchChatRequest,
    db: Session = Depends(get_session),
):
    try:
        return answer_research_question(
            db=db,
            request=request,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error
    except Exception as error:
        print("RESEARCH CHAT FAILED")
        print(error)
        raise HTTPException(
            status_code=500,
            detail="Research chat failed.",
        ) from error


@app.post(
    "/api/research-chat/suggestions",
    response_model=SuggestionResponse,
)
def research_chat_suggestions(request: SuggestionRequest):
    """Follow-up questions for the chat's suggestion pills."""

    return suggest_followups(request)


# ============================================================
# LIBRARY MODE & SITE EDITOR
# ============================================================


def _seed_library_site() -> None:
    """Create the admin account + persist feature defaults (idempotent)."""
    db = SessionLocal()

    try:
        ensure_admin_user(db)
        # Writes the defaults on first boot; afterwards it only
        # rewrites the same values, so a missing row can never leave
        # the public endpoint without a full feature map.
        set_library_features(db, {})
    except Exception:
        logging.getLogger(__name__).exception(
            "Could not seed the library site editor state"
        )
    finally:
        db.close()


def require_admin(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_session),
) -> User:
    """Bearer-token gate for the site-editor endpoints."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Admin sign-in required.",
        )

    token = authorization.split(" ", 1)[1].strip()
    user = verify_admin_token(db, token)

    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Admin session expired or invalid.",
        )

    return user


def _announcement_or_404(
    db: Session,
    announcement_id: int,
) -> Announcement:
    row = (
        db.query(Announcement)
        .filter(Announcement.id == announcement_id)
        .first()
    )

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Announcement not found.",
        )

    return row


@app.get(
    "/api/site/library-features",
    response_model=LibraryFeaturesOut,
)
def public_library_features(db: Session = Depends(get_session)):
    """Feature states for Library Mode (public: the nav needs it)."""
    return LibraryFeaturesOut(features=get_library_features(db))


@app.get(
    "/api/library/announcements",
    response_model=list[AnnouncementOut],
)
def public_announcements(db: Session = Depends(get_session)):
    """Active announcements, in admin-defined order."""
    return (
        db.query(Announcement)
        .filter(Announcement.active.is_(True))
        .order_by(
            Announcement.position.asc(),
            Announcement.id.asc(),
        )
        .all()
    )


@app.post("/api/admin/login", response_model=AdminTokenOut)
def admin_login(
    payload: AdminLoginIn,
    db: Session = Depends(get_session),
):
    user = (
        db.query(User)
        .filter(
            User.username == payload.username.strip(),
            User.is_admin.is_(True),
        )
        .first()
    )

    if user is None or not verify_password(
        payload.password,
        user.password_hash,
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid admin credentials.",
        )

    token, expires_at = create_admin_token(db, user.id)

    return AdminTokenOut(
        token=token,
        username=user.username,
        expires_at=expires_at,
    )


@app.get("/api/admin/me", response_model=AdminMeOut)
def admin_me(admin: User = Depends(require_admin)):
    return AdminMeOut(username=admin.username)


@app.post("/api/admin/password")
def admin_change_password(
    payload: AdminPasswordChange,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    if not verify_password(payload.current_password, admin.password_hash):
        raise HTTPException(
            status_code=400,
            detail="Current password is incorrect.",
        )

    admin.password_hash = hash_password(payload.new_password)
    db.commit()

    return {"ok": True}


@app.get(
    "/api/admin/announcements",
    response_model=list[AnnouncementOut],
)
def admin_list_announcements(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    return (
        db.query(Announcement)
        .order_by(
            Announcement.position.asc(),
            Announcement.id.asc(),
        )
        .all()
    )


@app.post(
    "/api/admin/announcements",
    response_model=AnnouncementOut,
    status_code=201,
)
def admin_create_announcement(
    payload: AnnouncementIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    last_position = db.query(func.max(Announcement.position)).scalar()

    row = Announcement(
        title=payload.title.strip(),
        body=payload.body.strip(),
        level=payload.level,
        active=payload.active,
        position=0 if last_position is None else last_position + 1,
    )

    db.add(row)
    db.commit()
    db.refresh(row)

    return row


@app.put(
    "/api/admin/announcements/{announcement_id}",
    response_model=AnnouncementOut,
)
def admin_update_announcement(
    announcement_id: int,
    payload: AnnouncementUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    row = _announcement_or_404(db, announcement_id)
    data = payload.model_dump(exclude_unset=True)

    if "title" in data:
        row.title = data["title"].strip()

    if "body" in data:
        row.body = data["body"].strip()

    if "level" in data:
        row.level = data["level"]

    if "active" in data:
        row.active = data["active"]

    if "position" in data:
        row.position = data["position"]

    db.commit()
    db.refresh(row)

    return row


@app.delete("/api/admin/announcements/{announcement_id}")
def admin_delete_announcement(
    announcement_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    row = _announcement_or_404(db, announcement_id)
    db.delete(row)
    db.commit()

    return {"ok": True, "deleted": announcement_id}


@app.get(
    "/api/admin/library-features",
    response_model=LibraryFeaturesOut,
)
def admin_get_library_features(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    return LibraryFeaturesOut(features=get_library_features(db))


@app.put(
    "/api/admin/library-features",
    response_model=LibraryFeaturesOut,
)
def admin_set_library_features(
    payload: LibraryFeaturesIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    try:
        features = set_library_features(db, payload.features)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    return LibraryFeaturesOut(features=features)


# ============================================================
# LITERATURE ACTIONS (multi-select context menu)
# ============================================================


def _load_selected_papers(
    db: Session,
    paper_ids: list[int],
) -> list[Paper]:
    """Fetch the selected papers in the order requested, deduped."""
    wanted = list(dict.fromkeys(paper_ids))

    papers = (
        db.query(Paper)
        .filter(Paper.id.in_(wanted))
        .all()
    )

    by_id = {paper.id: paper for paper in papers}
    ordered = [by_id[paper_id] for paper_id in wanted if paper_id in by_id]

    if not ordered:
        raise HTTPException(
            status_code=404,
            detail="None of the selected papers exist.",
        )

    return ordered


def _sanitize_file_base(value: str, fallback: str) -> str:
    """Lowercase slug for a document filename (no extension)."""
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")

    return (slug[:80].rstrip("-")) or fallback


def _rename_base(
    paper: Paper,
    pattern: str,
    custom_name: str | None,
) -> str:
    fallback = f"paper-{paper.id}"

    if pattern == "custom":
        return _sanitize_file_base(
            (custom_name or "").strip() or (paper.title or ""),
            fallback,
        )

    if pattern == "author-year":
        parts = [
            paper.author or "",
            str(paper.publication_year or ""),
        ]
        return _sanitize_file_base(" ".join(parts), fallback)

    if pattern == "author-year-title":
        parts = [
            paper.author or "",
            str(paper.publication_year or ""),
            paper.title or "",
        ]
        return _sanitize_file_base(" ".join(parts), fallback)

    return _sanitize_file_base(paper.title or "", fallback)


def _reveal_in_file_manager(path: str) -> bool:
    """Open the OS file manager with the given file selected.

    Runs on the machine hosting the backend -- which is the user's
    own machine for this local-first app. Returns False when the
    platform call fails; never raises.
    """
    import platform

    try:
        system = platform.system()

        if system == "Darwin":
            subprocess.Popen(["open", "-R", path])
        elif system == "Windows":
            subprocess.Popen(["explorer", "/select,", path])
        else:
            subprocess.Popen(["xdg-open", str(Path(path).parent)])

        return True
    except Exception:
        logging.getLogger(__name__).exception(
            "Could not reveal %s in the file manager", path
        )
        return False


@app.post("/api/papers/refresh-metadata")
def refresh_papers_metadata(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Re-run background metadata enrichment for the selected papers.

    Same enrichment pipeline imports use (PDF discovery + field
    filling + keywords); the frontend polls /enrichment-status and
    refreshes the rows once each job reports done.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    for paper in papers:
        enqueue_paper_enrichment(paper.id)

    return {"ok": True, "queued": [paper.id for paper in papers]}


@app.post("/api/papers/reveal")
def reveal_papers(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Open the containing folder of the first selected paper with
    a stored file (Finder / Explorer / xdg-open)."""
    papers = _load_selected_papers(db, payload.paper_ids)

    for paper in papers:
        if not paper.stored_path:
            continue

        path = get_paper_file_path(paper.stored_path)

        if not os.path.exists(path):
            continue

        launched = _reveal_in_file_manager(path)

        if not launched:
            raise HTTPException(
                status_code=500,
                detail="The file manager could not be opened.",
            )

        return {
            "ok": True,
            "paper_id": paper.id,
            "path": path,
        }

    raise HTTPException(
        status_code=404,
        detail="None of the selected papers has a stored file.",
    )


@app.post("/api/papers/rename-files")
def rename_paper_files(
    payload: RenameFilesIn,
    db: Session = Depends(get_session),
):
    """Rename the stored document files of the selected papers.

    Patterns: title | author-year | author-year-title | custom.
    Files stay in storage/papers/; collisions get a -2, -3 suffix.
    Papers without a stored file are reported under `skipped`.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    renamed: list[dict] = []
    skipped: list[dict] = []

    for paper in papers:
        if not paper.stored_path:
            skipped.append({"id": paper.id, "reason": "no_file"})
            continue

        current = Path(get_paper_file_path(paper.stored_path))

        if not current.exists():
            skipped.append({"id": paper.id, "reason": "file_missing"})
            continue

        base = _rename_base(paper, payload.pattern, payload.custom_name)
        suffix = current.suffix.lower()
        target = current.parent / f"{base}{suffix}"

        if target.name == current.name:
            skipped.append({"id": paper.id, "reason": "already_named"})
            continue

        counter = 2

        while target.exists():
            target = current.parent / f"{base}-{counter}{suffix}"
            counter += 1

        try:
            current.rename(target)
        except OSError:
            skipped.append({"id": paper.id, "reason": "rename_failed"})
            continue

        paper.stored_path = str(Path("papers") / target.name)

        renamed.append(
            {"id": paper.id, "stored_path": paper.stored_path}
        )

    db.commit()

    return {"ok": True, "renamed": renamed, "skipped": skipped}


@app.post("/api/papers/mark")
def mark_papers(
    payload: MarkPapersIn,
    db: Session = Depends(get_session),
):
    """Bulk set recommendation validity on the selected papers."""
    papers = _load_selected_papers(db, payload.paper_ids)

    changed = 0

    for paper in papers:
        if bool(paper.is_valid_for_recommendation) != payload.valid:
            paper.is_valid_for_recommendation = payload.valid
            changed += 1

    db.commit()

    if changed:
        # Validity gates the recommendation index.
        set_recommendation_index_stale(True)

    return {"ok": True, "updated": changed, "valid": payload.valid}


@app.post("/api/papers/merge")
def merge_selected_papers(
    payload: PaperIdsIn,
    db: Session = Depends(get_session),
):
    """Merge the selected records into one master.

    Reuses the duplicate-merge engine: the master keeps the best
    metadata, library rows and citation rows are repointed, and the
    other rows are deleted.
    """
    papers = _load_selected_papers(db, payload.paper_ids)

    if len(papers) < 2:
        raise HTTPException(
            status_code=400,
            detail="Select at least two papers to merge.",
        )

    try:
        summary = merge_group(db, papers)
        db.commit()
    except ValueError as error:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error
    except Exception as error:
        db.rollback()
        print("MERGE FAILED")
        print(error)
        raise HTTPException(
            status_code=500,
            detail="The merge failed; nothing was changed.",
        ) from error

    set_recommendation_index_stale(True)

    return {"ok": True, **summary}

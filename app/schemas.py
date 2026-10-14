"""
Pydantic schemas -- the shapes of data going in and out of the API.
Kept separate from models.py (the database shapes) so the two can
diverge if needed (e.g. hiding password_hash from API responses).
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AuthorPart(BaseModel):
    """One author as the parts a citation style needs."""

    given: str = ""
    middle: str = ""
    family: str = ""
    suffix: str = ""

    class Config:
        from_attributes = True


class PaperOut(BaseModel):
    id: int
    title: str
    author: str | None = None
    # The same people as ``author``, split into given / middle / family
    # (+ suffix) in author order -- what citation styles are built from.
    authors: list[AuthorPart] = []
    abstract: str | None = None
    keywords: str | None = None
    publication_year: int | None = None
    doi: str | None = None
    subject_category: str | None = None
    document_type: str | None = None
    citation_count: int | None = None
    is_valid_for_recommendation: bool
    missing_fields: str | None = None
    enrichment_notes: str | None = None   
    source_filename: str | None = None
    extraction_method: str | None = None
    stored_path: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True  # lets this build directly from a SQLAlchemy Paper


class PaperUpdate(BaseModel):
    """Fields a user can fill in manually -- e.g. completing missing ones
    after an incomplete auto-extraction, or adding the ones extraction
    never touches (author, doi, subject_category, document_type,
    citation_count)."""

    title: str | None = None
    author: str | None = None
    # Structured edit; takes precedence over ``author`` when both are sent.
    authors: list[AuthorPart] | None = None
    abstract: str | None = None
    keywords: str | None = None
    publication_year: int | None = None
    doi: str | None = None
    subject_category: str | None = None
    document_type: str | None = None
    citation_count: int | None = None


class RepositoryStats(BaseModel):
    total_papers: int
    by_subject: dict[str, int]
    category_count: int


class LibraryEntryOut(BaseModel):
    paper: PaperOut
    saved_at: datetime


class SearchResultOut(BaseModel):
    """One ranked result from /api/recommendations."""

    paper: PaperOut
    score: float


class PdfCandidateOut(BaseModel):
    """One candidate PDF returned by GET /api/papers/{id}/find-pdf.

    Nothing has been downloaded yet at this point -- these are just
    search results (title, source, confidence, links) for the user to
    review and confirm before anything is attached.
    """

    url: str
    source: str  # "unpaywall" | "semantic_scholar" | "arxiv"
    title: str | None = None
    confidence: float
    landing_page_url: str | None = None
    license: str | None = None


class AttachPdfRequest(BaseModel):
    """Body for POST /api/papers/{id}/attach-pdf -- the URL the user
    confirmed from a PdfCandidateOut."""

    url: str


class IdentifierLookupRequest(BaseModel):
    """Body for POST /api/papers/preview-identifier -- a pasted DOI,
    arXiv id, or a link to either."""

    identifier: str


class MetadataImportRequest(BaseModel):
    """Body for POST /api/papers/import-metadata -- create a paper
    directly from reviewed metadata, with no source file (the save
    step of the "Add by identifier" flow)."""

    title: str
    author: str | None = None
    abstract: str | None = None
    keywords: str | None = None
    publication_year: int | None = None
    doi: str | None = None
    subject_category: str | None = None
    document_type: str | None = None
    citation_count: int | None = None
    source_filename: str | None = None
    # Optional explicit open-access PDF to attach at import time;
    # when omitted, the background enrichment queue searches for one.
    pdf_url: str | None = None


# ============================================================
# LIBRARY MODE & SITE EDITOR
# ============================================================


AnnouncementLevel = Literal["info", "important", "event"]
FeatureState = Literal["shown", "locked", "hidden"]


class AdminLoginIn(BaseModel):
    username: str
    password: str


class AdminTokenOut(BaseModel):
    token: str
    username: str
    expires_at: int  # unix seconds


class AdminMeOut(BaseModel):
    username: str


class AdminPasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1)
    level: AnnouncementLevel = "info"
    active: bool = True


class AnnouncementUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    body: str | None = Field(default=None, min_length=1)
    level: AnnouncementLevel | None = None
    active: bool | None = None
    position: int | None = Field(default=None, ge=0)


class AnnouncementOut(BaseModel):
    id: int
    title: str
    body: str
    level: str
    active: bool
    position: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LibraryFeaturesOut(BaseModel):
    features: dict[str, FeatureState]


class LibraryFeaturesIn(BaseModel):
    features: dict[str, FeatureState]


# ============================================================
# LITERATURE ACTIONS (multi-select context menu)
# ============================================================


class PaperIdsIn(BaseModel):
    paper_ids: list[int] = Field(min_length=1)


class RenameFilesIn(PaperIdsIn):
    pattern: Literal[
        "title",
        "author-year",
        "author-year-title",
        "custom",
    ] = "title"
    custom_name: str | None = None


class MarkPapersIn(PaperIdsIn):
    valid: bool

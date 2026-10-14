"""
File storage for uploaded academic paper source files
(PDF, BibTeX, or LaTeX).

Physical files are stored in:

    project_root/storage/papers/

Each file is named using its database paper ID, keeping its original
extension:

    storage/papers/3.pdf
    storage/papers/4.bib
    storage/papers/5.tex

The database stores only the relative path:

    papers/3.pdf

Research exports are written next to them:

    project_root/storage/exports/

    storage/exports/battle_runs-20261009-142501.jsonl

That directory holds data the study cannot regenerate -- the Arena's
recorded runs, each carrying the consensus and pairwise structure as
it was computed on the day -- so it is never cleared programmatically.
Archiving the Arena writes a new file there and leaves every earlier
one alone.
"""

from pathlib import Path
import shutil


# storage.py location:
# project_root/app/services/storage.py
#
# .parent                  -> app/services
# .parent.parent           -> app
# .parent.parent.parent    -> project root
BASE_DIR = Path(__file__).resolve().parent.parent.parent

# Correct root storage directory
STORAGE_ROOT = BASE_DIR / "storage"

# Correct papers directory
PAPERS_DIR = STORAGE_ROOT / "papers"

# Research exports (battle archives, dataset bundles). Created on
# demand rather than at startup, for the same reason storage/papers/
# is: an empty directory in git is not evidence of anything.
EXPORTS_DIR = STORAGE_ROOT / "exports"

ALLOWED_EXTENSIONS = {".pdf", ".bib", ".tex", ".ris", ".enw"}


def ensure_storage_ready() -> None:
    """
    Create storage/papers/ if it does not exist.
    """
    PAPERS_DIR.mkdir(parents=True, exist_ok=True)


def exports_dir() -> Path:
    """
    Create storage/exports/ if it does not exist and return it.

    A function rather than a constant because it is called from the
    archiving route, which must never fail on a fresh checkout: the
    archive is the step that saves the history, so a missing directory
    is created at the moment it is needed instead of at startup.
    """

    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

    return EXPORTS_DIR


def save_paper_file(paper_id: int, source_path: str) -> str:
    """
    Copy an uploaded PDF, BibTeX, RIS, EndNote or LaTeX file into:

        project_root/storage/papers/{paper_id}{original extension}

    Returns the relative path saved in the database:

        papers/{paper_id}{original extension}
    """

    ensure_storage_ready()

    source = Path(source_path).resolve()

    if not source.exists():
        raise FileNotFoundError(
            f"Source file does not exist: {source}"
        )

    if not source.is_file():
        raise ValueError(
            f"Source path is not a file: {source}"
        )

    extension = source.suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError(
            "Only PDF, BibTeX (.bib), RIS (.ris), EndNote (.enw), "
            "and LaTeX (.tex) files are allowed."
        )

    destination = PAPERS_DIR / f"{paper_id}{extension}"

    print(f"Source file:      {source}")
    print(f"Destination file: {destination}")

    shutil.copy2(source, destination)

    if not destination.exists():
        raise IOError(
            f"File was not copied successfully: {destination}"
        )

    print(f"File saved successfully: {destination}")

    # This is the path stored in Paper.stored_path.
    # It is relative to the root storage directory.
    return str(Path("papers") / destination.name)


def get_paper_file_path(stored_path: str) -> str:
    """
    Convert a database path such as:

        papers/3.pdf

    into the full path:

        project_root/storage/papers/3.pdf
    """

    return str(STORAGE_ROOT / stored_path)


def delete_paper_file(stored_path: str) -> None:
    """
    Delete a stored PDF if it exists.
    """

    full_path = Path(get_paper_file_path(stored_path))

    if full_path.exists():
        full_path.unlink()
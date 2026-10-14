"""Folders for the personal library (the Zotero / Mendeley way).

Rules, all enforced here so the API and the tests share one source:

    - a folder belongs to one user and may sit inside another of theirs
      (up to ``MAX_DEPTH`` levels);
    - sibling names are unique ignoring case and surrounding spaces;
    - a folder can never be moved into itself or one of its own subfolders;
    - a paper can be in many folders, but only a paper that is saved in the
      user's library can be placed in one;
    - deleting a folder deletes its subfolders and their placements, never
      the papers; removing a paper from the library clears its placements.
"""

from __future__ import annotations

from typing import Iterable

from sqlalchemy.orm import Session

from app.models.models import (
    LibraryFolder,
    LibraryFolderPaper,
    PersonalLibrary,
)

MAX_DEPTH = 6
MAX_NAME_LENGTH = 80
MAX_PAPERS_PER_CALL = 500


class FolderError(Exception):
    """A rule was broken. ``status`` is the HTTP status the API uses."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_name(raw: str | None) -> str:
    name = " ".join((raw or "").split())

    if not name:
        raise FolderError(400, "Give the folder a name.")

    if len(name) > MAX_NAME_LENGTH:
        raise FolderError(
            400, f"Folder names can be at most {MAX_NAME_LENGTH} characters."
        )

    if any(ord(ch) < 32 for ch in name):
        raise FolderError(400, "Folder names cannot contain control characters.")

    return name


def _get(db: Session, user_id: int, folder_id: int) -> LibraryFolder:
    folder = (
        db.query(LibraryFolder)
        .filter(LibraryFolder.id == folder_id, LibraryFolder.user_id == user_id)
        .first()
    )

    if folder is None:
        raise FolderError(404, "Folder not found.")

    return folder


def _children_map(db: Session, user_id: int) -> dict[int | None, list[LibraryFolder]]:
    children: dict[int | None, list[LibraryFolder]] = {}

    for folder in (
        db.query(LibraryFolder)
        .filter(LibraryFolder.user_id == user_id)
        .order_by(LibraryFolder.name)
        .all()
    ):
        children.setdefault(folder.parent_id, []).append(folder)

    return children


def descendant_ids(db: Session, user_id: int, folder_id: int) -> list[int]:
    """The folder's subfolders at every depth (not the folder itself)."""

    children = _children_map(db, user_id)
    found: list[int] = []
    stack = [folder_id]

    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child.id)
            stack.append(child.id)

    return found


def _depth(db: Session, user_id: int, folder_id: int | None) -> int:
    """Levels from the root to this folder, counting the folder (root = 0)."""

    depth = 0
    seen: set[int] = set()

    while folder_id is not None and folder_id not in seen:
        seen.add(folder_id)
        folder = (
            db.query(LibraryFolder)
            .filter(LibraryFolder.id == folder_id, LibraryFolder.user_id == user_id)
            .first()
        )

        if folder is None:
            break

        depth += 1
        folder_id = folder.parent_id

    return depth


def _height(children: dict, folder_id: int) -> int:
    """Levels below this folder (a leaf has 0)."""

    below = [_height(children, c.id) + 1 for c in children.get(folder_id, [])]

    return max(below, default=0)


def _check_sibling(
    db: Session, user_id: int, parent_id: int | None, name: str, ignore_id: int | None = None
) -> None:
    key = name.casefold()

    for sibling in (
        db.query(LibraryFolder)
        .filter(LibraryFolder.user_id == user_id, LibraryFolder.parent_id == parent_id)
        .all()
    ):
        if sibling.id != ignore_id and sibling.name.casefold() == key:
            raise FolderError(
                409, f'There is already a folder named "{sibling.name}" here.'
            )


def create_folder(
    db: Session, user_id: int, name: str, parent_id: int | None = None
) -> LibraryFolder:
    name = clean_name(name)

    if parent_id is not None:
        _get(db, user_id, parent_id)

        if _depth(db, user_id, parent_id) >= MAX_DEPTH:
            raise FolderError(400, f"Folders can be nested {MAX_DEPTH} levels deep.")

    _check_sibling(db, user_id, parent_id, name)

    folder = LibraryFolder(user_id=user_id, parent_id=parent_id, name=name)
    db.add(folder)
    db.commit()

    return folder


_UNSET = object()


def update_folder(
    db: Session,
    user_id: int,
    folder_id: int,
    *,
    name: str | None | object = _UNSET,
    parent_id: int | None | object = _UNSET,
) -> LibraryFolder:
    """Rename and/or move. ``parent_id=None`` moves it to the top level."""

    folder = _get(db, user_id, folder_id)
    new_name = folder.name if name is _UNSET else clean_name(name)  # type: ignore[arg-type]
    new_parent = folder.parent_id if parent_id is _UNSET else parent_id

    if new_parent is not None:
        _get(db, user_id, new_parent)  # type: ignore[arg-type]

        if new_parent == folder.id or new_parent in descendant_ids(db, user_id, folder.id):
            raise FolderError(400, "A folder cannot go inside itself.")

        children = _children_map(db, user_id)
        depth = _depth(db, user_id, new_parent) + 1 + _height(children, folder.id)  # type: ignore[arg-type]

        if depth > MAX_DEPTH:
            raise FolderError(400, f"Folders can be nested {MAX_DEPTH} levels deep.")

    _check_sibling(db, user_id, new_parent, new_name, ignore_id=folder.id)  # type: ignore[arg-type]

    folder.name = new_name
    folder.parent_id = new_parent  # type: ignore[assignment]
    db.commit()

    return folder


def delete_folder(db: Session, user_id: int, folder_id: int) -> int:
    """Delete the folder and its subfolders; the papers stay in the library.
    Returns how many folders were deleted."""

    _get(db, user_id, folder_id)
    ids = [folder_id, *descendant_ids(db, user_id, folder_id)]

    db.query(LibraryFolderPaper).filter(LibraryFolderPaper.folder_id.in_(ids)).delete(
        synchronize_session=False
    )
    db.query(LibraryFolder).filter(LibraryFolder.id.in_(ids)).delete(
        synchronize_session=False
    )
    db.commit()

    return len(ids)


def saved_paper_ids(db: Session, user_id: int) -> set[int]:
    return {
        pid
        for (pid,) in db.query(PersonalLibrary.paper_id)
        .filter(PersonalLibrary.user_id == user_id)
        .all()
    }


def set_membership(
    db: Session,
    user_id: int,
    folder_id: int,
    paper_ids: Iterable[int],
    action: str,
) -> dict:
    """Add papers to (or remove them from) a folder. Idempotent. Papers that
    are not saved in the library are skipped and reported."""

    if action not in ("add", "remove"):
        raise FolderError(400, 'action must be "add" or "remove".')

    _get(db, user_id, folder_id)
    wanted = list(dict.fromkeys(int(p) for p in paper_ids))

    if len(wanted) > MAX_PAPERS_PER_CALL:
        raise FolderError(400, f"At most {MAX_PAPERS_PER_CALL} papers at a time.")

    saved = saved_paper_ids(db, user_id)
    usable = [p for p in wanted if p in saved]
    skipped = [p for p in wanted if p not in saved]
    existing = {
        pid
        for (pid,) in db.query(LibraryFolderPaper.paper_id)
        .filter(LibraryFolderPaper.folder_id == folder_id)
        .all()
    }
    changed = 0

    if action == "add":
        for pid in usable:
            if pid not in existing:
                db.add(LibraryFolderPaper(folder_id=folder_id, paper_id=pid))
                changed += 1
    else:
        if usable:
            changed = (
                db.query(LibraryFolderPaper)
                .filter(
                    LibraryFolderPaper.folder_id == folder_id,
                    LibraryFolderPaper.paper_id.in_(usable),
                )
                .delete(synchronize_session=False)
            )

    db.commit()

    return {"changed": changed, "skipped": skipped}


def clear_paper(db: Session, user_id: int, paper_id: int) -> None:
    """A paper left the library: take it out of every one of the user's folders."""

    ids = [
        fid
        for (fid,) in db.query(LibraryFolder.id)
        .filter(LibraryFolder.user_id == user_id)
        .all()
    ]

    if ids:
        db.query(LibraryFolderPaper).filter(
            LibraryFolderPaper.folder_id.in_(ids),
            LibraryFolderPaper.paper_id == paper_id,
        ).delete(synchronize_session=False)


def overview(db: Session, user_id: int) -> dict:
    """Everything the sidebar needs in one call."""

    folders = (
        db.query(LibraryFolder)
        .filter(LibraryFolder.user_id == user_id)
        .order_by(LibraryFolder.name)
        .all()
    )
    ids = [f.id for f in folders]
    saved = saved_paper_ids(db, user_id)
    memberships: dict[int, list[int]] = {}
    stale = []

    if ids:
        for row in (
            db.query(LibraryFolderPaper)
            .filter(LibraryFolderPaper.folder_id.in_(ids))
            .all()
        ):
            if row.paper_id in saved:
                memberships.setdefault(row.paper_id, []).append(row.folder_id)
            else:
                stale.append(row.id)  # placed, but no longer saved

    if stale:  # heal quietly
        db.query(LibraryFolderPaper).filter(LibraryFolderPaper.id.in_(stale)).delete(
            synchronize_session=False
        )
        db.commit()

    counts: dict[int, int] = {}

    for folder_list in memberships.values():
        for fid in folder_list:
            counts[fid] = counts.get(fid, 0) + 1

    return {
        "folders": [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "paper_count": counts.get(f.id, 0),
            }
            for f in folders
        ],
        "memberships": {str(pid): sorted(fids) for pid, fids in memberships.items()},
        "unfiled": sum(1 for pid in saved if pid not in memberships),
        "max_depth": MAX_DEPTH,
    }

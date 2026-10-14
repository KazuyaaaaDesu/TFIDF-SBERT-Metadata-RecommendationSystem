/**
 * The folder sidebar of My Library: All papers, Unfiled, and the user's own
 * nested folders. Create, rename, move and delete folders; drop papers on a
 * folder to file them; drag a folder onto another to nest it. Everything is
 * also reachable without a mouse (the ⋯ button opens the same menu as a
 * right-click, and the inline name fields take Enter / Escape).
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Inbox, Library, MoreHorizontal } from "lucide-react";

import type { LibraryFoldersApi } from "../state/libraryFolders";
import { canMove, suggestName, visibleRows, type FolderNode } from "../utils/folderTree";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import RetroDialog from "./retro/RetroDialog";

export type FolderChoice = "all" | "unfiled" | number;

const PAPER_MIME = "application/x-research-paper";
const FOLDER_MIME = "application/x-library-folder";
const COLLAPSED_KEY = "paperrec_library_folders_collapsed";

function readCollapsed(): Set<number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");

    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}

interface Props {
  api: LibraryFoldersApi;
  total: number;
  active: FolderChoice;
  onChoose: (choice: FolderChoice) => void;
  includeSubfolders: boolean;
  onIncludeSubfolders: (value: boolean) => void;
  /** Papers dropped on a folder (the dragged paper, or the whole selection). */
  onFilePapers: (folderId: number, paperIds: number[]) => void;
  /** "Select every paper in this folder" (feeds Dashboard, Graph and Chat). */
  onSelectFolder: (folderId: number) => void;
}

export default function LibraryFolderTree({
  api,
  total,
  active,
  onChoose,
  includeSubfolders,
  onIncludeSubfolders,
  onFilePapers,
  onSelectFolder,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(readCollapsed);
  const [creating, setCreating] = useState<{ parentId: number | null } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: FolderNode } | null>(null);
  const [deleting, setDeleting] = useState<FolderNode | null>(null);
  const [dropTarget, setDropTarget] = useState<number | "root" | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* best-effort */
    }
  }, [collapsed]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [creating, renaming]);

  const rows = visibleRows(api.tree, collapsed);

  function toggle(id: number) {
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }

  function startCreate(parentId: number | null) {
    setMessage(null);
    setRenaming(null);
    setDraft(suggestName(api.folders, parentId));
    setCreating({ parentId });
    if (parentId !== null) {
      setCollapsed((current) => {
        const next = new Set(current);

        next.delete(parentId);

        return next;
      });
    }
  }

  function startRename(node: FolderNode) {
    setMessage(null);
    setCreating(null);
    setDraft(node.name);
    setRenaming(node.id);
  }

  async function commit() {
    const name = draft.trim();

    try {
      if (creating) {
        const made = await api.createFolder(name, creating.parentId);

        setCreating(null);
        onChoose(made.id);
      } else if (renaming !== null) {
        const current = api.folders.find((f) => f.id === renaming);

        if (current && current.name !== name) await api.renameFolder(renaming, name);
        setRenaming(null);
      }

      setMessage(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "That did not work.");
    }
  }

  function cancelEdit() {
    setCreating(null);
    setRenaming(null);
    setMessage(null);
  }

  async function moveTo(folderId: number, parentId: number | null) {
    if (!canMove(api.folders, folderId, parentId, api.maxDepth)) return;

    try {
      await api.moveFolder(folderId, parentId);
      if (parentId !== null) {
        setCollapsed((current) => {
          const next = new Set(current);

          next.delete(parentId);

          return next;
        });
      }
      setMessage(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not move the folder.");
    }
  }

  function menuEntries(node: FolderNode): MenuEntry[] {
    const canNest = node.depth + 1 < api.maxDepth;
    const parents = api.folders.filter(
      (f) => f.id !== node.id && canMove(api.folders, node.id, f.id, api.maxDepth),
    );

    return [
      { id: "open", label: "Open folder", onSelect: () => onChoose(node.id) },
      {
        id: "select",
        label: "Select its papers",
        hint: `${node.paper_count}`,
        disabled: node.paper_count === 0,
        onSelect: () => onSelectFolder(node.id),
      },
      { id: "sep1", separator: true },
      { id: "new", label: "New subfolder", disabled: !canNest, onSelect: () => startCreate(node.id) },
      { id: "rename", label: "Rename", onSelect: () => startRename(node) },
      ...(node.parent_id !== null
        ? [{ id: "top", label: "Move to the top level", onSelect: () => void moveTo(node.id, null) } as MenuEntry]
        : []),
      ...(parents.length
        ? [
            { id: "moveh", heading: "Move into" } as MenuEntry,
            ...parents.slice(0, 12).map(
              (f): MenuEntry => ({
                id: `move-${f.id}`,
                label: f.name,
                onSelect: () => void moveTo(node.id, f.id),
              }),
            ),
          ]
        : []),
      { id: "sep2", separator: true },
      { id: "delete", label: "Delete folder…", danger: true, onSelect: () => setDeleting(node) },
    ];
  }

  function paperIdsFrom(event: React.DragEvent): number[] | null {
    if (!event.dataTransfer.types.includes(PAPER_MIME)) return null;

    try {
      const data = JSON.parse(event.dataTransfer.getData(PAPER_MIME));
      const ids: unknown[] = Array.isArray(data.ids) ? data.ids : [data.id];

      return ids.filter((n): n is number => typeof n === "number");
    } catch {
      return null;
    }
  }

  function dragOver(event: React.DragEvent, target: number | "root") {
    const hasPaper = event.dataTransfer.types.includes(PAPER_MIME);
    const hasFolder = event.dataTransfer.types.includes(FOLDER_MIME);

    if (!hasPaper && !(hasFolder)) return;
    if (target === "root" && hasPaper) return; // "All papers" is not a place to file into

    event.preventDefault();
    event.dataTransfer.dropEffect = hasFolder ? "move" : "copy";
    setDropTarget(target);
  }

  function drop(event: React.DragEvent, target: number | "root") {
    event.preventDefault();
    setDropTarget(null);

    const paperIds = paperIdsFrom(event);

    if (paperIds && typeof target === "number") {
      onFilePapers(target, paperIds);
      return;
    }

    const folderId = Number(event.dataTransfer.getData(FOLDER_MIME));

    if (folderId) void moveTo(folderId, target === "root" ? null : target);
  }

  const nameInput = (
    <div className="lib-folder-edit">
      <input
        ref={inputRef}
        value={draft}
        maxLength={80}
        aria-label={creating ? "New folder name" : "Folder name"}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          else if (event.key === "Escape") cancelEdit();
        }}
        onBlur={() => {
          // Leaving the field keeps what was typed, like Finder and Zotero.
          if (draft.trim()) void commit();
          else cancelEdit();
        }}
        className="ui-input !min-h-0 !px-2 !py-1 text-sm"
      />
    </div>
  );

  return (
    <nav className="lib-folders" aria-label="Folders">
      <div className="lib-folders-head">
        <h2 className="font-pixelify">Folders</h2>
        <button
          type="button"
          className="lib-folder-icon-btn"
          onClick={() => startCreate(null)}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <ul role="tree" className="lib-folder-list">
        <li role="none">
          <button
            type="button"
            role="treeitem"
            aria-selected={active === "all"}
            onClick={() => onChoose("all")}
            onDragOver={(event) => dragOver(event, "root")}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => drop(event, "root")}
            data-drop={dropTarget === "root"}
            data-drop-zone="blocked"
            data-drop-label="Drop on a folder"
            className="lib-folder-row"
            data-active={active === "all"}
          >
            <Library className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="lib-folder-name">All papers</span>
            <span className="lib-folder-count">{total}</span>
          </button>
        </li>
        <li role="none">
          <button
            type="button"
            role="treeitem"
            aria-selected={active === "unfiled"}
            onClick={() => onChoose("unfiled")}
            data-drop-zone="blocked"
            data-drop-label="Drop on a folder"
            className="lib-folder-row"
            data-active={active === "unfiled"}
          >
            <Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="lib-folder-name">Unfiled</span>
            <span className="lib-folder-count">{api.unfiled}</span>
          </button>
        </li>

        {creating?.parentId === null && <li className="lib-folder-edit-row">{nameInput}</li>}

        {rows.map((node) => {
          const hasChildren = node.children.length > 0;
          const open = !collapsed.has(node.id);

          return (
            <li key={node.id} role="none">
              <div
                role="treeitem"
                aria-selected={active === node.id}
                aria-expanded={hasChildren ? open : undefined}
                aria-level={node.depth + 1}
                tabIndex={0}
                draggable={renaming !== node.id}
                data-active={active === node.id}
                data-drop={dropTarget === node.id}
                data-drop-zone="folder"
                data-drop-label={node.name}
                className="lib-folder-row"
                style={{ paddingLeft: `${0.4 + node.depth * 0.95}rem` }}
                onClick={() => onChoose(node.id)}
                onDoubleClick={() => startRename(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onChoose(node.id);
                  else if (event.key === "F2") startRename(node);
                  else if (event.key === "ArrowRight" && hasChildren && !open) toggle(node.id);
                  else if (event.key === "ArrowLeft" && hasChildren && open) toggle(node.id);
                  else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    const rect = event.currentTarget.getBoundingClientRect();

                    setMenu({ x: rect.left + 24, y: rect.bottom, node });
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, node });
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(FOLDER_MIME, String(node.id));
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => dragOver(event, node.id)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => drop(event, node.id)}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="lib-folder-twist"
                  aria-label={open ? "Collapse" : "Expand"}
                  style={{ visibility: hasChildren ? "visible" : "hidden" }}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(node.id);
                  }}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {active === node.id ? (
                  <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                {renaming === node.id ? (
                  nameInput
                ) : (
                  <>
                    <span className="lib-folder-name">{node.name}</span>
                    <span className="lib-folder-count">{node.paper_count}</span>
                    <button
                      type="button"
                      className="lib-folder-more"
                      aria-label={`Actions for ${node.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();

                        setMenu({ x: rect.left, y: rect.bottom + 2, node });
                      }}
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
              {creating?.parentId === node.id && (
                <div className="lib-folder-edit-row" style={{ paddingLeft: `${1.5 + (node.depth + 1) * 0.95}rem` }}>
                  {nameInput}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {message && (
        <p role="alert" className="lib-folder-msg">
          {message}
        </p>
      )}

      {api.loaded && api.folders.length === 0 && !creating && (
        <p className="lib-folder-hint">
          Make a folder for a chapter, a course or a reading list, then drag papers onto it. A paper can be in
          several folders.
        </p>
      )}

      {typeof active === "number" && (
        <label className="lib-folder-sub">
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => onIncludeSubfolders(event.target.checked)}
          />
          Include subfolders
        </label>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.node.name}
          ariaLabel={`Folder ${menu.node.name}`}
          entries={menuEntries(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}

      <RetroDialog
        open={deleting !== null}
        title="Delete folder"
        confirmLabel="Delete folder"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const node = deleting;

          setDeleting(null);
          if (!node) return;

          void api
            .deleteFolder(node.id)
            .then(() => {
              if (active === node.id) onChoose("all");
            })
            .catch((cause) => setMessage(cause instanceof Error ? cause.message : "Could not delete the folder."));
        }}
      >
        <p className="text-sm leading-6 text-ink">
          Delete <strong>{deleting?.name}</strong>
          {deleting && deleting.children.length > 0 ? " and the folders inside it" : ""}? The papers stay in your
          library; they are only taken out of the folder.
        </p>
      </RetroDialog>
    </nav>
  );
}

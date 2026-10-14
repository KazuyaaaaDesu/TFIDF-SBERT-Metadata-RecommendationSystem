/**
 * Pure helpers for the library's folder tree: building it, walking it, and
 * the same move rules the server enforces (so the UI can refuse a move
 * before asking). Kept free of React so it runs under `node --test`.
 */

export interface FolderRow {
  id: number;
  name: string;
  parent_id: number | null;
  paper_count: number;
}

export interface FolderNode extends FolderRow {
  depth: number;
  children: FolderNode[];
}

const byName = (a: FolderRow, b: FolderRow) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function buildTree(folders: FolderRow[]): FolderNode[] {
  const nodes = new Map<number, FolderNode>();

  for (const folder of folders) nodes.set(folder.id, { ...folder, depth: 0, children: [] });

  const roots: FolderNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.parent_id !== null ? nodes.get(node.parent_id) : undefined;

    // A folder whose parent is missing (never expected) is shown at the top.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const settle = (list: FolderNode[], depth: number) => {
    list.sort(byName);
    for (const node of list) {
      node.depth = depth;
      settle(node.children, depth + 1);
    }
  };

  settle(roots, 0);

  return roots;
}

/** The folder's subfolders at every depth (not the folder itself). */
export function descendantIds(folders: FolderRow[], id: number): number[] {
  const children = new Map<number | null, number[]>();

  for (const f of folders) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f.id]);

  const out: number[] = [];
  const stack = [id];

  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }

  return out;
}

/** "Thesis / Chapter 2 / Methods". */
export function folderPath(folders: FolderRow[], id: number): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let at: number | null = id;

  while (at !== null && byId.has(at) && !seen.has(at)) {
    seen.add(at);
    parts.unshift(byId.get(at)!.name);
    at = byId.get(at)!.parent_id;
  }

  return parts.join(" / ");
}

/** Every folder in tree order with its path, for pickers. */
export function flatPaths(folders: FolderRow[]): { id: number; path: string; depth: number }[] {
  const out: { id: number; path: string; depth: number }[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      out.push({ id: node.id, path: folderPath(folders, node.id), depth: node.depth });
      walk(node.children);
    }
  };

  walk(buildTree(folders));

  return out;
}

/** Rows to draw: the tree flattened, skipping the children of collapsed nodes. */
export function visibleRows(tree: FolderNode[], collapsed: Set<number>): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (!collapsed.has(node.id)) walk(node.children);
    }
  };

  walk(tree);

  return out;
}

/** The paper ids shown when a folder is chosen. */
export function papersInFolder(
  folders: FolderRow[],
  memberships: Record<string, number[]>,
  id: number,
  includeSubfolders: boolean,
): Set<number> {
  const wanted = new Set<number>([id, ...(includeSubfolders ? descendantIds(folders, id) : [])]);
  const out = new Set<number>();

  for (const [paperId, folderIds] of Object.entries(memberships)) {
    if (folderIds.some((f) => wanted.has(f))) out.add(Number(paperId));
  }

  return out;
}

function height(folders: FolderRow[], id: number): number {
  const kids = folders.filter((f) => f.parent_id === id);

  return kids.reduce((max, k) => Math.max(max, height(folders, k.id) + 1), 0);
}

function depthOf(folders: FolderRow[], id: number | null): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let n = 0;
  const seen = new Set<number>();

  while (id !== null && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    n += 1;
    id = byId.get(id)!.parent_id;
  }

  return n;
}

/** Can `id` be moved under `newParent` (null = top level)? Mirrors the server. */
export function canMove(
  folders: FolderRow[],
  id: number,
  newParent: number | null,
  maxDepth: number,
): boolean {
  if (newParent === id) return false;
  if (newParent !== null && descendantIds(folders, id).includes(newParent)) return false;

  const current = folders.find((f) => f.id === id);

  if (!current) return false;
  if (current.parent_id === newParent) return false; // already there

  return depthOf(folders, newParent) + 1 + height(folders, id) <= maxDepth;
}

/** A name to offer for a new folder: "New folder", "New folder 2", … */
export function suggestName(folders: FolderRow[], parentId: number | null, base = "New folder"): string {
  const taken = new Set(
    folders.filter((f) => f.parent_id === parentId).map((f) => f.name.trim().toLowerCase()),
  );

  if (!taken.has(base.toLowerCase())) return base;

  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }
}

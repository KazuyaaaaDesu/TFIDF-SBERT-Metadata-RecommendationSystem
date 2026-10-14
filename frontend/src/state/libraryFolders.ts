/**
 * The library's folders: loaded once, refreshed after every change.
 * Every mutation resolves with the server's answer and then refetches, so
 * the sidebar, the counts and each paper's folder list always agree with the
 * database (and with the other tab, after the next action).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createLibraryFolder,
  deleteLibraryFolder,
  getLibraryFolders,
  setLibraryFolderPapers,
  updateLibraryFolder,
  type LibraryFolder,
} from "../api";
import { buildTree, type FolderNode } from "../utils/folderTree";

const EMPTY = { folders: [] as LibraryFolder[], memberships: {} as Record<string, number[]>, unfiled: 0, maxDepth: 6 };

export function useLibraryFolders() {
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const overview = await getLibraryFolders();

      setData({
        folders: overview.folders,
        memberships: overview.memberships,
        unfiled: overview.unfiled,
        maxDepth: overview.max_depth,
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load folders.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Papers saved or removed anywhere (the picker, the repository, the pet)
  // change the counts and the Unfiled number.
  useEffect(() => {
    const onChange = () => void refresh();

    window.addEventListener("library-changed", onChange);

    return () => window.removeEventListener("library-changed", onChange);
  }, [refresh]);

  const tree: FolderNode[] = useMemo(() => buildTree(data.folders), [data.folders]);

  /** Run a change, then refetch. Rejects with the server's message. */
  const change = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return {
    ...data,
    tree,
    loaded,
    error,
    refresh,
    foldersOf: (paperId: number): number[] => data.memberships[String(paperId)] ?? [],
    createFolder: (name: string, parentId: number | null = null) =>
      change(() => createLibraryFolder(name, parentId)),
    renameFolder: (id: number, name: string) => change(() => updateLibraryFolder(id, { name })),
    moveFolder: (id: number, parentId: number | null) =>
      change(() => updateLibraryFolder(id, { parentId })),
    deleteFolder: (id: number) => change(() => deleteLibraryFolder(id)),
    addPapers: (folderId: number, paperIds: number[]) =>
      change(() => setLibraryFolderPapers(folderId, paperIds, "add")),
    removePapers: (folderId: number, paperIds: number[]) =>
      change(() => setLibraryFolderPapers(folderId, paperIds, "remove")),
  };
}

export type LibraryFoldersApi = ReturnType<typeof useLibraryFolders>;

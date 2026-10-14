/**
 * MY LIBRARY — the collection page.
 *
 * One layout for everyone: the four-tab collection (Library,
 * Dashboard, Graph, Chat). In basic form the last three tabs are
 * locked — they unlock together once any garden tree reaches its
 * Young stage (see data/knowledge.ts and state/sun.tsx). The
 * layout is identical either way; PRO only reveals more.
 */

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";

import { getLibrary, saveToLibrary, LibraryEntry, Paper } from "../../api";
import PaperViewerModal from "../../components/PaperViewerModal";
import RepositoryPickerDialog from "../../components/RepositoryPickerDialog";
import PetFigure from "../../components/PetFigure";
import { Button, EmptyState, PageHeader } from "../../components/ui";
import HuntItem from "../../components/retro/HuntItem";
import { HUNT_ITEMS } from "../../data/hunt";
import { useSiteMode } from "../../state/siteMode";
import { useSun } from "../../state/sun";
import MyLibraryPro from "./MyLibraryPro";
import ProPackButton from "../../components/ProPack";

export default function MyLibrary() {
  const { proUnlocked } = useSun();
  const presenting = useSiteMode().mode === "presentation";
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* The viewer modal, shared by the collection's row actions. */
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [isViewerOpen, setIsViewerOpen] = useState(false);

  /* Mini-repository picker pop-up ("Browse Repository") — it returns
     the chosen paper, which is saved straight into the library. */
  const [pickerOpen, setPickerOpen] = useState(false);

  async function handlePickerPick(paper: Paper) {
    await saveToLibrary(paper.id);
    setPickerOpen(false);
  }

  const loadedRef = useRef(false);

  async function load() {
    try {
      const list = await getLibrary();
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the library.");
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Keep the page in sync when papers are saved/removed elsewhere.
  useEffect(() => {
    function handleLibraryChange() {
      void getLibrary()
        .then(setEntries)
        .catch(() => undefined);
    }

    window.addEventListener("library-changed", handleLibraryChange);

    return () =>
      window.removeEventListener("library-changed", handleLibraryChange);
  }, []);

  function handlePaperUpdated(updated: Paper) {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.paper.id === updated.id ? { ...entry, paper: updated } : entry,
      ),
    );
    setSelectedPaper((current) =>
      current?.id === updated.id ? updated : current,
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1240px]">
      <HuntItem item={HUNT_ITEMS.find((item) => item.id === "hunt-star")!} />
      <PageHeader
        eyebrow="Saved papers"
        title="My Library"
        description={
          loading
            ? "Loading your saved papers…"
            : `${entries.length} saved paper${entries.length === 1 ? "" : "s"}.`
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => setPickerOpen(true)}>
              Browse Repository
            </Button>

            {!proUnlocked && (
              <span
                title={
                  presenting
                    ? "Part of the PRO version"
                    : "Plant any tree past its Young stage in the Lab's garden to unlock the PRO tabs (Young oak 1500 fertilizer, Young maple 1450, birch 1580, elm 1600, redwood 1350, beanstalk 1300, rose supervine 1480)."
                }
                className="font-pixelify inline-flex h-9 cursor-help items-center gap-1.5 rounded border-[3px] border-gray-900 bg-white px-3 text-sm font-bold text-muted"
              >
                <Lock className="h-3.5 w-3.5" /> PRO locked
              </span>
            )}
            {!proUnlocked && <ProPackButton />}
          </div>
        }
      />

      {error && (
        <div className="status-error mb-4">
          Couldn't load your library: {error}. Is the backend running on
          port 8000?
        </div>
      )}

      <div className="mt-4">
      {!loading && entries.length === 0 && !error ? (
        <EmptyState
          title="Your library is empty."
          description="Save papers from the repository or recommendation results to keep them here."
          figure={<PetFigure />}
          action={
            <Button type="button" onClick={() => setPickerOpen(true)}>
              Browse repository
            </Button>
          }
        />
      ) : (
        <MyLibraryPro
          entries={entries}
          locked={!proUnlocked}
          onRemoved={(paperId) =>
            setEntries((prev) =>
              prev.filter((entry) => entry.paper.id !== paperId),
            )
          }
          onPaperUpdated={handlePaperUpdated}
          viewer={{
            paper: selectedPaper,
            open: isViewerOpen,
            openPaper: (paper) => {
              setSelectedPaper(paper);
              setIsViewerOpen(true);
            },
            close: () => {
              setIsViewerOpen(false);
              setSelectedPaper(null);
            },
          }}
        />
      )}
      </div>

      {selectedPaper && (
        <PaperViewerModal
          paper={selectedPaper}
          open={isViewerOpen}
          onClose={() => {
            setIsViewerOpen(false);
            setSelectedPaper(null);
          }}
          canEdit
          onPaperUpdated={handlePaperUpdated}
        />
      )}

      <RepositoryPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickerPick}
      />
    </div>
  );
}
/**
 * SITE MODE — Library mode vs Researcher mode.
 *
 * Library mode is the visitor-facing "smarter librarian": a subset of
 * the app whose features the admin can show, lock, or hide (see
 * data/siteFeatures.ts). Researcher mode is the full pro tool and
 * ignores all feature states.
 *
 * The choice persists per browser; Library is the default.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { getLibraryFeatures } from "../api";
import {
  DEFAULT_LIBRARY_FEATURES,
  PRESENTATION_FEATURES,
  type SiteFeatureState,
} from "../data/siteFeatures";
import { enterPresentation, leavePresentation } from "../utils/presentation";
import { useSun } from "./sun";

export type SiteMode = "library" | "researcher" | "presentation";

const MODE_KEY = "paperrec_site_mode";
const DEFAULT_MODE: SiteMode = "library";

interface SiteModeValue {
  mode: SiteMode;
  setMode: (mode: SiteMode) => void;
  /**
   * The state of a feature *in Library mode*: "shown", "locked", or
   * "hidden". In Researcher mode everything reports "shown".
   */
  stateFor: (key: string) => SiteFeatureState;
  /** True when the current mode may open the feature. */
  canAccess: (key: string) => boolean;
  refreshFeatures: () => void;
}

const SiteModeContext = createContext<SiteModeValue | null>(null);

function readStoredMode(): SiteMode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);

    if (stored === "library" || stored === "researcher" || stored === "presentation") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }

  return DEFAULT_MODE;
}

export function SiteModeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [mode, setModeState] = useState<SiteMode>(readStoredMode);

  // Non-null while the switching screen plays; the mode change is
  // applied when the timer completes.
  const [switchingTo, setSwitchingTo] = useState<SiteMode | null>(null);

  const [features, setFeatures] = useState<
    Record<string, SiteFeatureState>
  >(DEFAULT_LIBRARY_FEATURES);

  const refreshFeatures = useCallback(() => {
    getLibraryFeatures()
      .then((payload) => {
        setFeatures({
          ...DEFAULT_LIBRARY_FEATURES,
          ...payload.features,
        });
      })
      .catch(() => {
        // Keep the defaults; a failed fetch shouldn't lock anyone out.
      });
  }, []);

  useEffect(() => {
    refreshFeatures();

    // The admin editor dispatches this after saving so open tabs
    // re-read the states without a reload.
    window.addEventListener(
      "site-features-changed",
      refreshFeatures
    );

    return () =>
      window.removeEventListener(
        "site-features-changed",
        refreshFeatures
      );
  }, [refreshFeatures]);

  // Library mode reads friendlier: a larger root font scales every
  // rem-based size (type, spacing, controls) up together, while
  // Researcher mode keeps the dense console scale.
  useEffect(() => {
    document.documentElement.style.fontSize =
      mode === "researcher" ? "" : "18px";
  }, [mode]);

  const setMode = useCallback(
    (next: SiteMode) => {
      if (next === mode) {
        return;
      }

      // Play the switching screen as a deliberate beat while the
      // feature menu refreshes in the background, then apply the
      // mode together with the persisted choice.
      setSwitchingTo(next);
      refreshFeatures();

      window.setTimeout(() => {
        try {
          if (next === "presentation") {
            enterPresentation(window.localStorage);
          } else if (mode === "presentation") {
            leavePresentation(window.localStorage, next);
          } else {
            window.localStorage.setItem(MODE_KEY, next);
          }
        } catch {
          // Persisting is best-effort.
        }

        // Presentation sets every preference aside (or puts them back), and
        // the stores have already read storage: start the app afresh.
        if (next === "presentation" || mode === "presentation") {
          window.location.assign("/repository");

          return;
        }

        setModeState(next);
        setSwitchingTo(null);
      }, 950);
    },
    [mode, refreshFeatures]
  );

  // Pro (the demo purchase) opens the Lab, as a beta, in the two shipped
  // modes. Researcher mode already has everything.
  const { proPurchased } = useSun();

  const value = useMemo<SiteModeValue>(() => {
    function stateFor(key: string): SiteFeatureState {
      if (mode === "researcher") {
        return "shown";
      }

      if (key === "lab" && proPurchased) {
        return "shown";
      }

      if (mode === "presentation") {
        return PRESENTATION_FEATURES[key] ?? "hidden";
      }

      return features[key] ?? "shown";
    }

    return {
      mode,
      setMode,
      stateFor,
      canAccess: (key: string) => stateFor(key) === "shown",
      refreshFeatures,
    };
  }, [mode, setMode, features, refreshFeatures, proPurchased]);

  return (
    <SiteModeContext.Provider value={value}>
      {children}
      {switchingTo && <ModeSwitchScreen target={switchingTo} />}
    </SiteModeContext.Provider>
  );
}

/**
 * The deliberate beat between modes: a retro loading screen while
 * the nav's feature states are refetched underneath.
 */
function ModeSwitchScreen({ target }: { target: SiteMode }) {
  const entering =
    target === "researcher"
      ? "RESEARCHER MODE"
      : target === "presentation"
        ? "PRESENTATION MODE"
        : "LIBRARY MODE";

  return (
    <div
      role="status"
      aria-live="polite"
      data-mode-switch-screen
      className="fixed inset-0 z-[9500] flex flex-col items-center justify-center gap-6 bg-canvas px-6 text-center"
    >
      <p className="font-mono text-xs font-bold uppercase tracking-[0.3em] text-muted">
        Switching mode
      </p>

      <h2 className="font-pixelify text-3xl font-bold text-ink">
        {entering}
      </h2>

      <div className="h-4 w-64 overflow-hidden rounded border-[3px] border-gray-900 bg-white">
        <div className="animate-loader-fill h-full bg-accent" />
      </div>

      <p className="font-mono text-xs text-muted">
        {target === "researcher"
          ? "Warming up pipelines, arenas, and labs…"
          : target === "presentation"
            ? "Setting everything to the shipped version…"
            : "Waking the librarian…"}
      </p>
    </div>
  );
}

export function useSiteMode(): SiteModeValue {
  const value = useContext(SiteModeContext);

  if (!value) {
    throw new Error("useSiteMode must be used inside SiteModeProvider");
  }

  return value;
}

import { Suspense, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
} from "react-router-dom";

import {
  getRecommendationIndexStatus,
  getLibrary,
} from "../api";

import RecommendationIndexAlert from "../components/RecommendationIndexAlert";
import AccentPicker from "../components/AccentPicker";
import SlimeLogo from "../components/retro/SlimeLogo";
import MarqueeTicker from "../components/retro/MarqueeTicker";
import ScrollFollowPopup from "../components/retro/ScrollFollowPopup";
import PixelPet from "../components/retro/PixelPet";
import CheatFoliage from "../components/retro/CheatFoliage";
import CheatConsole from "../components/CheatConsole";
import DevUnlock from "../components/DevUnlock";
import { ProPackHost } from "../components/ProPack";
import { useSun } from "../state/sun";
import { applyStoredGardenFrame } from "../utils/gardenFrame";
import LiveBackground from "../components/LiveBackground";
import { ArrowRight, BlockCursor, Lock } from "../components/retro/PixelIcons";
import {
  Cpu,
  Database,
  FlaskConical,
  GraduationCap,
  HelpCircle,
  Library,
  ScrollText,
  Settings,
  Sigma,
  Swords,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useSiteMode } from "../state/siteMode";
import { useLayoutPrefs } from "../state/layoutPrefs";
import { useNerdButtons } from "../state/nerdButtons";
import StatsDrawer from "../components/StatsDrawer";


// ============================================================
// SHARED APP NAVIGATION
// ============================================================

/** Temporary walkthrough tab — flip to false to hide it. */
const SHOW_WALKTHROUGH_TAB = true;

/** Temporary engine walkthrough tab — flip to false to hide it. */
const SHOW_ENGINE_TAB = true;

const navItems = [
  {
    to: "/repository",
    label: "Repository",
    icon: Database,
    tip: "nav-repository",
    feature: "repository",
  },
  {
    to: "/upload",
    label: "Upload",
    icon: Upload,
    tip: "nav-upload",
    feature: "upload",
  },
  {
    to: "/library",
    label: "My Library",
    icon: Library,
    badge: true,
    tip: "nav-library",
    feature: "library",
  },
  {
    to: "/evaluation",
    label: "Arena",
    icon: Swords,
    tip: "nav-evaluation",
    feature: "arena",
  },
  {
    to: "/lab",
    label: "Lab",
    icon: FlaskConical,
    tip: "nav-lab",
    feature: "lab",
  },
  ...(SHOW_WALKTHROUGH_TAB
    ? [
        {
          to: "/walkthrough",
          label: "Walkthrough",
          icon: GraduationCap,
          tip: "nav-walkthrough",
          feature: "walkthrough",
        },
      ]
    : []),
  ...(SHOW_ENGINE_TAB
    ? [
        {
          to: "/walkthrough-engine",
          label: "Engine",
          icon: Cpu,
          tip: "nav-engine",
          feature: "engine",
        },
      ]
    : []),
  {
    to: "/faq",
    label: "FAQ",
    icon: HelpCircle,
    tip: "nav-faq",
    feature: "faq",
  },
  {
    to: "/settings",
    label: "Settings",
    icon: Settings,
    tip: "nav-settings",
    feature: "settings",
  },
  {
    to: "/changelog",
    label: "Changelog",
    icon: ScrollText,
    tip: "nav-changelog",
    feature: "changelog",
  },
] as {
  to: string;
  label: string;
  icon?: LucideIcon;
  tip: string;
  feature: string;
  badge?: boolean;
}[];


const NAV_LINK =
  "font-pixelify flex shrink-0 items-center gap-1.5 rounded border-[3px] px-2 py-1.5 md:px-2.5 lg:px-3 " +
  "text-sm font-semibold text-ink pixel-ease " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-gray-900";


// ============================================================
// APP LAYOUT
// ============================================================

export default function AppLayout() {

  const location = useLocation();
  const contentRef = useRef<HTMLElement | null>(null);

  const { mode, stateFor } = useSiteMode();
  const presenting = mode === "presentation";
  const { proPurchased } = useSun();
  const { prefs: layoutPrefs } = useLayoutPrefs();
  const { on: nerdOn, setOn: setNerdOn } = useNerdButtons();

  // ----------------------------------------------------------
  // Live library count for the nav badge
  // ----------------------------------------------------------

  const [libraryCount, setLibraryCount] = useState(0);

  // The saved garden frame colours the cheat console and dialogs on every page.
  useEffect(() => {
    applyStoredGardenFrame();
  }, []);

  useEffect(() => {
    getLibrary()
      .then((entries) => setLibraryCount(entries.length))
      .catch(() => setLibraryCount(0));
  }, []);

  // Refresh the badge whenever a paper is saved/removed.
  useEffect(() => {
    function handleLibraryChange() {
      getLibrary()
        .then((entries) => setLibraryCount(entries.length))
        .catch(() => setLibraryCount(0));
    }

    window.addEventListener("library-changed", handleLibraryChange);
    return () => window.removeEventListener("library-changed", handleLibraryChange);
  }, []);


  // ----------------------------------------------------------
  // Recommendation index state
  // ----------------------------------------------------------

  const [
    recommendationIndexStale,
    setRecommendationIndexStale,
  ] = useState(false);


  async function refreshRecommendationIndexStatus() {

    try {

      const status =
        await getRecommendationIndexStatus();

      setRecommendationIndexStale(
        status.stale
      );

    } catch (error) {

      console.error(
        "Failed to get recommendation index status:",
        error
      );

    }

  }


  useEffect(() => {

    // Check current index state when the
    // application layout loads.

    refreshRecommendationIndexStatus();


    // Listen for paper changes anywhere
    // in the application.

    function handleRecommendationIndexStale() {

      setRecommendationIndexStale(
        true
      );

    }


    window.addEventListener(
      "recommendation-index-stale",
      handleRecommendationIndexStale
    );


    return () => {

      window.removeEventListener(
        "recommendation-index-stale",
        handleRecommendationIndexStale
      );

    };

  }, []);


  function handleRebuilt() {

    setRecommendationIndexStale(
      false
    );

  }


  // ==========================================================
  // RENDER
  // ==========================================================

  return (

    <div
      data-site-mode={mode}
      id="app-shell"
      className="flex h-screen w-full flex-col overflow-hidden bg-canvas text-ink"
    >
      {!presenting && <LiveBackground />}


      {/* ======================================================
          TOP NAVIGATION
          3px ink outline · cream bar · accent = active fill
          ====================================================== */}

      <header className="flex shrink-0 items-center flex-wrap justify-between gap-2 border-b-[3px] md:flex-nowrap md:gap-4 border-gray-900 bg-canvas px-4 py-2.5 sm:px-6">

        {/* ----------------------------------------------------
            LEFT SIDE
            ---------------------------------------------------- */}

        <div className="contents md:flex md:min-w-0 md:items-center md:gap-3 lg:gap-8">


          {/* Logo — the animated slime mark + glitching pixel title */}

          <Link
            to="/repository"
            className="flex shrink-0 items-center gap-2.5"
          >

            <SlimeLogo />

            <p className="font-pixelify animate-glitch hidden text-base font-bold tracking-wide text-ink lg:block">
              RE:SEARCH
              <BlockCursor className="animate-blink ml-1 inline-block h-[0.9em] w-[0.55em] text-accent" />
            </p>

            {proPurchased && (
              <span
                title="Pro Pack owned"
                className="font-pixelify rounded border-[2px] border-gray-900 bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-none tracking-wide text-onAccent"
              >
                PRO
              </span>
            )}

          </Link>


          {/* Navigation */}

          <nav className="order-last flex min-w-0 basis-full items-center justify-between gap-1 overflow-x-auto md:order-none md:basis-auto md:justify-start">

            {navItems.map((item) => {
              const state = stateFor(item.feature);

              if (state === "hidden") {
                return null;
              }

              const locked = state === "locked";

              return (
              <NavLink
                key={item.to}
                to={item.to}
                data-tips={item.tip}
                data-feature-state={state}
                title={
                  locked
                    ? "Available in Researcher mode."
                    : item.label
                }
                aria-label={item.label}
                className={({ isActive }) =>
                  [
                    NAV_LINK,
                    locked
                      ? "opacity-55 hover:bg-transparent"
                      : isActive
                        ? "border-gray-900 bg-accent text-onAccent"
                        : "border-transparent hover:bg-accentSoft",
                  ].join(" ")
                }
              >

                {({ isActive }) => (
                  <>
                    {locked ? (
                      <Lock className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <>
                        {isActive && (
                          <ArrowRight className="animate-blink hidden h-2.5 w-2.5 shrink-0 md:block" />
                        )}
                        {item.icon && (
                          <item.icon
                            className={`h-4 w-4 shrink-0 md:h-3.5 md:w-3.5 ${
                              isActive ? "md:hidden" : "text-muted"
                            }`}
                            aria-hidden="true"
                          />
                        )}
                      </>
                    )}

                    {layoutPrefs.navLabels ? (
                      <span
                        className={
                          isActive ? "hidden md:inline" : "hidden xl:inline"
                        }
                      >
                        {item.label}
                      </span>
                    ) : (
                      <span className="sr-only">{item.label}</span>
                    )}

                    {item.feature === "lab" && mode !== "researcher" && (
                      <span className="rounded border-[2px] border-gray-900 bg-accent px-1 font-mono text-[9px] font-bold uppercase leading-4 tracking-wide text-onAccent">
                        Beta
                      </span>
                    )}


                    {item.badge && libraryCount > 0 && (

                      <span className="rounded border-[2px] border-gray-900 bg-white px-1.5 text-xs font-bold text-ink">

                        {libraryCount}

                      </span>

                    )}
                  </>
                )}

              </NavLink>
              );
            })}

          </nav>

        </div>


        {/* ----------------------------------------------------
            RIGHT SIDE — pipeline + theme color
            ---------------------------------------------------- */}

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">

          {/* Nerd buttons switch: on shows every Stats for Nerds control,
              off shatters them away everywhere. */}
          {!presenting && (
          <button
            type="button"
            role="switch"
            aria-checked={nerdOn}
            data-tips="nerd-switch"
            onClick={() => setNerdOn(!nerdOn)}
            title={
              nerdOn
                ? "Stats for Nerds buttons are showing. Click to remove them everywhere."
                : "Stats for Nerds buttons are hidden. Click to bring them back."
            }
            className="inline-flex items-center gap-1.5 rounded border-[3px] border-gray-900 bg-white px-2 py-1.5 sm:gap-2 sm:px-2.5 font-mono text-xs font-bold uppercase tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft"
          >
            <Sigma className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">NERD</span>
            <span className="sr-only sm:hidden">Nerd buttons</span>
            <span
              aria-hidden="true"
              className={`relative h-4 w-8 rounded-sm border-[2px] border-gray-900 transition-colors pixel-ease ${
                nerdOn ? "bg-accent" : "bg-canvas"
              }`}
            >
              <span
                className={`absolute top-[1px] h-2.5 w-2.5 border-[2px] border-gray-900 bg-white transition-all pixel-ease ${
                  nerdOn ? "left-[15px]" : "left-[1px]"
                }`}
              />
            </span>
          </button>
          )}

          {!presenting && <AccentPicker />}

        </div>

      </header>


      {/* ======================================================
          ARCADE ATTRACT TICKER
          ====================================================== */}

      {!presenting && <MarqueeTicker />}


      {/* ======================================================
          RECOMMENDATION INDEX ALERT
          ====================================================== */}

      <RecommendationIndexAlert
        visible={
          recommendationIndexStale
        }
        onRebuilt={
          handleRebuilt
        }
      />


      {/* ======================================================
          PAGE CONTENT
          ====================================================== */}

      {/* The pet is part of Pro in the shipped Presentation build. */}
      {(!presenting || proPurchased) && <PixelPet />}

      <main
        ref={contentRef}
        key={`page:${location.pathname}`}
        className="animate-route-in mx-auto w-full max-w-[1560px] overflow-y-auto px-3 py-5 sm:px-5"
      >

        {/* Pages are lazy chunks; the shell (nav, ticker, pet) stays mounted
            while one loads because <main> is keyed per route. */}
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>

      </main>

      <ScrollFollowPopup key={`scroll:${location.pathname}`} target={contentRef} />
      {presenting && <DevUnlock />}
      <ProPackHost />
      {!presenting && (
        <>
          <CheatFoliage />
          <CheatConsole />
          <StatsDrawer />
        </>
      )}
    </div>
  );

}

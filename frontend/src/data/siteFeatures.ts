/**
 * SITE FEATURES — metadata for the ten gated features.
 *
 * The backend stores only the per-feature state (shown / locked /
 * hidden, see app/services/site_config.py); everything a human reads
 * — labels, routes, blurbs, the pro/basic split — lives here so the
 * nav, the route gate, and the admin editor all agree.
 *
 * Keep the keys in sync with FEATURE_KEYS in the backend.
 */

export type SiteFeatureState = "shown" | "locked" | "hidden";

export type SiteFeatureKey =
  | "search"
  | "repository"
  | "library"
  | "faq"
  | "settings"
  | "changelog"
  | "upload"
  | "arena"
  | "lab"
  | "walkthrough"
  | "engine";

export interface SiteFeatureMeta {
  key: SiteFeatureKey;
  label: string;
  path: string;
  blurb: string;
  /** true = Researcher Mode capability (advertised as pro when locked) */
  pro: boolean;
}

export const SITE_FEATURES: SiteFeatureMeta[] = [
  {
    key: "search",
    label: "Search",
    path: "/recommendations",
    blurb: "Ranked paper search across the repository.",
    pro: false,
  },
  {
    key: "repository",
    label: "Repository",
    path: "/repository",
    blurb: "Browse, filter, and open cataloged papers.",
    pro: false,
  },
  {
    key: "library",
    label: "My Library",
    path: "/library",
    blurb: "Saved papers and reading lists.",
    pro: false,
  },
  {
    key: "faq",
    label: "FAQ",
    path: "/faq",
    blurb: "Answers about how the system works.",
    pro: false,
  },
  {
    key: "settings",
    label: "Settings",
    path: "/settings",
    blurb: "Citation style and other preferences.",
    pro: false,
  },
  {
    key: "changelog",
    label: "Changelog",
    path: "/changelog",
    blurb: "What changed recently.",
    pro: false,
  },
  {
    key: "upload",
    label: "Upload",
    path: "/upload",
    blurb: "Add papers by PDF, DOI, or BibTeX.",
    pro: true,
  },
  {
    key: "arena",
    label: "Arena",
    path: "/evaluation",
    blurb: "Battle six pipelines and compare rankings.",
    pro: true,
  },
  {
    key: "lab",
    label: "Lab",
    path: "/lab",
    blurb: "Tune weights live and grow the knowledge tree.",
    pro: true,
  },
  {
    key: "walkthrough",
    label: "Walkthrough",
    path: "/walkthrough",
    blurb: "Guided tour of the system.",
    pro: true,
  },
  {
    key: "engine",
    label: "Engine",
    path: "/walkthrough-engine",
    blurb: "How the ranking math works under the hood.",
    pro: true,
  },
];

const FEATURE_BY_KEY = new Map(
  SITE_FEATURES.map((feature) => [feature.key, feature])
);

export function featureByKey(
  key: string
): SiteFeatureMeta | undefined {
  return FEATURE_BY_KEY.get(key as SiteFeatureKey);
}

/**
 * Fallback map used before the public fetch lands (and if it fails).
 * Mirrors DEFAULT_LIBRARY_FEATURES on the backend.
 */
/**
 * Presentation mode ships the free version: the essentials only, and no
 * switch to flip. Anything not listed is hidden.
 */
export const PRESENTATION_FEATURES: Record<string, SiteFeatureState> = {
  search: "shown",
  repository: "shown",
  library: "shown",
  faq: "shown",
  // A plain Account and preferences page (no mode switch, no developer
  // controls): see the presentation branch of pages/Settings.tsx.
  settings: "shown",
  // The study's own scope: import, the six pipelines compared in the Arena,
  // and the math behind the ranking.
  upload: "shown",
  arena: "shown",
  engine: "shown",
};

export const DEFAULT_LIBRARY_FEATURES: Record<string, SiteFeatureState> = {
  search: "shown",
  repository: "shown",
  library: "shown",
  faq: "shown",
  settings: "shown",
  changelog: "shown",
  upload: "hidden",
  arena: "hidden",
  lab: "hidden",
  walkthrough: "hidden",
  engine: "hidden",
};

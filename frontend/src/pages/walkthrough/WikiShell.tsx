/**
 * WIKI SHELL — the frame around every page of the Re:Search wiki.
 *
 *   banner       the wiki's name, the two manuals as tabs, a search box
 *   left rail    Navigation (every page of this manual, grouped) and
 *                Contents (the headings of this page)
 *   article      breadcrumb, title, categories, the page, previous / next
 *   main page    a card for every page of the manual
 *
 * The page content comes from the registry in wikiPages.tsx. The Walkthrough
 * lives at /walkthrough/<page>, the Engine at /walkthrough-engine/<page>.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";

import { useSiteMode } from "../../state/siteMode";
import {
  PAGES,
  WIKIS,
  groupsOf,
  pageUrl,
  pagesOf,
  type WikiId,
  type WikiPage,
} from "./wikiPages";
import { shotUrl } from "./shots";
import "./walkthrough.css";
import "./engine.css";
import { WikiMediaProvider, WikiNavbox } from "./wikiMedia";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

function useHeadings(key: string): Heading[] {
  const [headings, setHeadings] = useState<Heading[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const found: Heading[] = [];

      const tops = document.querySelectorAll<HTMLElement>("[data-wiki-article] section[id] > h2");

      // A page with a single top-level section is already titled by its h1.
      if (tops.length === 1) tops[0].classList.add("hidden");

      document.querySelectorAll<HTMLElement>("[data-wiki-article] section[id]").forEach((section) => {
        const heading = section.querySelector(":scope > h2:not(.hidden), :scope > h3");

        if (!heading) return;

        found.push({
          id: section.id,
          text: heading.textContent ?? section.id,
          level: heading.tagName === "H2" ? 2 : 3,
        });
      });

      setHeadings(found);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [key]);

  return headings;
}

function SearchBox({ accessible }: { accessible: WikiId[] }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (needle.length < 2) return [];

    return PAGES.filter(
      (page) =>
        accessible.includes(page.wiki) &&
        `${page.title} ${page.summary} ${page.categories.join(" ")} ${page.group}`
          .toLowerCase()
          .includes(needle),
    ).slice(0, 8);
  }, [query, accessible]);

  return (
    <div className="relative w-full sm:w-64">
      <label htmlFor="wiki-search" className="sr-only">
        Search the wiki
      </label>
      <input
        id="wiki-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the wiki…"
        autoComplete="off"
        className="min-h-9 w-full rounded border-[3px] border-gray-900 bg-field px-2.5 text-sm text-ink placeholder:text-muted"
      />
      {results.length > 0 && (
        <ul className="absolute right-0 top-full z-30 mt-1 w-[min(22rem,calc(100vw-4rem))] overflow-hidden rounded border-[3px] border-gray-900 bg-white shadow-[4px_4px_0_rgba(0,0,0,0.2)]">
          {results.map((page) => (
            <li key={`${page.wiki}/${page.slug}`} className="border-b border-gray-200 last:border-b-0">
              <Link
                to={pageUrl(page)}
                onClick={() => setQuery("")}
                className="block px-3 py-2 transition-colors pixel-ease hover:bg-accentSoft"
              >
                <span className="block text-sm font-bold text-ink">{page.title}</span>
                <span className="block text-xs text-muted">
                  {WIKIS[page.wiki].name} · {page.summary}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Rail({
  wiki,
  current,
  headings,
  open,
}: {
  wiki: WikiId;
  current: WikiPage;
  headings: Heading[];
  open: boolean;
}) {
  const prefix = wiki === "engine" ? "eng" : "wt";

  return (
    <aside
      id="wiki-rail"
      aria-label="Wiki navigation"
      className={`${prefix}-rail ${open ? "" : "max-lg:hidden"} lg:sticky lg:top-4 lg:h-fit lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto`}
    >
      <nav className="overflow-hidden rounded border-[3px] border-gray-900 bg-white">
        <p className="border-b-[3px] border-gray-900 bg-gray-900 px-3 py-2 font-mono text-xs font-bold tracking-[0.2em] text-onInk">
          {WIKIS[wiki].name.toUpperCase()}
        </p>
        <div className="space-y-3 p-3">
          {groupsOf(wiki).map(([group, pages]) => (
            <div key={group}>
              <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                {group}
              </p>
              <ul className="space-y-0.5">
                {pages.map((page) => {
                  const active = page.slug === current.slug;

                  return (
                    <li key={page.slug}>
                      <Link
                        to={pageUrl(page)}
                        aria-current={active ? "page" : undefined}
                        className={`block rounded px-2 py-1 text-xs font-bold transition-colors pixel-ease ${
                          active
                            ? "bg-accent text-onAccent"
                            : "text-ink hover:bg-accentSoft"
                        }`}
                      >
                        {page.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      {headings.length > 1 && (
        <nav
          aria-label="On this page"
          className="mt-4 overflow-hidden rounded border-[3px] border-gray-900 bg-white"
        >
          <p className="border-b-[3px] border-gray-900 bg-surface px-3 py-2 font-mono text-xs font-bold tracking-[0.2em] text-ink">
            ON THIS PAGE
          </p>
          <ol className="max-h-[40vh] space-y-0.5 overflow-y-auto p-3 font-mono text-xs">
            {headings.map((heading) => (
              <li key={heading.id} className={heading.level === 3 ? "pl-3" : `${prefix}-top`}>
                <a
                  href={`#${heading.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(heading.id)?.scrollIntoView({ block: "start" });
                  }}
                  className="block rounded px-1 py-0.5 text-ink transition-colors pixel-ease hover:bg-accentSoft hover:text-accent"
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </aside>
  );
}

function PortalCards({ wiki }: { wiki: WikiId }) {
  return (
    <div className="space-y-6">
      {groupsOf(wiki)
        .map(([group, pages]) => [group, pages.filter((page) => page.slug !== "main")] as const)
        .filter(([, pages]) => pages.length > 0)
        .map(([group, pages]) => (
          <section key={group} className="clear-both">
            <h2 className="border-b-[3px] border-gray-900 pb-1 text-xl font-bold tracking-tight text-ink">
              {group}
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {pages.map((page) => (
                <Link
                  key={page.slug}
                  to={pageUrl(page)}
                  className="group flex flex-col overflow-hidden rounded border-[3px] border-gray-900 bg-white transition-transform pixel-ease hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(0,0,0,0.2)]"
                >
                  {page.thumb && (
                    <img
                      src={shotUrl(page.thumb)}
                      alt=""
                      loading="lazy"
                      className="aspect-[16/9] w-full border-b-[3px] border-gray-900 bg-canvas object-cover object-top"
                    />
                  )}
                  <span className="flex flex-1 flex-col gap-1 p-3">
                    <span className="font-pixelify text-sm font-bold text-ink group-hover:text-accent">
                      {page.title}
                    </span>
                    <span className="text-xs leading-5 text-muted">{page.summary}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

export default function WikiShell({ wiki }: { wiki: WikiId }) {
  const { page: slugParam } = useParams();
  const { hash, pathname } = useLocation();
  const { canAccess } = useSiteMode();
  const pages = pagesOf(wiki);
  const slug = slugParam ?? "main";
  const current = pages.find((page) => page.slug === slug);
  const accessible = (Object.keys(WIKIS) as WikiId[]).filter((id) => canAccess(WIKIS[id].feature));
  const headings = useHeadings(pathname);
  const [railOpen, setRailOpen] = useState(false);
  const prefix = wiki === "engine" ? "eng" : "wt";

  // A new page folds the chapter list away again on phones.
  useEffect(() => setRailOpen(false), [pathname]);

  // New page: back to the top, or to the heading in the address.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (hash) {
        document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
      } else {
        document.querySelector("main")?.scrollTo({ top: 0 });
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [pathname, hash]);

  if (!current) return <Navigate to={WIKIS[wiki].base} replace />;

  const index = pages.indexOf(current);
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const navbox = groupsOf(wiki).map(
    ([group, list]) => [group, list.map((p) => [pageUrl(p), p.title] as const)] as const,
  );

  return (
    <WikiMediaProvider>
      <div className={`${prefix}-shell mx-auto w-full px-4 py-6 sm:px-6`}>
        {/* ------------------------------------------------ banner */}
        <header className={`${prefix}-banner mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded border-[3px] border-gray-900 bg-white px-4 py-3`}>
          <Link to={WIKIS[wiki].base} className="font-pixelify text-lg font-bold leading-none text-ink">
            Re:Search <span className="text-accent">Wiki</span>
          </Link>
          <nav aria-label="Manuals" className="flex gap-1.5">
            {accessible.map((id) => (
              <Link
                key={id}
                to={WIKIS[id].base}
                aria-current={id === wiki ? "page" : undefined}
                className={`rounded border-[3px] border-gray-900 px-3 py-1 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-colors pixel-ease ${
                  id === wiki ? "bg-accent text-onAccent" : "bg-white text-ink hover:bg-accentSoft"
                }`}
              >
                {WIKIS[id].name}
              </Link>
            ))}
          </nav>
          <p className={`${prefix}-stamp`} aria-hidden="true">
            {wiki === "engine" ? "DWG · BLUEPRINT" : "FIELD GUIDE"}
          </p>
          <div className="ml-auto">
            <SearchBox accessible={accessible} />
          </div>
        </header>

        <div className={`${prefix}-grid`}>
          <button
            type="button"
            aria-expanded={railOpen}
            aria-controls="wiki-rail"
            onClick={() => setRailOpen((value) => !value)}
            className={`${prefix}-railtoggle lg:hidden`}
          >
            <span>{wiki === "engine" ? "Sheet index" : "Chapters"}</span>
            <span className="truncate">{current.title}</span>
            <span aria-hidden="true">{railOpen ? "▴" : "▾"}</span>
          </button>
          <Rail wiki={wiki} current={current} headings={headings} open={railOpen} />

          {/* ------------------------------------------------ article */}
          <article data-wiki-article className={`${prefix}-article min-w-0`}>
            <nav aria-label="Breadcrumb" className="mb-2 font-mono text-xs text-muted">
              <Link to={WIKIS[wiki].base} className="hover:text-accent">
                Wiki
              </Link>
              {" › "}
              <Link to={WIKIS[wiki].base} className="hover:text-accent">
                {WIKIS[wiki].name}
              </Link>
              {current.slug !== "main" && (
                <>
                  {" › "}
                  <span className="font-bold text-ink">{current.title}</span>
                </>
              )}
            </nav>

            <p className={`${prefix}-eyebrow`}>
              {wiki === "engine"
                ? `Sheet ${String(index + 1).padStart(2, "0")} of ${String(pages.length).padStart(2, "0")}`
                : `Chapter ${index + 1} of ${pages.length}`}
              {" · "}
              {current.group}
            </p>
            <h1 className="text-3xl font-bold leading-none tracking-tighter text-ink sm:text-4xl">
              {current.slug === "main" ? `The Re:Search ${WIKIS[wiki].name}` : current.title}
            </h1>
            <p className="mt-2 text-sm italic text-muted">
              {current.slug === "main" ? WIKIS[wiki].tagline : current.summary}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {current.categories.map((category) => (
                <span
                  key={category}
                  className="rounded border-2 border-gray-900 bg-surface px-2 py-0.5 font-mono text-[11px] font-bold text-muted"
                >
                  Category: {category}
                </span>
              ))}
            </div>

            <div className={`${prefix}-flow mt-6`}>
              {current.render()}

              {current.slug === "main" && <PortalCards wiki={wiki} />}

              {/* ------------------------------------------------ pager */}
              <nav aria-label="Previous and next page" className="clear-both grid gap-3 sm:grid-cols-2">
                {previous ? (
                  <Link
                    to={pageUrl(previous)}
                    className="rounded border-[3px] border-gray-900 bg-white p-3 transition-colors pixel-ease hover:bg-accentSoft"
                  >
                    <span className="block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                      ← Previous
                    </span>
                    <span className="block text-sm font-bold text-ink">{previous.title}</span>
                  </Link>
                ) : (
                  <span />
                )}
                {next && (
                  <Link
                    to={pageUrl(next)}
                    className="rounded border-[3px] border-gray-900 bg-white p-3 text-right transition-colors pixel-ease hover:bg-accentSoft sm:col-start-2"
                  >
                    <span className="block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                      Next →
                    </span>
                    <span className="block text-sm font-bold text-ink">{next.title}</span>
                  </Link>
                )}
              </nav>

              <WikiNavbox title={`${WIKIS[wiki].name} pages`} groups={navbox} />

              <footer className="flex flex-wrap items-center justify-between gap-3 rounded border-[3px] border-gray-900 bg-white p-4">
                <p className="font-mono text-xs font-bold tracking-[0.2em] text-muted">
                  RE:SEARCH WIKI · {WIKIS[wiki].name.toUpperCase()}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/changelog"
                    className="rounded border-[3px] border-gray-900 bg-surface px-3 py-1.5 font-mono text-xs font-bold tracking-[0.15em] text-ink transition-colors pixel-ease hover:bg-accentSoft"
                  >
                    SEE THE CHANGELOG
                  </Link>
                  <Link
                    to={wiki === "engine" ? "/evaluation" : "/repository"}
                    className="rounded border-[3px] border-gray-900 bg-accent px-3 py-1.5 font-mono text-xs font-bold tracking-[0.15em] text-onAccent"
                  >
                    {wiki === "engine" ? "OPEN THE ARENA" : "START SEARCHING"}
                  </Link>
                </div>
              </footer>
            </div>
          </article>
        </div>
      </div>
    </WikiMediaProvider>
  );
}

/**
 * The walkthrough's screenshot catalog.
 *
 * Every image the Walkthrough and Engine pages show is listed here once,
 * with its title and caption, in reading order. `shotUrl(id)` is the file
 * under /public/walkthrough. All of them were captured from the running
 * app in Researcher (Pro) mode with the Indigo theme (light mode), the
 * garden fully grown and every unlock switched on, at 1440 px wide unless
 * noted.
 */

export interface Shot {
  id: string;
  title: string;
  caption: string;
  /** File extension under /public/walkthrough; "png" unless set (animated shots use "gif"). */
  ext?: string;
}

const S = (id: string, title: string, caption: string): Shot => ({ id, title, caption });
/** An animated shot: a looping GIF captured from the running app. */
const G = (id: string, title: string, caption: string): Shot => ({ id, title, caption, ext: "gif" });

export const SHOTS: Shot[] = [
  /* ---------------------------------------------------------- start */
  S("login", "Sign in", "The sign-in card. The prototype runs in single-user local mode, so any well-formed email and password open it."),
  S("register", "Create an account", "Registration asks for a name, email and password, then lands in the app like a sign-in does."),
  S("forgot-password", "Forgot password", "The reset page. In local mode it only explains what would happen on a hosted deployment."),
  S("boot-typing", "Boot screen: typing", "The arcade boot screen types the title out, one character at a time, once per browser session."),
  S("boot-press-start", "Boot screen: press start", "When the title finishes, PRESS START blinks. Click anywhere or press any key to enter."),
  S("home-researcher", "Home", "The home page: a search box that sends a query straight to the Recommend scope, announcements from the library staff, and shortcut cards."),
  S("theme-picker", "Theme picker", "The palette button at the right of the top bar opens the theme popover over the page."),
  S("theme-picker-popover", "The theme popover", "Twelve accent palettes (Amber is the default) and a Light / Dark switch. The choice is remembered per browser."),
  S("nerd-switch-on", "The NERD switch", "The switch beside the theme button. On, every Stats for Nerds control is visible."),
  S("nerd-switch-off", "The NERD switch, off", "Off, the Stats for Nerds buttons and tabs are removed from every page."),
  S("nerd-shatter", "The shatter", "Switching off breaks each Stats for Nerds control into pixels that tumble away. Switching on again glitches them back in."),
  S("repository-nerd-off", "Repository with the nerd buttons off", "The same page with the switch off: no Stats for Nerds button and no side pane."),

  /* --------------------------------------------------------- modes */
  S("mode-library-home", "Library mode: home", "Library mode is the visitor-facing librarian: a calm home page and only the tabs the site editor enabled."),
  S("mode-library-repository", "Library mode: repository", "The same repository with the trimmed navigation: Repository, My Library, FAQ, Settings, Changelog."),
  S("mode-library-locked-pro", "Library mode: My Library", "Without Pro the Dashboard, Graph and Chat tabs are locked and the research chat explains why."),
  S("mode-library-gate", "A feature gate", "A page outside the library lineup shows a gate with a switch to Researcher mode and a way back home."),
  S("mode-presentation-repository", "Presentation mode: repository", "The shipped build: no developer controls, the formal pipeline names, and only the study's own features."),
  S("mode-presentation-arena", "Presentation mode: Arena", "The Arena in the shipped build, with its arcade wording replaced by plain terms (Run Arena, Win tally)."),
  S("mode-presentation-library", "Presentation mode: My Library", "The free version: Pro tabs are locked, with neutral copy."),
  S("mode-presentation-engine", "Presentation mode: Engine", "The Engine page, whose figures use the formal pipeline names."),
  S("mode-presentation-unlock", "Leaving Presentation mode", "Holding P + R + O together opens a password pop-up. The right word returns the site to Researcher mode."),

  /* ----------------------------------------------------- repository */
  S("repository", "Repository", "The three-pane workspace: filter console on the left, the document table in the middle, the inspector rail on the right."),
  S("repository-filters", "Filter console", "Search scope, the text filter, library views, author, subject, category, type and year filters."),
  S("repository-authors", "Filter by authors", "The authors section expands into a scrollable list with counts; pick one to narrow the table."),
  S("repository-list", "Paper table", "Title with subject and category chips, authors, year, date added and type. Star a row to favorite it; tick rows to select."),
  S("repository-algorithm-collapsed", "Algorithm bar", "At rest the algorithm console is a single line: the active pipeline's weight bar and name."),
  S("repository-algorithm-open", "Algorithm bar, open", "Change opens the six presets, the custom mix and (in Recommend scope) Top K and Diversify."),
  S("repository-algorithm-dials", "Custom dials", "The custom blend popover: drag the dot on the triangle toward a signal, or use the three dials. The shares normalize to 100% and the resulting formula is printed."),
  S("repository-search-library", "Library search", "Typing in the Library scope filters the table live and highlights the matched words in the snippet."),
  S("repository-recommend", "Recommend scope", "A query ranked by the active pipeline: a score bar per row, Top K and Diversify beside the algorithm buttons."),
  S("repository-recommend-ghost-wire", "Another algorithm, same query", "Pressing GHOST WIRE (S-BERT) re-ranks the same query at once; the header names the algorithm that produced the list."),
  S("repository-web", "Web scope", "Live hits from OpenAlex, Crossref and arXiv, ranked by the active algorithm, each with its rank, score and a one-click Import."),
  S("repository-web-ghost-wire", "Web results, re-ranked", "The same web query after pressing another algorithm: the order and the scores change, the candidates do not."),
  S("repository-inspector", "Inspector", "Selecting a row opens the inspector with the abstract and metadata."),
  S("repository-inspector-notes", "Inspector: Notes", "A private notes field for each paper, saved as you type."),
  S("repository-inspector-pdf", "Inspector: PDF", "A preview of the stored PDF with buttons to open it in the viewer, open it full size or delete the file."),
  S("repository-inspector-similar", "Inspector: Similar", "The similar-papers graph for the selected paper, with edge modes, cluster guides and a minimum-strength slider."),
  S("repository-stats-for-nerds", "Stats for Nerds pane", "A live snapshot of the corpus and the exact computation trace for the current search."),
  S("repository-layout-list", "Layout: List", "The table alone, full width."),
  S("repository-layout-filters", "Layout: Filters", "Filter console and table, with the inspector folded away."),
  S("repository-layout-details", "Layout: Details", "Table and inspector, with the filter console folded away."),
  S("repository-context-menu", "Row context menu", "Right-click a row for update details, open file, collections, mark as and delete."),
  S("repository-narrow", "Narrow window", "Below about 720 px the table collapses into two-line rows with a Sort control; nothing scrolls sideways."),
  S("repository-narrow-filters", "Narrow window: filters", "On narrow screens the filter console hides behind a Filters button."),

  /* --------------------------------------------------------- upload */
  S("upload", "Upload", "A drop zone for PDF, BibTeX, RIS and EndNote files, an identifier box (DOI or arXiv) and the BibTeX export guide."),
  S("upload-identifier-typed", "Lookup by identifier", "Paste a DOI, an arXiv id or a link; Look up fetches the metadata."),
  S("upload-identifier-review", "Review form", "The record resolved from arXiv 1706.03762, ready to correct. A banner warns when the paper is already in the repository."),
  S("upload-pdf-review", "Review form from a PDF", "Dropping a PDF extracts title, authors, abstract and keywords heuristically; you correct them before saving."),
  S("upload-bibtex-popup", "Paste BibTeX manually", "Paste one or many BibTeX entries; each is parsed into the review navigator."),

  /* -------------------------------------------------------- library */
  S("library", "My Library", "The personal shortlist: four tabs, an ask box, filters, a search box and the saved papers."),
  S("library-grid", "Grid view", "The same papers as cards, with their snippets."),
  S("library-search", "Search the collection", "The collection filter narrows the saved papers as you type."),
  S("library-filter-pdf", "Filter: with PDF", "Quick filters: all, with PDF, recent (2023+) and unsorted."),
  S("library-selection", "Selecting papers", "Ticked papers feed the Dashboard, Graph and Chat; a bar counts them and can clear the selection."),
  S("library-dashboard", "Dashboard", "Counts, papers by publication year, subjects, most cited, newest and document types for the collection."),
  S("library-graph", "Graph tab", "Pick a paper on the left and the graph shows its nearest neighbors in the repository."),
  S("library-graph-selected", "Graph with cluster guides", "Similar papers grouped into colored zones; animated leader lines end in circles and name each cluster."),
  S("library-chat", "Chat tab", "Ask across the collection, the repository or the web; answers cite the sources they used."),
  S("library-chat-answer", "Chat answer", "An answer with numbered citations and an Open in Library button under each source."),

  /* ---------------------------------------------------------- arena */
  S("arena", "Arena", "The arcade cabinet: query, depth and the high-score board, with the battle log below."),
  S("arena-cabinet", "The cabinet", "Player one types a query, picks a depth (Top 5, 10 or 15) and presses start; the board keeps the tally of decisive wins."),
  S("arena-query-typed", "A query typed", "The Repository / Web scope switch sits above the query line."),
  S("arena-battling", "Battle in progress", "The meter fills as each pipeline actually finishes (n of 6 done), with the finished pipelines and their top results listed."),
  S("arena-result", "Battle complete", "When the battle ends the board updates and the result tabs appear below."),
  S("arena-winner", "01 Winner", "The pipeline that captured the largest share of independence-weighted consensus, and that share. A lead of under two points is shown as too close to call."),
  S("arena-consensus", "02 Consensus", "Papers ordered by how many of the six pipelines ranked them, then by average rank."),
  S("arena-pairwise", "03 Pairwise", "For each pair of pipelines: overlap at K and the mean rank gap."),
  S("arena-battle-grid", "04 Battle grid", "Every paper's rank under every pipeline; empty cells mark papers that missed the top K."),
  S("arena-scores", "05 Scores", "Score distribution by rank position, each pipeline scaled against the highest score."),
  S("arena-interpretation", "06 Interpretation", "A citation-ready paragraph describing the run in APA 7 and MLA 9."),
  S("arena-history", "Battle log", "Every recorded run, newest first, with the winner and its share, a winner-score spread and pagination."),
  S("arena-web-mode", "Web scope", "Switch the field to the live web: the same six pipelines rank OpenAlex, Crossref and arXiv hits. Web battles are never recorded."),

  /* ------------------------------------------------------------ lab */
  S("lab", "Lab: recipe bench", "Three dials, saved recipes and presets, and a leaderboard."),
  S("lab-simulated", "A simulated battle", "A recipe fights the six presets on a query; the leaderboard records the champion."),
  S("lab-stats-for-nerds", "Lab: Stats for Nerds", "The computation trace of the recipe on your query."),

  /* --------------------------------------------------------- garden */
  S("lab-garden", "The Garden", "The Tree of Knowledge: a carved menu above a pixel meadow and the tree."),
  S("garden-card", "The tree card", "Menu, canvas and the action bar of the garden card at 1,000 ft."),
  S("garden-menu", "The carved menu", "Seed bank (species cards), Feed (growth and fertilizer), Almanac (charms, scene, earn) and Shop."),
  S("garden-stage-seed", "Stage 1: Seed", "A winged seed on the meadow."),
  S("garden-stage-seedling", "Stage 2: Seedling", "The first shoot and its first leaves; the status line reads Sprout."),
  S("garden-stage-sapling", "Stage 3: Sapling", "A slender trunk and a small round crown."),
  S("garden-stage-young", "Stage 4: Young", "A full crown on a thickening trunk."),
  S("garden-stage-mature", "Stage 5: Mature", "The camera climbs in: bark, roots and moss show at this scale."),
  S("garden-stage-ancient", "Stage 6: Giant", "The trunk towers; branches, hanging vines and sylphs line the ascent."),
  S("garden-stage-summit", "Stage 7: Ancient", "The crown at the top of the climb, with clouds, twigs and a great many leaves."),
  S("garden-species-oak", "Royal Oak", "Lobed leaves and a furrowed, dark trunk."),
  S("garden-species-birch", "Silver Birch", "Pale peeling bark and small, pointed leaves."),
  S("garden-species-elm", "American Elm", "Lopsided leaves and a netted, ridged bark."),
  S("garden-species-redwood", "Giant Redwood", "Needle sprays and a tall, fibrous, red-brown trunk."),
  S("garden-species-beanstalk", "Jack's Beanstalk", "A slim, swaying stalk of broad heart-shaped leaves that climbs into a bank of cloud."),
  S("garden-species-rosevine", "Rose Supervine", "A thorny rose shrub grown into a vine: cream thorns on dark canes and crimson and pink blooms."),
  S("garden-almanac-charms", "Almanac: Charms", "Five charms per tree, unlocked by height, each with its own cheat word."),
  S("garden-almanac-armed", "Almanac: all charms on", "Flip a peg to arm a charm; its tag lights up amber."),
  S("garden-almanac-scene", "Almanac: Scene", "Free switches for the garden's ordinary scenery, grouped, with a particles section that is off by default."),
  S("garden-charms-on", "Charms at work", "Maple keys, a creeper, a squirrel, ember glow and a sap bucket on the maple, with a pop-up for each switch."),
  S("garden-earn", "Earn sun", "How the daily visit, petting, help questions, treasures, achievements and tips pay out."),
  S("garden-sun-shop", "Sun shop", "Fertilizer in three sizes, bought with sun or growth tokens."),
  S("garden-skins", "Tree skins", "Buy a species with growth tokens and plant it."),
  S("garden-themes", "Theme shop", "Seven backdrop scenes, from Meadow to Frost Spire."),
  S("garden-dev", "Developer tab", "Test wallet, the Pro override and the hidden looks list."),
  S("garden-tree-info", "Tree info", "The species dossier and the facts the tree has taught you so far."),
  S("garden-ask", "Asking the tree", "Each question returns a fact you have already unlocked; ask too often and the tree grumbles."),
  G("garden-growth", "Growth, animated", "A looping capture of the stage chips: the seed sprouts and the tree climbs through every stage to the ancient crown while the camera follows it up the trunk."),
  G("garden-growth-birch", "Silver Birch growing", "The birch's white peeling bark and toothed leaves, from seed to the top of the climb."),
  G("garden-growth-elm", "American Elm growing", "The elm's netted trunk and golden crown as it climbs through the stages."),
  G("garden-growth-redwood", "Giant Redwood growing", "A narrow conifer on a red fibrous trunk that opens into sprays of needles at the top."),
  G("garden-growth-beanstalk", "Jack's Beanstalk growing", "A slim twisting stalk that climbs into the clouds and ends at the giant's castle."),
  G("garden-growth-rosevine", "Rose Supervine growing", "A rose shrub thickening into a thorny vine, ending at the briar rose castle."),

  /* ------------------------------------------------------------ pet */
  S("pet-idle", "The pixel pet", "The resident companion sits at the bottom right and speaks in two voices."),
  S("pet-close", "The pet, close up", "A Japanese line always carries its translation."),
  S("pet-tip", "The pet's tip panel", "Click the pet for the next tip; the panel can also hold the demo sign-in note."),
  S("pet-menu", "The pet menu", "Double-click for the menu: tips, forms, size, docking and reset."),
  S("hunt-glint", "A hidden treasure", "A faint glint on a page: click it to collect the treasure."),

  /* ------------------------------------------------------ settings */
  S("settings", "Settings: Preferences", "Site mode, interface labels and the preferred citation style."),
  S("settings-developer", "Settings: Developer", "The control panel for every customization: cheat console, hidden looks and more."),
  S("cheat-console", "The cheat console", "Press the backquote key anywhere to open it, then type a cheat word."),
  S("skin-pocket-green", "Look: pocket green (dmg)", "The whole app as a handheld's four-shade green screen."),
  S("skin-lumberyard", "Look: lumberyard (lumber)", "Warm oak boards and carved edges."),
  S("skin-phosphor", "Look: phosphor (matrix)", "Green phosphor on black, like an old terminal."),
  S("skin-blueprint", "Look: blueprint (drafting)", "White ink on blueprint blue, with a drawing grid."),
  S("skin-neon-horizon", "Look: neon horizon (neon)", "Magenta and violet with a glowing horizon."),
  S("skin-parchment", "Look: old parchment (scroll)", "Sepia pages and serif type."),
  S("skin-scanlines", "Effect: scanlines", "A faint CRT scanline vignette over the pages."),
  S("skin-pixel-type", "Effect: pixel type", "Pixel type for headings and body."),
  S("skin-diorama", "Effect: live diorama", "The garden's scene lives behind the pages, kept legible."),
  S("wallpaper-pocket-green", "Wallpaper: Pocket Green", "A Nokia-style handheld plays itself: Snake, a Space Impact shooter, a bouncing ball, drifting icons and a boy with his dog."),
  S("wallpaper-lumberyard", "Wallpaper: Lumberyard", "A sawmill wall: a lumberjack chops a stump, a circular saw throws sawdust, a log rolls by and a woodpecker taps."),
  S("wallpaper-phosphor", "Wallpaper: Phosphor", "Digital rain: columns of flickering glyphs with a bright head, and a blinking cursor."),
  S("wallpaper-blueprint", "Wallpaper: Blueprint", "A drafting table inks itself in white: a compass sweeps a circle, a floor plan with dimension lines, meshing gears and a set square."),
  S("wallpaper-neon-horizon", "Wallpaper: Neon Horizon", "A synthwave sunset: a striped sun, outlined mountains, a perspective grid racing toward you, swaying palms and a passing saucer."),
  S("wallpaper-old-parchment", "Wallpaper: Old Parchment", "A scriptorium by candlelight: a quill writes script that fades, a shaft of dusty light, a flickering candle with a moth."),
  S("changelog", "Changelog", "Release notes, newest first, as a timeline."),
  S("changelog-grid", "Changelog: grid", "The same notes as cards."),
  S("faq", "FAQ", "Short answers to the common questions."),

  /* --------------------------------------------------------- mobile (390 x 844, 2x) */
  S("mobile-boot", "Phone: boot screen", "The arcade boot screen at phone width; the title wraps onto four lines."),
  S("mobile-login", "Phone: sign in", "The sign-in card fills the width."),
  S("mobile-home", "Phone: home", "Icon-only top bar, the search box and the announcements stack in one column."),
  S("mobile-nav", "Phone: icon-only top bar", "Labels are hidden and shown as tooltips; the bar scrolls sideways (top: start, bottom: scrolled to the end for Settings and Changelog)."),
  S("mobile-repository", "Phone: repository", "The paper table folds into two-line rows with a Sort control."),
  S("mobile-repository-inspector", "Phone: inspector", "Selecting a row opens the inspector below the list, with Details, Notes, PDF and Similar tabs."),
  S("mobile-recommend", "Phone: recommend", "Ranked results keep the title and the score bar; authors, year and type are dropped."),
  S("mobile-library", "Phone: My Library", "The Pro library with its tabs, ask box, filters and saved papers."),
  S("mobile-upload", "Phone: upload", "The drop zone and the identifier box stacked."),
  S("mobile-upload-link-drop", "Phone: link drop", "Dragging a citation link over the drop zone shows DROP HERE and offers to import the link."),
  S("mobile-lab", "Phone: lab", "The recipe bench's dials and formula."),
  S("mobile-garden", "Phone: garden", "The carved menu stacks above the tree stage; the Tree info card starts folded."),
  S("mobile-garden-fullscreen", "Phone: the tree, full screen", "The full-screen button gives the stage the whole screen, with Menu and Exit at the top."),
  S("mobile-arena", "Phone: arena", "The cabinet at phone width: field, query, depth and Press start."),
  S("mobile-settings", "Phone: settings", "Preferences with the site mode picker."),
];

const BY_ID = new Map(SHOTS.map((shot) => [shot.id, shot]));

export const shotById = (id: string): Shot | undefined => BY_ID.get(id);

export const shotUrl = (id: string): string => `/walkthrough/${id}.${BY_ID.get(id)?.ext ?? "png"}`;

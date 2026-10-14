import { Chip, WikiCite, WikiSection, WikiSub, WikiTable } from "../wiki";
import { P, WikiGallery, WikiHatnote, WikiNote, WikiThumb, Xref } from "../wikiMedia";

export function RepositoryPage() {
  return (
      <WikiSection id="repository" title="Repository">
        <WikiThumb id="repository" width={420} />
        <P>
          The Repository is the working surface of the system: it browses the stored corpus, searches
          it three ways and shows the engine's rankings, all on one screen. It reads the same SQLite
          database the recommendation engine uses, so a paper you edit here changes its next ranking
          after the index is rebuilt. The screen has three panes, each of which can be resized by
          dragging the thin handle between them: the <Chip>filter console</Chip> on the left, the{" "}
          <Chip>paper table</Chip> in the middle and a collapsible <Chip>inspector</Chip> on the right.
          Above them sit the page header, the layout switcher and the algorithm bar.
        </P>

        <WikiSub id="repo-header" title="The header and layout presets">
          <P>
            The header shows the page name and a one-line summary that follows what you are doing
            ("155 papers. Pick one to open its record.", "Ranked recommendations · FINAL BOSS.",
            "Web search · legitimate sources…"). At its right: <Chip>Stats for Nerds</Chip>, a{" "}
            <Chip>Layout</Chip> switch with four presets, and <Chip>Upload paper</Chip>.
          </P>
          <WikiTable
            headers={["Layout", "Panes shown", "Use it for"]}
            rows={[
              [<Chip key="f">Full</Chip>, "Filters, table and inspector", "Everyday work; the default."],
              [<Chip key="l">List</Chip>, "The table alone", "Scanning many rows; a wide table shows every column."],
              [<Chip key="fi">Filters</Chip>, "Filters and table", "Narrowing a large corpus without the inspector's width."],
              [<Chip key="d">Details</Chip>, "Table and inspector", "Reading one paper after another."],
            ]}
          />
          <WikiGallery cols={3} ids={["repository-layout-list", "repository-layout-filters", "repository-layout-details"]} />
        </WikiSub>

        <WikiSub id="repo-filters" title="The filter console">
          <WikiThumb id="repository-filters" width={230} />
          <P>
            The console is a stack of controls that all work together; the table updates as you
            touch them and the count in its header follows.
          </P>
          <WikiTable
            headers={["Control", "What it does"]}
            rows={[
              ["Search in", "Chooses the scope: Library (your stored papers), Recommend (rank the corpus with an algorithm) or Web (live scholarly sources). See the next sections."],
              ["Search", "A live text filter over title, author, keywords and abstract with BM25 ranking and highlighted snippets."],
              ["My Library", "System views: All Documents, Recently Added, Favorites (the star) and Unsorted (no subject yet), each with a count."],
              ["Filter by authors", "Collapsed by default; expands to a counted, scrollable author list. Picking one filters the table."],
              ["Subject / Category / Document type", "Dropdowns built from the corpus. A subject is the broad field (Computer Science, Mathematics); a category is the finer label (Machine Learning, Graph Theory)."],
              ["Year range", "From and To; blank means open-ended."],
            ]}
          />
          <WikiCite ids={["arxiv-taxonomy"]} />
          <WikiThumb id="repository-authors" float="left" width={230} />
          <P>
            Subjects and categories come from the upload pipeline's classifier, which maps arXiv
            categories and keyword evidence to a <Chip>Subject: Category</Chip> label when none is
            given. Papers it cannot place appear under <Chip>Unsorted</Chip> so they are easy to
            find and fix.
          </P>
        </WikiSub>

        <WikiSub id="repo-algorithm" title="The algorithm bar">
          <WikiThumb id="repository-algorithm-open" float="center" width={760} />
          <P>
            The bar under the header is where you pick the algorithm that ranks results. At rest it
            is one line (a weight bar and the active name) with a <Chip>Change ▾</Chip> button;
            it opens by itself in the Recommend and Web scopes. The six buttons are the six fixed
            pipelines; <Chip>Custom ▾</Chip> opens three dials. The choice is shared by every page
            (the Arena and the Lab read the same setting).
          </P>
          <WikiTable
            headers={["Button", "Signals", "Weights (TF-IDF / S-BERT / Metadata)"]}
            rows={[
              [<Chip key="1">PIXEL PUNCH</Chip>, "TF-IDF only", "100 / 0 / 0"],
              [<Chip key="2">GHOST WIRE</Chip>, "S-BERT only", "0 / 100 / 0"],
              [<Chip key="3">DUO MODE</Chip>, "TF-IDF + S-BERT", "50 / 50 / 0"],
              [<Chip key="4">TRIVIA QUEST</Chip>, "TF-IDF + Metadata", "66.7 / 0 / 33.3"],
              [<Chip key="5">ARCHIVE MAGE</Chip>, "S-BERT + Metadata", "0 / 66.7 / 33.3"],
              [<Chip key="6">FINAL BOSS</Chip>, "All three", "40 / 40 / 20"],
            ]}
          />
          <WikiThumb id="repository-algorithm-dials" float="right" width={250} />
          <P>
            The <Chip>custom</Chip> pipeline lets you set the three dials freely. They always
            normalize to 100%, the formula below the dials shows the resulting{" "}
            <Chip>S(d) = …</Chip>, and on a tie the leftover goes to Metadata. In Presentation mode
            the buttons carry the formal names (TF-IDF, S-BERT, TF-IDF + S-BERT, …) instead of the
            codenames.
          </P>
          <WikiHatnote>
            Main article: <Xref to="/walkthrough-engine/metadata">The metadata component</Xref> and{" "}
            <Xref to="/walkthrough-engine/fusion-and-ranking#fusion">Normalization and weighted fusion</Xref> on the Engine page.
          </WikiHatnote>
        </WikiSub>

        <WikiSub id="repo-table" title="The paper table">
          <WikiThumb id="repository-list" width={420} />
          <P>
            Each row is one paper: a checkbox, a PDF badge when a file is attached, the favorite
            star, the title (with its subject chip and category underneath), the authors, the year,
            the date added and the document type. Click a column heading to sort by it; the
            arrow shows direction. Ten rows are shown per page, with a pager at the foot and a
            footer line giving the corpus size and the active scope.
          </P>
          <WikiTable
            headers={["Gesture", "Result"]}
            rows={[
              ["Click a row", "Selects it and opens the inspector."],
              ["Tick checkboxes", "Selects several papers; a bar above the table offers bulk actions."],
              ["Click the star", "Toggles Favorites."],
              ["Double-click a cell", "Edits it in place (title, authors, year, …) and autosaves."],
              ["Right-click a row", "Opens the context menu."],
              ["Click a column heading", "Sorts by it; click again to reverse."],
            ]}
          />
          <WikiThumb id="repository-context-menu" float="left" width={300} />
          <P>
            The context menu offers <Chip>Update details</Chip> (re-run metadata enrichment),{" "}
            <Chip>Open file</Chip>, <Chip>Open file externally</Chip>, <Chip>Open containing
            folder</Chip>, <Chip>Collections</Chip>, <Chip>Mark as</Chip> and delete. Metadata
            enrichment fills missing fields from Crossref, OpenAlex and Semantic Scholar and caches
            citation links for the similar-papers graph.
          </P>
          <P>
            Narrow windows get a different table. Below about 720 px of list width the columns fold
            into a two-line row (title; then author · year and the chips) with a <Chip>Sort</Chip>{" "}
            select and a direction button in the header, so nothing scrolls sideways; the filter
            console hides behind a <Chip>Filters ▾</Chip> button.
          </P>
          <WikiGallery cols={2} ids={["repository-narrow", "repository-narrow-filters"]} />
        </WikiSub>

        <WikiSub id="repo-inspector" title="The inspector">
          <WikiThumb id="repository-inspector" width={380} />
          <P>
            The right-hand pane rests as a slim rail and opens when you select a paper; the{" "}
            <Chip>»</Chip> button folds it away again. It has four tabs and a footer with{" "}
            <Chip>Saved</Chip> (add to My Library), <Chip>View</Chip> and <Chip>Delete</Chip>.
          </P>
          <WikiTable
            headers={["Tab", "Contents"]}
            rows={[
              ["Details", "Subject, category, year, type, the title, authors, the full abstract, keywords, DOI and citation count."],
              ["Notes", "A private notes field, saved as you type."],
              ["PDF", "A preview of the stored file, with Preview in viewer, Open full PDF and Delete PDF. With no file, a search for open-access candidates (Unpaywall, Crossref, Semantic Scholar, arXiv, OpenAlex) offers to download and attach the best one."],
              ["Similar", "The similar-papers graph for this paper. See below."],
            ]}
          />
          <WikiGallery cols={3} ids={["repository-inspector-notes", "repository-inspector-pdf", "repository-inspector-similar"]} />
          <P>
            The <Chip>Similar</Chip> tab draws the selected paper at the center of a graph of its
            nearest neighbors, with edge modes (<Chip>Similarity</Chip>, <Chip>Shared topics</Chip>,
            both), <Chip>Cluster guides</Chip> that color the zones and name each cluster with an
            animated leader line, a minimum-strength slider and a full-screen view. The edge weights
            reuse the active pipeline's own components, so the graph can never disagree with the
            pipeline that picked its nodes.
          </P>
        </WikiSub>

        <WikiSub id="repo-stats" title="Stats for Nerds">
          <WikiThumb id="repository-stats-for-nerds" width={360} />
          <P>
            The header's <Chip>Stats for Nerds</Chip> button opens a pane that shows the corpus
            snapshot (papers, valid for ranking, year span, needs review, a document-type histogram)
            and, below it, the <Chip>computation trace</Chip>: the exact numbers the active pipeline
            produced for your current search: inputs, prepared query, candidate set, per-component
            scores, normalization, fusion and the final ranking. It recomputes as you search and as you
            change the algorithm. The formulas themselves are explained on the Engine page.
          </P>
          <P>
            If you do not want these controls at all, the <Chip>NERD</Chip> switch at the top right
            removes every Stats for Nerds button and tab on every page. Switching it off breaks each
            control into pixels that tumble away; switching it on glitches them back in.
          </P>
          <WikiGallery cols={3} ids={["nerd-switch-on", "nerd-switch-off", "repository-nerd-off"]} />
        </WikiSub>
      </WikiSection>
  );
}

export function Recommending() {
  return (
      <WikiSection id="recommending" title="Recommending: query, seed and web">
        <P>
          Searching here is not keyword matching; it is ranking. Choose the <Chip>Recommend</Chip> or{" "}
          <Chip>Web</Chip> scope in <Chip>Search in</Chip>, pick an algorithm in the bar, and the system
          scores every candidate with that algorithm's weights.
        </P>

        <WikiSub id="reco-query" title="Recommend: a query or a seed paper">
          <WikiThumb id="repository-recommend" width={420} />
          <P>
            Type a topic into <Chip>Query the corpus</Chip> and press <Chip>Rank corpus</Chip> (or
            Enter). The table becomes <Chip>Ranked results</Chip>: a rank, the paper, authors, year, type
            and a score with a colored bar. The bar splits the score into its TF-IDF, S-BERT and
            Metadata parts. Beside the algorithm buttons the bar offers <Chip>Top K</Chip> (5, 10, 15,
            20, 30, 50) and <Chip>Diversify</Chip>, which re-ranks with maximal marginal relevance so
            near-duplicate results are spread apart.
          </P>
          <P>
            Tick <Chip>Blend in web results</Chip> to also fetch live web hits for the same query and
            rank them with the corpus in one list; web rows carry a WEB tag and an Import button.
          </P>
          <P>
            A <Chip>seed paper</Chip> works the same way, but the query is an existing paper: use
            "Find similar" on My Library, or the seed action in the Repository, and the system builds
            the query representation from that paper's own prepared text and excludes it from the
            results. Free-text queries have no publication year, so the Metadata score tops out at 0.75
            there; seed searches use the seed's four fields and can reach 1.
          </P>
        </WikiSub>

        <WikiSub id="reco-refresh" title="Pressing another algorithm re-ranks at once">
          <WikiThumb id="repository-recommend-ghost-wire" width={420} />
          <P>
            After a search, pressing any algorithm button re-runs the same query with that algorithm
            (a short pause lets quick successive clicks collapse into one request). The same happens
            when you move a custom dial, change Top K or switch Diversify. The header always names the
            algorithm that produced the list on screen ("10 ranked via GHOST WIRE"), and a slow response
            from an earlier click can never overwrite a newer one.
          </P>
          <WikiNote kind="note">
            Pipelines rank differently on purpose. In the example, the lexical pipeline puts "Neural
            Networks" first because the words overlap, while the semantic one prefers papers about
            graph models that share few words with the query. The Arena exists to measure exactly this.
          </WikiNote>
        </WikiSub>

        <WikiSub id="reco-web" title="Web: the open scholarly web, ranked by your algorithm">
          <WikiThumb id="repository-web" width={420} />
          <P>
            The <Chip>Web</Chip> scope searches OpenAlex, Crossref and arXiv through their public APIs
            (no Google Scholar scraping). Retracted works are always removed; <Chip>Peer-reviewed
            only</Chip> keeps journals, conference papers and book chapters (selecting arXiv as a source
            includes preprints by design); <Chip>Open access only</Chip> keeps hits with free full text.
            You can restrict the sources, the year range and the sort.
          </P>
          <P>
            The default sort is <Chip>Algorithm</Chip>: the live hits are vectorized on the fly with the
            same stored TF-IDF vectorizer and the same S-BERT model the repository uses, scored against
            your query, min-max normalized across the candidates and combined with the active
            algorithm's weights. Each row shows <Chip>#rank · score</Chip> (hover for the TF-IDF / S-BERT /
            Metadata parts), its source, year, type, citations and an <Chip>Open access</Chip> badge.{" "}
            <Chip>Import</Chip> saves a hit to the repository after duplicate detection. Other sorts
            (source relevance, most cited, newest) keep the sources' own ordering.
          </P>
          <WikiThumb id="repository-web-ghost-wire" float="left" width={420} />
          <P>
            As in Recommend, pressing another algorithm re-ranks the web results: the candidates stay,
            their order and scores change. Web recommendations are exploratory and never stored.
          </P>
          <P>
            Selecting a web result opens an inspector with its own <Chip>Similar</Chip> tab: <Chip>In
            your library</Chip> ranks your repository against the result's title and abstract with the
            active algorithm, and <Chip>On the web</Chip> lists its OpenAlex prior and derivative works.
          </P>
          <WikiHatnote>
            Main article: <Xref to="/walkthrough-engine/web-ranking">Ranking the web</Xref> on the Engine page.
          </WikiHatnote>
        </WikiSub>
      </WikiSection>
  );
}


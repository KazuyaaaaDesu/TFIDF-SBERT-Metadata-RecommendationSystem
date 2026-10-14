import { Chip, WikiCite, WikiSection, WikiSub, WikiTable } from "../wiki";
import { P, WikiGallery, WikiHatnote, WikiNote, WikiSteps, WikiThumb } from "../wikiMedia";

export function UploadPage() {
  return (
      <WikiSection id="upload" title="Upload">
        <WikiThumb id="upload" width={380} />
        <P>
          Upload is the front door for new papers. Every path ends in the same pipeline: extract
          metadata, classify the subject, validate the record for recommendation, generate missing
          keywords, check for duplicates and store it. Nothing is saved until you approve the review
          form, so a bad extraction costs you nothing.
        </P>
        <WikiTable
          headers={["Route", "How it works"]}
          rows={[
            ["Drop or choose files", "PDF, BibTeX (.bib), RIS (.ris), EndNote (.enw) or LaTeX (.tex), one or many at once (up to 60, 50 MB each). Multi-entry exports from reference managers, journal sites and Google Scholar import every entry; everything goes through the review navigator, one entry at a time."],
            ["DOI or arXiv id", "Paste a DOI, an arXiv id (1706.03762) or a link to either, with or without a doi: / arXiv: prefix, or several separated by spaces. Metadata comes from Crossref or arXiv; the open-access PDF is searched for in the background after saving."],
            ["Google Scholar link", "Drag a Scholar BibTeX, EndNote, RefMan or RefWorks link onto the drop zone, or paste it; the export is fetched for you. The bundled browser extension sends Scholar citations straight to this page."],
            ["Paste BibTeX manually", "Opens a pop-up for one or many BibTeX entries copied from a citation manager."],
          ]}
        />

        <WikiSub id="upload-review" title="The review form and the validity checklist">
          <WikiThumb id="upload-identifier-review" width={420} />
          <P>
            After a lookup or an extraction the page shows the record in a form: <Chip>Title</Chip>,{" "}
            <Chip>Authors</Chip>, <Chip>Abstract</Chip>, <Chip>Keywords</Chip>, <Chip>Publication year</Chip>,
            DOI, subject, category, document type and citation count. Fields marked * are required. A paper the
            classifier cannot place is left unsorted rather than filed under a default, and the document type is
            read from the citation itself (a BibTeX <Chip>@book</Chip>, an RIS <Chip>TY</Chip> code) so a book is not
            labeled a journal article. A year or citation count that is not a whole number is flagged before you save.
            The box on the right, <Chip>Recommendation Signal Validation</Chip>, lights each of the four
            signals the engine needs (title, abstract, keywords, publication year); a paper missing any
            of them is stored but flagged as needing review and excluded from rankings until fixed.
          </P>
          <WikiThumb id="upload-pdf-review" float="left" width={420} />
          <P>
            For a PDF, text and metadata are extracted with pdfplumber. The extraction is heuristic: a
            scanned PDF without a text layer extracts poorly because the system does no OCR, so check
            the abstract and keywords. If keywords are missing they are generated from the title and
            abstract with YAKE, and a subject and category are assigned from arXiv categories and
            keyword evidence when none is present.
          </P>
          <WikiSteps
            steps={[
              <>Choose a route and let the system extract or fetch the metadata.</>,
              <>Correct the form; watch the four validation signals turn on.</>,
              <><Chip>Save paper</Chip> stores it in a single request, with your corrections (or <Chip>Approve all</Chip> for a multi-entry import, which saves a few entries at a time and flags duplicates inside the batch). <Chip>Back</Chip> returns to the upload step.</>,
            ]}
          />
        </WikiSub>

        <WikiSub id="upload-duplicates" title="Duplicates and automatic PDFs">
          <P>
            Re-imports are rejected across every route. An exact DOI match or a title similarity of at
            least 0.85 blocks the save with a message that names the existing record, and the review form
            warns you before you press Save ("Already in the repository: #…"). For
            citation-only imports the system looks for the best open-access PDF (Unpaywall, Crossref,
            Semantic Scholar, arXiv, OpenAlex) and attaches it automatically when a candidate clears
            the confidence bar.
          </P>
          <WikiGallery cols={3} ids={["upload-identifier-typed", "upload-bibtex-popup", "repository-inspector-pdf"]} />
        </WikiSub>
      </WikiSection>
  );
}

export function MyLibraryPage() {
  return (
      <WikiSection id="my-library" title="My Library">
        <WikiThumb id="library" width={420} />
        <P>
          My Library is the personal shortlist, kept in the database so it survives between sessions.
          Save a paper from the Repository inspector (<Chip>Saved</Chip>), from the Recommend and Web
          results or from a graph, and it appears here; the badge on the top-bar tab counts them.
          The page has four tabs. In Library mode and in the free version, <Chip>Library</Chip> is open
          and the other three show a lock; in Researcher mode with Pro they are all live.
        </P>

        <WikiSub id="lib-library" title="The Library tab">
          <P>
            At the top an ask box (<Chip>Ask a question about these papers…</Chip>) sends your question
            to the Chat tab. Below it quick filters (<Chip>All</Chip>, <Chip>With PDF</Chip>,{" "}
            <Chip>Recent (2023+)</Chip>, <Chip>Unsorted</Chip>), a collection search, and a list/grid
            toggle. Each paper shows its title, authors and year, chips for its citation count, subject
            and type, and <Chip>View</Chip> and remove buttons. A pager with a per-page selector sits at
            the foot, and a tip reminds you that dragging a paper onto the pixel pet also removes it.
          </P>
          <WikiGallery cols={4} ids={["library-grid", "library-search", "library-filter-pdf", "library-selection"]} />
          <P>
            Tick papers to <Chip>select</Chip> them: a bar counts the selection and offers{" "}
            <Chip>Clear</Chip>. The Dashboard, Graph and Chat tabs work on the selection when there is
            one, and on the whole collection when there is not.
          </P>
        </WikiSub>

        <WikiSub id="lib-pro" title="The Pro tabs: Dashboard, Graph and Chat">
          <WikiThumb id="library-dashboard" width={320} />
          <P>
            <Chip>Dashboard</Chip> summarizes the collection: saved papers, the repository size and its
            number of subjects, how many papers are valid for ranking, and the document types; then
            papers by publication year in five-year bins, the subject spread, the most cited papers,
            the newest additions and the document-type counts.
          </P>
          <WikiThumb id="library-graph-selected" width={300} />
          <P>
            <Chip>Graph</Chip> lists your papers on the left; pick one and the graph draws its nearest
            neighbors in the whole repository (the <Chip>Neighbors</Chip> slider sets how many, up to 40).
            The edges use the active pipeline's own components, so the picture agrees with the ranking.
            <Chip>Cluster guides</Chip> color the zones in your theme's palette and attach each name with
            an animated leader line that ends in a circle; the labels are laid out so they never overlap.
            Selecting a node opens a card with its abstract, the most similar papers and{" "}
            <Chip>Ask about this paper</Chip> and <Chip>Open in library</Chip> buttons.
          </P>
          <WikiThumb id="library-chat-answer" width={300} />
          <P>
            <Chip>Chat</Chip> is the research assistant. Choose where it searches (<Chip>Collection</Chip>,{" "}
            <Chip>Repository</Chip> or <Chip>Web</Chip>), ask a question, and the answer cites the sources
            it retrieved with numbered brackets, each with an <Chip>Open in library</Chip> button. The
            citation style follows Settings → Preferred citation style. A history sidebar keeps earlier
            chats; suggested questions appear under the answer. The assistant uses a hosted language
            model through a fallback chain; if the models are rate-limited it says so instead of
            guessing.
          </P>
          <WikiGallery cols={2} ids={["library-graph", "library-chat"]} />
          <WikiNote kind="note">
            Pro unlocks when any garden tree is grown past its Young stage (Young oak 1,500 fertilizer,
            maple 1,450, birch 1,580, elm 1,600, redwood 1,350, beanstalk 1,300, rose supervine 1,480). Researcher mode also has a developer
            override on the Garden's Developer tab. In Presentation mode Pro stays locked, with the copy
            "part of the PRO version".
          </WikiNote>
        </WikiSub>
      </WikiSection>
  );
}


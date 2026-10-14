import { Chip, WikiCite, WikiSection, WikiSub, WikiTable } from "../wiki";
import { P, WikiGallery, WikiHatnote, WikiNote, WikiSteps, WikiThumb, Xref } from "../wikiMedia";

export function ArenaPage() {
  return (
      <WikiSection id="arena" title="Arena">
        <WikiThumb id="arena" width={420} />
        <P>
          The Arena is the evaluation instrument of the study. Every run executes all six pipelines on
          the same query at the same depth and compares them, so a difference in the lists can only come
          from the pipelines. The page is an arcade cabinet: <Chip>Player one</Chip> types the query, picks a
          depth (Top 5, 10 or 15) and presses start, and the <Chip>High scores</Chip> board keeps the
          running tally.
        </P>
        <WikiSteps
          steps={[
            <>Pick the field: <Chip>Repository</Chip> (your stored papers) or <Chip>Web</Chip> (live hits).</>,
            <>Type a query and choose the depth.</>,
            <>Press <Chip>Press start</Chip>. Six rounds tick by (<Chip>ROUND 3 OF 6</Chip>) while the engine runs.</>,
            <>Read the six result tabs below the cabinet; the run is logged in the battle log.</>,
          ]}
        />
        <WikiGallery cols={3} ids={["arena-cabinet", "arena-query-typed", "arena-battling"]} />

        <WikiSub id="arena-results" title="The six result tabs">
          <WikiThumb id="arena-result" width={300} />
          <WikiTable
            headers={["Tab", "What it reports"]}
            rows={[
              [<Chip key="1">01 Winner</Chip>, "The pipeline that captured the largest share of independence-weighted consensus, with that share. A rival's agreement counts only as much as the rival is built from different signals, so no pipeline wins by confirmation from its own hybrids."],
              [<Chip key="2">02 Consensus</Chip>, "Papers ordered by how many of the six pipelines ranked them, then by average rank, each with its vote count and best rank."],
              [<Chip key="3">03 Pairwise</Chip>, "For every pair of pipelines, the overlap at K (papers both ranked) and the mean rank gap (lower means more agreement)."],
              [<Chip key="4">04 Battle grid</Chip>, "Every paper's rank under every pipeline; an empty cell means the paper missed that pipeline's top K."],
              [<Chip key="5">05 Scores</Chip>, "The score distribution by rank position, each pipeline's score scaled against the highest score in the run."],
              [<Chip key="6">06 Interpretation</Chip>, "A paragraph describing the run in APA 7 and MLA 9, with a Copy button, ready for a methodology chapter."],
            ]}
          />
          <WikiGallery
            cols={3}
            ids={["arena-winner", "arena-consensus", "arena-pairwise", "arena-battle-grid", "arena-scores", "arena-interpretation"]}
          />
          <WikiHatnote>
            Main article: <Xref to="/walkthrough-engine/arena-voting">The Arena as a voting system</Xref> on the Engine page.
          </WikiHatnote>
        </WikiSub>

        <WikiSub id="arena-log" title="The battle log, the tally and the web field">
          <WikiThumb id="arena-history" width={420} />
          <P>
            Every repository battle is written to the battle history. The <Chip>Battle log</Chip> lists the
            runs newest first (number, time, query, winner and its share) with pagination, and a small
            histogram of the winners' scores on the page. The high-score board counts wins per pipeline
            over all recorded runs, shows the champion and announces a streak ("STREAK ×5 FOR FINAL BOSS").
          </P>
          <WikiThumb id="arena-web-mode" float="left" width={420} />
          <P>
            The <Chip>Web</Chip> field runs the same six pipelines over live OpenAlex, Crossref and arXiv
            hits, vectorized on the fly with the stored TF-IDF vectorizer and the S-BERT model. It has
            source, peer-review and open-access toggles, and its results are exploratory: a web battle is
            never recorded in the tally. The maths behind the numbers is in the Stats for Nerds
            drawer that every page shares (it goes away with the NERD switch); the Arena has no tab of its own for it.
          </P>
        </WikiSub>
      </WikiSection>
  );
}

export function LabPage() {
  return (
      <WikiSection id="lab" title="Lab: the recipe bench">
        <WikiThumb id="lab" width={420} />
        <P>
          The Lab has two tabs: <Chip>Re:Search Laboratory</Chip> and <Chip>Garden</Chip>. The laboratory is
          where you design your own pipeline and test it against the six presets.
        </P>
        <WikiTable
          headers={["Part", "What it does"]}
          rows={[
            ["Recipe bench", "Three dials (TF-IDF, S-BERT, Metadata). They normalize to 100% and the formula S(d) = … is printed below them. An all-zero allocation falls back to an equal split."],
            ["Diversify every pipeline (MMR)", "An experimental switch with a λ slider that spreads near-duplicates apart in every pipeline of the battle. It applies to repository battles only."],
            ["Load learned weights (10/90/0)", "Loads the weights found by the offline grid search on an 18-query OpenAlex citation benchmark, where they beat the 40/40/20 hybrid by about 0.06 NDCG. A research preset, not the deployed default."],
            ["Saved recipes", "Name a recipe and Save it; five presets are seeded: Lexical Purist (100/0/0), Semantic Purist (0/100/0), Even Split (34/33/33), Citation Winner (10/90/0) and Bibliographer (20/20/60). Click × to remove one."],
            ["Simulate battle", "Pick the Repository or the Web, type a query and a depth, and your recipe fights the six presets. The results list ranks all seven."],
            ["Leaderboard", "Records each simulation's champion and a wins-by-entry histogram. Kept in this browser only."],
          ]}
        />
        <WikiGallery cols={2} ids={["lab-simulated", "lab-stats-for-nerds"]} />
        <WikiNote kind="note">
          The recipe battle uses the same Arena engine and the same independence-weighted consensus, so
          its numbers are directly comparable with an Arena run.
        </WikiNote>
      </WikiSection>
  );
}


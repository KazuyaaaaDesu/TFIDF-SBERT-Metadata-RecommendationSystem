/* ============================================================
   TREE OF KNOWLEDGE — stored system trivia.

   Every entry is a fact about Re:Search as implemented: the
   pipeline mathematics (Engine), the interface manual
   (Walkthrough), the hunt, the pet, or the evaluation harness.
   Nothing here is generated; the tree hands out stored knowledge,
   one piece per LORE press.

   `tier` gates a trivia behind growth: 0 is available from the
   first seed, 1 and 2 need a taller tree, and 3 is elder-tree
   knowledge. Keep claims verifiable against the code and docs
   when editing — a wrong trivia is worse than none.
   ============================================================ */

export interface Trivia {
  id: string;
  tier: 0 | 1 | 2 | 3;
  topic: string;
  text: string;
}

export const TRIVIA: Trivia[] = [
  /* ---------- tier 0: seed knowledge ---------- */
  {
    id: "w-six-pipelines",
    tier: 0,
    topic: "Engine",
    text:
      "Re:Search ships six fixed pipelines: the two solo signals, " +
      "three two-signal pairs, and the full hybrid.",
  },
  {
    id: "w-codenames",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The pipeline codenames are PIXEL PUNCH (TF-IDF), GHOST WIRE " +
      "(S-BERT), DUO MODE (TF-IDF + S-BERT), TRIVIA QUEST (TF-IDF + " +
      "Metadata), ARCHIVE MAGE (S-BERT + Metadata), and FINAL BOSS " +
      "(the full hybrid).",
  },
  {
    id: "w-prepared-text",
    tier: 0,
    topic: "Engine",
    text:
      "Every component reads the same prepared text: Title plus " +
      "Abstract plus Keywords, lowercased with punctuation stripped.",
  },
  {
    id: "w-sbert-model",
    tier: 0,
    topic: "Engine",
    text:
      "S-BERT embeddings come from all-MiniLM-L6-v2 and are 384 " +
      "numbers long; similarity is the cosine between them.",
  },
  {
    id: "w-four-signals",
    tier: 0,
    topic: "Engine",
    text:
      "The metadata component scores four signals — title, abstract, " +
      "keywords, and publication year — at 25 percent each, and a " +
      "missing field contributes zero.",
  },
  {
    id: "w-year-formula",
    tier: 0,
    topic: "Engine",
    text:
      "Publication-year similarity is 1 / (1 + |Δyear|), so papers " +
      "published the same year score 1 and a decade apart scores " +
      "about 0.09.",
  },
  {
    id: "w-dials-balance",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The custom dials always total 100 percent: turning one dial " +
      "rebalances the other two automatically.",
  },
  {
    id: "w-three-modes",
    tier: 0,
    topic: "Walkthrough",
    text:
      "Search has three modes: Keyword compares your words across " +
      "titles and abstracts, Title expects a close paper title, and " +
      "Seed Document recommends papers similar to an existing one.",
  },
  {
    id: "w-import-ways",
    tier: 0,
    topic: "Walkthrough",
    text:
      "References arrive four ways — a PDF, a BibTeX or LaTeX " +
      "export, a DOI or arXiv identifier, or a manual entry — and " +
      "nothing is saved until you approve the preview.",
  },
  {
    id: "w-treasures",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The scavenger hunt hides six treasures, one per page; " +
      "finding them all unlocks the deep tips and this chat.",
  },
  {
    id: "w-achievements",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The pet's medal rack holds nine achievements, from First " +
      "Contact to Question Master.",
  },
  {
    id: "w-tip-count",
    tier: 0,
    topic: "Walkthrough",
    text:
      "There are 38 tips in the catalog: 27 base tips and 11 deep " +
      "tips that stay locked until the hunt is complete.",
  },
  {
    id: "w-export-formats",
    tier: 0,
    topic: "Walkthrough",
    text:
      "My Library can export your shortlist as BibTeX, RIS, EndNote, " +
      "or Reference Manager format.",
  },

  /* ---------- tier 1: sprout knowledge ---------- */
  {
    id: "w-smoothed-idf",
    tier: 1,
    topic: "Engine",
    text:
      "TF-IDF uses a smoothed IDF, ln((1 + n) / (1 + df)) + 1, so a " +
      "term that appears everywhere still keeps a little weight.",
  },
  {
    id: "w-l2",
    tier: 1,
    topic: "Engine",
    text:
      "TF-IDF vectors are L2-normalized at index time, which turns " +
      "cosine similarity into a plain dot product between unit " +
      "vectors.",
  },
  {
    id: "w-minmax",
    tier: 1,
    topic: "Engine",
    text:
      "TF-IDF and S-BERT scores are min-max normalized before " +
      "combining — an order-preserving rescale, so it never changes " +
      "a component's own ranking.",
  },
  {
    id: "w-tiebreak",
    tier: 1,
    topic: "Engine",
    text:
      "Ties break by the newer publication year first, then by title " +
      "alphabetically, and only papers scoring above zero are " +
      "returned.",
  },
  {
    id: "w-breakdown",
    tier: 1,
    topic: "Walkthrough",
    text:
      "Each result's signal bar shows how much TF-IDF, S-BERT and " +
      "metadata contributed; the three values add up to the score.",
  },
  {
    id: "w-bm25-fields",
    tier: 1,
    topic: "Engine",
    text:
      "Repository search ranks with BM25 over four fields: title, " +
      "author, keywords, and abstract.",
  },
  {
    id: "w-bm25-weights",
    tier: 1,
    topic: "Engine",
    text:
      "The BM25 column weights are 10 for title, 5 for author, 5 for " +
      "keywords, and 1 for abstract, with the FTS5 defaults k1 = 1.2 " +
      "and b = 0.75.",
  },
  {
    id: "w-prefix",
    tier: 1,
    topic: "Engine",
    text:
      "The last word you type is treated as a prefix, so " +
      "\"recommend\" already matches \"recommendation\" while you are " +
      "still typing.",
  },
  {
    id: "w-snippet",
    tier: 1,
    topic: "Walkthrough",
    text:
      "Relevance results carry a snippet around the best-matching " +
      "field with the matched words highlighted.",
  },
  {
    id: "w-dup-rule",
    tier: 1,
    topic: "Engine",
    text:
      "An import is rejected as a duplicate when the DOI matches or " +
      "titles are at least 85 percent similar; very short or garbled " +
      "titles never trigger the title rule alone.",
  },
  {
    id: "w-dup-collapse",
    tier: 1,
    topic: "Walkthrough",
    text:
      "Relevance searches collapse near-duplicate records behind a " +
      "+N badge instead of showing the same paper several times.",
  },
  {
    id: "w-edge-bonus",
    tier: 1,
    topic: "Engine",
    text:
      "In the similar-papers graph, an edge is the pipeline's blended " +
      "component score plus 0.15 for shared authors and 0.25 for " +
      "citation relatedness.",
  },
  {
    id: "w-min-edge",
    tier: 1,
    topic: "Engine",
    text:
      "Every origin-to-node edge is always drawn; other pairs need a " +
      "weight of at least 0.15 to appear in the graph.",
  },
  {
    id: "w-dijkstra",
    tier: 1,
    topic: "Engine",
    text:
      "Graph distances come from Dijkstra's algorithm with a hop " +
      "cost of 1 minus the edge weight, so a stronger link is a " +
      "shorter hop.",
  },
  {
    id: "w-mmr",
    tier: 1,
    topic: "Walkthrough",
    text:
      "The Diversify checkbox reranks with maximal marginal " +
      "relevance so near-identical results spread apart; it is off " +
      "by default because it trades a little precision for variety.",
  },
  {
    id: "w-learned",
    tier: 1,
    topic: "Engine",
    text:
      "An offline learner searched the fusion weights against an " +
      "18-query citation benchmark and preferred 0.1 TF-IDF / 0.9 " +
      "S-BERT / 0.0 metadata, beating the fixed 40/40/20 hybrid by " +
      "about 0.06 NDCG — it ships as a research instrument, not as " +
      "the default.",
  },

  /* ---------- tier 2: sapling knowledge ---------- */
  {
    id: "w-coupling",
    tier: 2,
    topic: "Engine",
    text:
      "Citation relatedness is half bibliographic coupling (shared " +
      "references) and half co-citation (shared citers), each " +
      "divided by the smaller set so a score of 1 means total " +
      "overlap.",
  },
  {
    id: "w-cite-keys",
    tier: 2,
    topic: "Engine",
    text:
      "Cached citations key each work as local:<paper_id> when its " +
      "DOI matches a local paper, and as its OpenAlex W-id otherwise, " +
      "so two papers couple even when the external work is not in the " +
      "repository.",
  },
  {
    id: "w-matrices",
    tier: 2,
    topic: "Engine",
    text:
      "The rebuild also materializes the TF-IDF and S-BERT vectors as " +
      "NumPy matrices for fast scoring, with a fallback to the stored " +
      "per-paper vectors; the two paths agree within 0.000001.",
  },
  {
    id: "w-candidates",
    tier: 2,
    topic: "Engine",
    text:
      "A paper is a recommendation candidate only when it is marked " +
      "valid for recommendation and has prepared text.",
  },
  {
    id: "w-backend-normalize",
    tier: 2,
    topic: "Engine",
    text:
      "No matter what scale the dials use, the backend normalizes " +
      "them into weights that sum to 1 before scoring.",
  },
  {
    id: "w-arena-metrics",
    tier: 2,
    topic: "Engine",
    text:
      "The Arena crowns a winner with independence-weighted " +
      "consensus: a pipeline's vote counts for 1 minus the Jaccard " +
      "overlap of the two pipelines' component sets, so a hybrid " +
      "cannot win on the backs of its own parents.",
  },
  {
    id: "w-arena-plan",
    tier: 2,
    topic: "Walkthrough",
    text:
      "The planned Arena campaign is 36 runs: six subject classes, " +
      "one free-text query and one seed paper each, at top-k of 5, " +
      "10, and 15.",
  },
  {
    id: "w-web-sources",
    tier: 2,
    topic: "Walkthrough",
    text:
      "Web search interleaves OpenAlex, Crossref, and arXiv; PDF " +
      "discovery adds Unpaywall and Semantic Scholar candidates.",
  },
  {
    id: "w-engine-tab",
    tier: 2,
    topic: "Walkthrough",
    text:
      "The Engine tab is optional: flipping SHOW_ENGINE_TAB in " +
      "AppLayout hides it from the navigation.",
  },
  {
    id: "w-trace",
    tier: 2,
    topic: "Walkthrough",
    text:
      "The trace panel replays a real search: every number it shows " +
      "is the value the backend actually computed for that query.",
  },

  /* ---------- tier 3: elder-tree knowledge ---------- */
  {
    id: "w-metrics",
    tier: 3,
    topic: "Engine",
    text:
      "The offline harness scores pipelines with precision, recall, " +
      "MRR, MAP, and NDCG at a chosen k, and can derive its " +
      "relevance judgments from OpenAlex reference and citation " +
      "links.",
  },
  {
    id: "w-merge-order",
    tier: 3,
    topic: "Engine",
    text:
      "Merging duplicate records keeps the copy with a stored PDF, " +
      "the valid one, and the published DOI; a preprint twin loses " +
      "to its published version, and library saves plus citation " +
      "rows carry over.",
  },
  {
    id: "w-rebuild-order",
    tier: 3,
    topic: "Engine",
    text:
      "A rebuild runs in a fixed order: classify, validate, refresh " +
      "prepared text, fit TF-IDF, then encode S-BERT.",
  },
  {
    id: "w-stale-flag",
    tier: 3,
    topic: "Engine",
    text:
      "Imports flag the index stale in " +
      "storage/recommendation_index_status.json; the banner clears " +
      "after POST /api/recommendations/rebuild.",
  },
  {
    id: "w-relative-scores",
    tier: 3,
    topic: "Engine",
    text:
      "Min-max normalization is relative to the candidate set, so a " +
      "score of 0.7 means \"top of this search\", not a fixed " +
      "quality level across different queries.",
  },
  {
    id: "w-metadata-asymmetry",
    tier: 3,
    topic: "Engine",
    text:
      "Metadata behaves differently by mode: a seed search uses all " +
      "four signals, while a free-text query compares against title, " +
      "abstract, and keywords but has no publication year to use.",
  },
  {
    id: "w-question-master",
    tier: 3,
    topic: "Walkthrough",
    text:
      "Question Master unlocks after you ask the help library three " +
      "questions — the tree counts every LORE press.",
  },
  {
    id: "w-dwell",
    tier: 3,
    topic: "Walkthrough",
    text:
      "The pixel pet dwells for 2.5 seconds on an interface element " +
      "and then explains what it does.",
  },
  {
    id: "w-reset",
    tier: 3,
    topic: "Walkthrough",
    text:
      "RESET in the pet footer clears discovered tips and hunt " +
      "progress so the whole scavenger hunt can be replayed.",
  },
  {
    id: "g-march",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The Garden's tree marches on fertilizer: 3,000 packets " +
      "take it from Seed through Seedling, Sapling, Young, Mature, " +
      "and Giant to the Ancient crown.",
  },
  {
    id: "g-feet",
    tier: 1,
    topic: "Walkthrough",
    text:
      "Every ft the tree reports is its real painted height: the " +
      "canopy measured against the fully grown tree, so 1,000 ft " +
      "is always an ancient crown.",
  },
  {
    id: "g-cheats",
    tier: 2,
    topic: "Walkthrough",
    text:
      "Charms unlock at 250, 450, 650, 850 and 1,000 ft — each " +
      "species owns its own five, and typing the word arms it until " +
      "typed again.",
  },
  {
    id: "g-themes",
    tier: 1,
    topic: "Walkthrough",
    text:
      "The backdrop is one of seven scenes — Meadow, Winter, " +
      "Desert, Shore, Violet Keep, Rose Ruins, and Frost Spire — " +
      "adopted with growth tokens in the Theme shop.",
  },
  {
    id: "g-timezone",
    tier: 2,
    topic: "Walkthrough",
    text:
      "The garden keeps your local time: the scene shows night " +
      "when it is night, dawn at dawn, and midday at noon — the " +
      "day and the tree are both on your clock.",
  },
  {
    id: "g-climb",
    tier: 2,
    topic: "Walkthrough",
    text:
      "Once the tree outgrows its window, the viewer unlocks: " +
      "drag, scroll, or the arrows to climb the trunk, and the " +
      "stage chips morph it back down to any milestone.",
  },
  {
    id: "g-bubble",
    tier: 0,
    topic: "Walkthrough",
    text:
      "The tree whispers every feed and milestone into its speech " +
      "bubble, offset right of the crown, and rests it on a " +
      "random 4-7 second cooldown.",
  },
];

/** Trivias unlocked at a growth stage (all tiers up to it). */
export function triviaAtStage(stage: number): Trivia[] {
  return TRIVIA.filter((trivia) => trivia.tier <= stage);
}

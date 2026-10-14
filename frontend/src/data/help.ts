/* ============================================================
   HELP LIBRARY, the pet chatbot brain
   Unlocked once every scavenger-hunt treasure is found. The pet
   answers free-text questions by keyword-matching them against
   every tip (base + deep) plus a few special entries.

   Matching is deliberately lightweight: tokenize the question,
   score each entry by how many of its keywords hit with whole-word
   (plus simple plural) comparison, and return the best match. A
   total miss returns the canned topic listing — nothing is ever
   generated. The TREE OF KNOWLEDGE entry only explains the Lab's
   trivia tree; handing out lore lives there, not in this chat.
   ============================================================ */

import { TIPS, EXTRA_TIPS } from "./tips";
import { HUNT_ITEMS } from "./hunt";

export interface HelpEntry {
  title: string;
  keywords: string[];
  body: string;
}

const FALLBACK: HelpEntry = {
  title: "HELP LIBRARY",
  keywords: [],
  body:
    "I did not find a match for that question. Ask about pipelines, " +
    "TF-IDF, S-BERT, ranked search, diversification, duplicates, the " +
    "Tree of Knowledge, the Sun Shop, imports, filters, themes, " +
    "evaluation, or the scavenger hunt. You can also ask for help.",
};

/* Special entries that aren't tips. */
const SPECIAL_ENTRIES: HelpEntry[] = [
  {
    title: "HELP LIBRARY",
    keywords: [
      "help",
      "library",
      "abilities",
      "what can",
      "guide",
      "usage",
      "manual",
      "chat",
    ],
    body:
      "I am the help library for Re:Search. Ask me about any feature: " +
      "the six pipelines and their mathematics, ranked search, " +
      "relevance sorting, duplicates, diversification, importing " +
      "references, filters, themes, evaluation metrics, or the " +
      "scavenger hunt that unlocked this chat.",
  },
  {
    title: "WHO AM I",
    keywords: ["who", "your name", "introduce", "yourself", "about you", "pet"],
    body:
      "I am the Re:Search pet. I guide you through the tip hunt. " +
      "After you find every treasure, I become this help library.",
  },
  {
    title: "THE DEVELOPER",
    keywords: [
      "developer",
      "creator",
      "who made you",
      "made you",
      "maker",
      "built you",
      "tempest",
    ],
    body:
      "TEMPEST built this system for the BSMCS thesis project. See the " +
      "Engine tab for the mathematics behind the ranking, or Stats for " +
      "Nerds for the computation traced live.",
  },
  {
    title: "SCAVENGER HUNT",
    keywords: [
      "hunt",
      "treasure",
      "scavenger",
      "secret",
      "unlock",
      "lock",
      "find all",
      "items",
    ],
    body:
      `There are ${HUNT_ITEMS.length} hidden treasures, one per page. ` +
      "Each treasure is a small dim sparkle. Click it to collect it. " +
      "I whisper hints for the treasures that you did not find. When " +
      `you collect all ${HUNT_ITEMS.length}, the pet tips and this chat unlock.`,
  },
  {
    title: "RESET PROGRESS",
    keywords: ["reset", "restart", "wipe", "clear", "progress"],
    body:
      "After you unlock the library, a small RESET button appears in " +
      "the bubble footer. The button clears your tips and treasure " +
      "progress. Then you can replay the hunt.",
  },
  {
    title: "TREE OF KNOWLEDGE",
    keywords: [
      "knowledge",
      "tree",
      "trivia",
      "species",
      "garden",
      "lawn",
    ],
    body:
      "The Tree of Knowledge is the Garden in the Lab. Plant the " +
      "starter Oak; Maple, Birch, Elm, Redwood, the Beanstalk, and the " +
      "Rose Supervine are skins from " +
      "the tree-card menus. The tree grows by feeding: every " +
      "fertilizer packet nudges it along a 10,000-step march with " +
      "seven evenly divided stages — Seed, Seedling, Sapling, Young " +
      "maple, Mature maple, Giant, Ancient maple. Ask the tree for " +
      "stored trivia; knowledge tiers ride its height, so a taller " +
      "tree answers deeper questions.",
  },
  {
    title: "SUN SHOP",
    keywords: [
      "shop",
      "sun",
      "fertilizer",
      "tokens",
      "currency",
      "packet",
      "discount",
      "height",
      "cheat",
      "charm",
      "daisies",
      "pro",
      "purchase",
      "buy",
    ],
    body:
      "The Sun Shop lives in the tree card's menus in the Garden. It " +
      "sells fertilizer in packs of 1, 5, or 10 — larger packs cost " +
      "less — and you can buy a pack or drag it straight onto the " +
      "tree. Each packet adds 2 growth points, and height follows " +
      "the tree's stage: 3,000 packets take it from Seed to the " +
      "ancient crown at 1,000 feet. At 250, 450, 650, 850 and 1,000 " +
      "feet it unlocks one of that tree's five charm words (the " +
      "oak's are mast, daisies, jay, dapple and hollow), and a " +
      "stored garden tip otherwise. " +
      "You earn sun by using the system: +10 for a daily visit, +1 " +
      "for 10 pets and for each question (daily caps), +5 for a " +
      "treasure or achievement, +2 for five tips. The Tree skins " +
      "menu sells species skins for growth tokens (+3 a day, +1 per " +
      "battle, +1 per five tree asks, +1 per treasure and " +
      "achievement). A Pro Pack card ($4.99, a SIMULATED demo " +
      "checkout: nothing is charged) unlocks My Library PRO and adds " +
      "1,000 fertilizer, 1,000 tree tokens and one seed pack. The " +
      "secret quests, Pet and Garden, are still yours to finish.",
  },
  {
    title: "RANKED SEARCH",
    keywords: [
      "ranked",
      "relevance",
      "bm25",
      "snippet",
      "full text",
      "fulltext",
      "sort",
      "match",
    ],
    body:
      "The Repository search ranks papers by relevance with BM25 over " +
      "the title, author, keywords, and abstract. The best wording " +
      "match ranks first. Each row shows a snippet with the matched " +
      "words highlighted. Near-duplicate records leave the list behind " +
      "a +N badge. If the full-text index is not available, the search " +
      "uses substring matching.",
  },
  {
    title: "DIVERSIFY (MMR)",
    keywords: [
      "diversify",
      "diversification",
      "mmr",
      "variety",
      "spread",
      "duplicate results",
      "redundant",
    ],
    body:
      "The Diversify toggle in the Repository's Recommend scope reranks results " +
      "with maximal marginal relevance (MMR). Each next paper balances its " +
      "score against its difference from the papers already listed. " +
      "Near-identical papers do not stack. The option can reduce " +
      "precision a small amount. Leave it off for pure score order.",
  },
  {
    title: "BLEND IN WEB RESULTS",
    keywords: [
      "blend web",
      "blend in web results",
      "web and local",
      "mix web results",
      "recommend web",
    ],
    body:
      "The Recommend scope has a Blend in web results option (off by default). " +
      "When on, a run also fetches live web hits for the same query and ranks " +
      "them with the corpus in one list. Web rows carry a WEB tag and an " +
      "Import button. If the web sources are down, you still get the " +
      "repository results.",
  },
  {
    title: "SIMILAR PAPERS FOR A WEB RESULT",
    keywords: [
      "web similar",
      "similar web result",
      "related works web",
      "web prior works",
      "web inspector similar",
    ],
    body:
      "Select a web result and open its Similar tab. In your library ranks " +
      "your repository against the result's title and abstract with the " +
      "active algorithm; click a row to open that paper. On the web lists " +
      "the result's prior and derivative works from OpenAlex, found by DOI " +
      "or, failing that, by title. If OpenAlex cannot match it, you see " +
      "No related works found for this result.",
  },
  {
    title: "DUPLICATES",
    keywords: [
      "duplicate",
      "duplicates",
      "merge",
      "merged",
      "same paper",
      "already exists",
      "cannot add twice",
    ],
    body:
      "An import rejects a paper that already exists. The system " +
      "compares the DOI and the title similarity. A title similarity " +
      "of 0.85 or higher counts as a duplicate. Duplicate records that " +
      "existed before this check were merged into one master record " +
      "per group; a published record wins over its preprint. The merge " +
      "keeps library saves and citation data. Relevance searches also " +
      "collapse duplicates. Short or damaged titles never count as " +
      "duplicates on the title alone.",
  },
  {
    title: "SCORE BREAKDOWN",
    keywords: [
      "breakdown",
      "contribution",
      "signal bar",
      "bar",
      "component",
      "why ranked",
      "weighted",
    ],
    body:
      "Each Search result shows a signal bar. The bar shows how much " +
      "TF-IDF, S-BERT, and metadata each contributed to the score. " +
      "The three contributions add up to the printed score. You can " +
      "see if a match is lexical, semantic, or metadata-driven.",
  },
  {
    title: "OFFLINE EVALUATION",
    keywords: [
      "offline",
      "evaluation",
      "eval",
      "ndcg",
      "precision",
      "recall",
      "mrr",
      "map",
      "qrels",
      "benchmark",
      "relevance judgment",
    ],
    body:
      "The Arena reports agreement metrics. An offline evaluation " +
      "tool also scores the pipelines against a relevance-judgment " +
      "file: precision, recall, MRR, MAP, and NDCG at a chosen K. The " +
      "tool can derive judgments from OpenAlex citation links. This " +
      "makes pipeline tuning measurable outside the Arena.",
  },
  {
    title: "WEB SEARCH SOURCES",
    keywords: [
      "doaj",
      "source",
      "sources",
      "openalex",
      "crossref",
      "arxiv",
      "open access",
      "web search",
    ],
    body:
      "Web search can draw on OpenAlex, Crossref, arXiv, and DOAJ. " +
      "DOAJ (the Directory of Open Access Journals) is opt-in: tick it " +
      "to add free-to-read articles from vetted open-access journals. " +
      "Every DOAJ hit is open access; it has no citation counts.",
  },
];

/* Every tip becomes a help entry; the deep tips carry their own
   chat keywords. */
function tipToEntry(title: string, keywords: string[], body: string): HelpEntry {
  return { title: title.toUpperCase(), keywords, body };
}

export const HELP_ENTRIES: HelpEntry[] = [
  ...SPECIAL_ENTRIES,
  ...TIPS.map((tip) =>
    tipToEntry(
      tip.title,
      tip.title
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 2),
      tip.body,
    ),
  ),
  ...EXTRA_TIPS.map((tip) => tipToEntry(tip.title, tip.keywords, tip.body)),
];

/* Aliases so "sbert" and "s-bert" and "bert" all hit the same
   entry without editing every keyword list. */
const ALIASES: Record<string, string[]> = {
  tfidf: ["tf", "idf", "lexical"],
  sbert: ["s", "bert", "semantic", "embedding"],
  meta: ["metadata", "year", "signal"],
};

/* Question words that carry no topic signal. Dropping them stops
   filler words from scoring a match on their own ("what is mmr"
   must not tie between the topic entry and the generic help
   entry). */
const STOPWORDS = new Set([
  "what",
  "is",
  "are",
  "was",
  "the",
  "a",
  "an",
  "how",
  "do",
  "does",
  "did",
  "i",
  "my",
  "me",
  "you",
  "your",
  "to",
  "of",
  "for",
  "can",
  "could",
  "should",
  "it",
  "this",
  "that",
  "there",
  "and",
  "or",
  "on",
  "in",
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    // Hyphens are separators too, so "TF-IDF" tokenizes into
    // ["tf", "idf"] and still matches the "tfidf" keyword.
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
}

/**
 * Whole-word keyword match. A keyword hits when it equals the token,
 * when it is a multi-word phrase containing the token, or when one
 * side is a simple prefix of the other at four or more characters
 * ("duplicate" ~ "duplicates"). Raw substring matching is NOT used:
 * it made "presets" contain "reset" and answer "presets" questions
 * with the RESET tip.
 */
function keywordMatches(keyword: string, alias: string): boolean {
  const needle = keyword.toLowerCase();

  if (alias === needle) return true;
  if (needle.split(" ").includes(alias)) return true;
  if (needle.length >= 4 && alias.startsWith(needle)) return true;
  if (alias.length >= 4 && needle.startsWith(alias)) return true;

  return false;
}

export function answerQuestion(query: string): HelpEntry {
  const tokens = tokenize(query);
  if (tokens.length === 0) return FALLBACK;

  let best: HelpEntry = FALLBACK;
  let bestScore = 0;

  for (const entry of HELP_ENTRIES) {
    let score = 0;

    for (const keyword of entry.keywords) {
      for (const token of tokens) {
        const expanded =
          token.length >= 3 ? [token, ...(ALIASES[token] ?? [])] : [token];

        for (const alias of expanded) {
          if (keywordMatches(keyword, alias)) {
            score += 1;
            break;
          }
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  /* No keyword hit: the canned topic listing is more honest than
     inventing prose. */
  if (bestScore === 0) return FALLBACK;

  return best;
}
# CHAPTER III

## RESEARCH METHODOLOGY

This chapter presents the methodology used to develop and evaluate Re:Search, the hybrid content-based recommendation prototype built in this study. It covers the research design and locale, the system framework and features, the development process, the evaluation protocol (the Arena), the acceptability and quality evaluation (a Technology Acceptance Model questionnaire and an ISO/IEC 25010 checklist), the data collection and analysis plan, the ethical considerations, and the limitations of the method. Together these sections show how the methodology answers Chapter I's specific problems: how the prototype will be designed and built, how its six pipeline configurations will be compared, how that comparison will be conducted and interpreted, and how the developed system's acceptability and software quality will be assessed.

### Research Design

This study will use a descriptive-developmental research design. It is *developmental* because the objective will be to design and build Re:Search, a local academic repository and recommendation prototype, through iterative prototyping in a planning, requirements, design, development, and testing cycle, each pass checked and refined. It is *descriptive* and comparative because the study will report how the six fixed pipeline configurations rank papers on the same queries and seed papers, without manipulating any variable beyond the weight configurations themselves.

The developmental strand answers Chapter I's first two problems: the design and construction of the system, and the design of the three recommendation components (TF-IDF, S-BERT, and metadata) together with their six hybrid configurations. The comparative strand answers the third problem: the agreement structure among the pipelines and the determination of a winner across repeated Arena runs. The evaluation strands answer the remaining problems: the acceptability of the system under the Technology Acceptance Model (Davis, 1989) and its quality under ISO/IEC 25010 (ISO/IEC 25010:2023), measured with a questionnaire for end-users and a checklist for IT experts. The study grounds the comparative arrangement in the standard offline evaluation practice for content-based and hybrid recommenders, in which candidate generation, scoring, ranking, and agreement analysis run over a fixed corpus without human relevance judgments (Adomavicius & Tuzhilin, 2005; Burke, 2002). Content-based recommenders profile items from their textual content and match them against the user's interests (Lops et al., 2011); the prototype operationalizes that idea by profiling papers from their titles, abstracts, and keywords.

### Research Locale

The study is conducted at Bulacan State University, Malolos, Bulacan, in Central Luzon, Philippines. The prototype is developed by Bachelor of Science in Mathematics and Computer Science (BSMCS) students, and the interface brands itself "Re:Search · BulSU BSMCS." The corpus is drawn from publicly available academic literature collected by the researchers, and the evaluation runs locally on a single machine: the FastAPI backend, the SQLite database, and the React frontend all run on the researchers' own computer, and no system was installed in any university office. The researchers document the locale from the prototype's identifiers and from the development records, not from field observation.

### System Framework and Features

Re:Search is a two-layer application: a FastAPI backend that owns the repository, the recommendation engine, and the Arena, and a React frontend that renders the repository, search, and evaluation pages. Table 1 summarizes the modules that make up the system and the purpose of each.

Table 1

Feature Matrix of the Re:Search Prototype

| Module | Purpose |
|---|---|
| PDF import | Upload a PDF and extract metadata from it |
| BibTeX import | Parse a BibTeX citation into a paper record |
| RIS and EndNote import | Parse RefMan / RefWorks (.ris) and EndNote (.enw) records |
| Google Scholar import | Import a Google Scholar BibTeX, EndNote, RefMan, or RefWorks entry or Scholar URL |
| Metadata extraction | Pull title, abstract, keywords, year, authors, and DOI |
| Subject classification | Assign a Subject: Category label when missing |
| Recommendation validation | Mark a paper valid only if title, abstract, keywords, and year are present |
| Prepared text | Build the normalized Title + Abstract + Keywords block |
| PDF discovery and attach | Find and attach open-access PDFs (Unpaywall, Crossref, Semantic Scholar, arXiv, OpenAlex) |
| Duplicate detection | Reject re-imports across PDF, BibTeX, Scholar, and identifier imports by exact DOI or title similarity at or above 0.85 |
| TF-IDF pipeline | Lexical cosine similarity on TF-IDF vectors |
| S-BERT pipeline | Semantic cosine similarity on sentence embeddings |
| Metadata pipeline | Four-signal metadata score (title, abstract, keywords, year) |
| Six configurations and custom dials | Weighted combinations of the three components |
| Query search | Recommend from a free-text query |
| Seed-paper search | Recommend papers similar to a chosen paper |
| Arena comparison | Run all six pipelines side by side on one query or seed |
| Battle history | Log every Arena run; tally wins, champion, and streaks |
| Personal library | Save papers for later reference |
| PDF viewer | Read attached PDFs in the browser |
| Recommendation-index rebuild | Recompute vectors and embeddings after repository changes |
| Ranked repository search | BM25 full-text ranking over title, author, keywords, and abstract, with snippets |
| Citation-based relatedness | Bibliographic coupling and co-citation cached from OpenAlex for graph edges and shared groups |
| Diversified recommendations | Optional MMR reranking that spreads near-duplicate results apart |
| Offline evaluation harness | Precision, recall, MRR, MAP, and NDCG over a relevance-judgment file |
| Weight learning | Offline grid search over the fusion weights against an evaluation metric |
| Matrix index | Precomputed NumPy matrices for TF-IDF and S-BERT scoring |

The recommendation engine combines three components. The TF-IDF component follows Salton and Buckley's (1988) term-weighting scheme. Its vocabulary and smoothed inverse-document frequencies are fitted once over the repository at index build, and every paper is stored as an L2-normalized term-weight vector:

```
V        = vocabulary fitted on { text(d) : d in D }
idf(t)   = ln( (1 + n) / (1 + df(t)) ) + 1        smoothed IDF
w(t,d)   = tf(t,d) * idf(t)                       term weight
v(d)     = w(d) / ||w(d)||_2                      L2-normalized vector
```

At request time the query is vectorized with the same fitted vectorizer (never refit, so both vectors live in one vector space) and scored by cosine similarity:

```
s_tfidf(d) = cos( v(Q), v(d) )
           = ( v(Q) · v(d) ) / ( ||v(Q)||_2 · ||v(d)||_2 )
```

The S-BERT component embeds the same prepared text with the sentence-transformers all-MiniLM-L6-v2 model (Reimers & Gurevych, 2019) and scores by cosine similarity between embeddings, so papers that share no surface terms can still score close:

```
e(d)       = SBERT( text(d) )  in R^384
s_sbert(d) = cos( e(Q), e(d) )
```

The metadata component scores four bibliographic signals at fixed equal weights of 25 percent:

```
Metadata(d) = 0.25·sim(title) + 0.25·sim(abstract) + 0.25·sim(keywords) + 0.25·sim(year)
```

The three text fields are compared by TF-IDF cosine similarity after normalization (lowercase, punctuation stripped), and the year similarity is sim(year) = 1 / (1 + |Δyear|). A missing field contributes 0 while the fixed 0.25 weights are preserved, so a paper with only one available field cannot receive an inflated score. Which signals are active depends on the search mode. Seed-paper searches supply all four signals from the seed's metadata. Free-text queries compare the query text against each candidate's title, abstract, and keywords, while the year signal stays absent because a text query has no publication year, so the year term contributes zero. Metadata-inclusive pipelines therefore behave differently under the two search modes, and the Arena analysis stratifies results by query type.

The six configurations fix the component weights in Table 2. A seventh "custom" pipeline lets the user set the three dials, which the backend normalizes so the weights sum to 1.

Table 2

Pipeline Weight Configurations

| Pipeline | w(tfidf) | w(sbert) | w(metadata) |
|---|---|---|---|
| tfidf | 1.0 | 0.0 | 0.0 |
| sbert | 0.0 | 1.0 | 0.0 |
| tfidf_sbert | 0.5 | 0.5 | 0.0 |
| tfidf_metadata | 0.667 | 0.0 | 0.333 |
| sbert_metadata | 0.0 | 0.667 | 0.333 |
| tfidf_sbert_metadata | 0.4 | 0.4 | 0.2 |

Component scores are normalized independently before combination. TF-IDF and S-BERT raw scores are min-max normalized to [0, 1] (the degenerate all-equal case maps to 1.0), while metadata scores are already bounded and pass through unchanged. The final score is

```
Final(d) = w_tfidf·norm_tfidf(d) + w_sbert·norm_sbert(d) + w_metadata·metadata(d)
```

Expanded for the six fixed configurations of Table 2, the final scores are:

```
S(d) = 1.000 · s'_tfidf(d)                                          TF-IDF
S(d) = 1.000 · s'_sbert(d)                                          S-BERT
S(d) = 0.500 · s'_tfidf(d) + 0.500 · s'_sbert(d)                    TF-IDF + S-BERT
S(d) = 0.667 · s'_tfidf(d) + 0.333 · s'_meta(d)                     TF-IDF + Metadata
S(d) = 0.667 · s'_sbert(d) + 0.333 · s'_meta(d)                     S-BERT + Metadata
S(d) = 0.400 · s'_tfidf(d) + 0.400 · s'_sbert(d) + 0.200 · s'_meta(d)
                                                                   TF-IDF + S-BERT + Metadata
```

Components with zero weight are not computed at all. Results are ranked by Final(d) descending, with ties broken by newer publication year and then by title alphabetically; only papers with positive scores are returned, limited to top_k.

The similar-papers graph operationalizes recommendation for a single paper: the selected paper becomes the origin node and the top_k results of the active pipeline become its neighbors. Every pair of graph papers is joined by a blended edge weight that reuses the active pipeline's own components, so the graph cannot disagree with the pipeline that selected its nodes:

```
w(a,b) = w_tfidf · cos( v_tfidf(a), v_tfidf(b) )
       + w_sbert · cos( e_sbert(a), e_sbert(b) )
       + w_meta  · meta(a, b)
       + 0.15    · J( authors(a), authors(b) )
       + 0.25    · sim_cit(a, b)
```

where meta(a, b) is the four-signal metadata score defined above, J is the Jaccard similarity over the papers' author last names, and sim_cit(a, b) is the citation-relatedness score of the cached OpenAlex neighbourhood (Section B.13); the weight is clamped to [0, 1], and a missing stored vector contributes 0. Edges from the origin are always drawn; other pairs are drawn only at or above a minimum edge weight of 0.15. Dijkstra's algorithm then computes the shortest path from the origin to every node with hop cost (1 − w), so a node's distance summarizes how directly the paper connects back to the selected paper. The graph also reports authors, topics, and shared references or citers grouped across at least two graph papers, so bibliographic coupling and co-citation are computed directly rather than approximated by shared topics. Figure 1 shows the system architecture.

Figure 1

System Architecture of Re:Search

```
┌──────────────────────────────────────────────────┐
│           React + TypeScript + Vite UI            │
│    Repository │ Search │ Evaluation (Arena)       │
└───────────────────────┬──────────────────────────┘
                        │ HTTP / JSON
┌───────────────────────▼──────────────────────────┐
│                FastAPI + Uvicorn                  │
│  /api/papers/*        /api/recommendations/*      │
│  /api/evaluation/battles                          │
└──────────┬─────────────────────────────┬──────────┘
           │                             │
┌──────────▼────────────┐  ┌─────────────▼──────────┐
│ SQLAlchemy 2 + SQLite │  │  Recommendation Core    │
│ papers                 │  │  prepared text         │
│ battle_runs            │  │  TF-IDF vectors        │
│ index status file      │  │  S-BERT embeddings     │
│                        │  │  metadata score        │
│                        │  │  Arena comparison      │
└────────────────────────┘  └────────────────────────┘
```

The main interfaces are reproduced in Appendix A: the login page (Figure A-1), the recommendations page with pipeline selector and ranked results (Figure A-2), the repository page (Figure A-3), the upload page (Figure A-4), the My Library page (Figure A-5), and the Arena page with battle results and battle records (Figures A-6 and A-7). The complete mathematical specification of the components, the six configurations, and the similar-papers graph is given in Appendix B.

### Process of Developing the System

The researchers built the prototype through one repeated loop: planning fixed the scope, requirement analysis fixed what the system must do, design specified the data model and the API surface, development implemented it, and testing checked the build.

#### Planning

Planning fixed the study's direction and scope from Chapter I: a local academic repository plus a recommendation engine with three components and six weight configurations, evaluated by an in-system Arena rather than by human raters. The researchers screened the design space of content-based and hybrid recommenders (Burke, 2002; Lops et al., 2011) for feasibility at prototype scale and fixed the scope to the following: PDF, BibTeX, and Google Scholar import; metadata extraction, classification, validation, and duplicate detection; TF-IDF and S-BERT representations; the six pipelines plus custom dials; query and seed-paper search; and the Arena with battle history. Excluded from the scope are collaborative filtering, production deployment, multi-user accounts, and real authentication.

#### Approach in Development

Development followed an iterative prototyping cycle: requirements, design, build, test, refine, repeated until each slice met its requirements. Each cycle addressed a bounded part of the feature list, so the prototype could be demonstrated early and corrected while changes were still inexpensive. The approach suits a single-user local system: there is no deployment pipeline, no data migration, and only one machine to satisfy. Each iteration cost little and returned feedback quickly, so the design converged on working behavior without a production build.

#### Requirement Analysis

The researchers derived functional requirements from the Statement of the Problem. The system shall (a) import papers from PDFs, BibTeX files, and Google Scholar entries; (b) extract and normalize metadata; (c) classify papers by subject and validate them for recommendation; (d) detect and reject duplicates; (e) build prepared text and both vector representations; (f) run the six weight configurations and a normalized custom dial; (g) search by query or by seed paper; and (h) run the Arena and log every battle result.

The researchers grouped the non-functional requirements into four areas. *Reproducibility*: the same query, pipeline, and top_k must produce the same ranking on the same corpus. *Index consistency*: the recommendation index must be rebuilt after repository changes, with stale-state tracking to flag drift. *Responsiveness*: search and Arena runs must complete within interactive time on a local machine. *Single-node operation*: the entire stack runs locally without external services.

#### Design

The researchers designed the data model around one entity, Paper, which holds the bibliographic metadata (title, abstract, keywords, year, authors, DOI, subject category), the validity flag and missing-field notes, the prepared text, and the two stored representations: a TF-IDF vector and an S-BERT embedding. The Arena writes one battle_runs row per logged battle. The weight presets live in a single configuration module as six named pipelines plus a custom-weights builder that normalizes dial allocations to sum to 1. The API surface covers paper upload and import (POST /api/papers/upload, /api/papers/import-bibtex, /api/papers/import-url, /api/papers/scholar-fetch), recommendation search, index status and rebuild, the Arena (POST /api/recommendations/compare), and battle history (GET /api/evaluation/battles).

#### Development

The researchers implemented the prototype with the stack below, recorded here for reproducibility.

| Technology | Purpose |
|---|---|
| FastAPI + Uvicorn | REST API and local server |
| SQLAlchemy 2 + SQLite | Persistence of papers and battle runs |
| SQLite FTS5 | Ranked full-text repository search |
| scikit-learn | TF-IDF vectorization |
| sentence-transformers (all-MiniLM-L6-v2) | S-BERT embeddings |
| joblib + NumPy | Persistence of vectors, precomputed matrices, and vector math |
| pdfplumber | PDF text extraction |
| YAKE | Keyword generation |
| requests | PDF discovery across external sources |
| python-multipart | File upload handling |
| React + TypeScript + Vite | Frontend application |
| Tailwind CSS + lucide-react | Styling and icons |
| unittest (standard library) | Backend tests |

The backend persists the fitted TF-IDF vectorizer and the per-paper vectors with joblib. The master rebuild script (`python -m scripts.rebuild_recommendation`) runs classify, validate, prepared text, TF-IDF, then S-BERT in order; a stale-state file (`storage/recommendation_index_status.json`) plus the POST /api/recommendations/rebuild endpoint keep the index honest after imports change the corpus. The extensions in Appendix B, Sections B.9 through B.14, follow the same rebuild-and-fallback pattern.

#### Testing

The researchers combined automated tests with a manual functional walkthrough. Backend unittest suites (133 tests covering extraction, upload, duplicate detection, ranked search, vector scoring, citations, diversification, learned weights, and offline evaluation) exercise the engine end to end, and the frontend is verified with the TypeScript type checker and the Vite production build (`npm run check`). The manual walkthrough runs the full loop: import a PDF and a BibTeX entry, confirm classification and validation, rebuild the index, search by query and by seed paper, and run an Arena battle. Every deviation was recorded and corrected before the next iteration.

### System Evaluation

The evaluation works at two levels. The comparative level evaluates the six pipelines with the Arena, an in-system instrument, rather than with human raters. This follows a recognized offline evaluation approach for recommender systems, in which configurations are compared on ranking behavior over a fixed corpus without human relevance judgments (Adomavicius & Tuzhilin, 2005). The acceptability and quality level evaluates the developed system itself with human respondents: a Technology Acceptance Model questionnaire for end-users and an ISO/IEC 25010 checklist for IT experts (Davis, 1989; ISO/IEC 25010:2023).

#### Evaluation Instrument (Arena Protocol)

The Arena runs all six pipelines on the same query or seed paper at a chosen top_k (the interface offers 5, 10, and 15) and computes four structures. First, *per-pipeline ranked results* show each configuration's own top_k list. Second, a *consensus ranking* orders every paper any pipeline ranked by votes (the number of pipelines that included it), then by average rank, then by paper id. Third, *pairwise agreement* is computed for every pair of pipelines as overlap@k, the number of shared papers, plus the mean absolute rank gap over the papers both pipelines ranked. Fourth, a *winner* is determined by independence-weighted consensus: each paper in a pipeline's top_k collects votes from the other pipelines, where a vote from pipeline Q weighs 1 − Jaccard(P's component set, Q's component set). Disjoint pipelines weigh 1.0; a two-signal hybrid weighs exactly 0.5 against a pipeline built from one of its own components, and the three-signal hybrid weighs at most 2/3 against a single-signal pipeline sharing one component, so no pipeline can win through its own hybrids re-confirming its output. The winner is the pipeline with the largest share of its maximum possible weighted consensus; ties fall to the lower average consensus rank. The winner is a measure of agreement breadth under independence weighting, not of correctness: pipelines can agree in error together, and a configuration can win by being the best average of its rivals rather than the best recommender.

Every run with a winner is logged as a battle_runs row holding the query or seed, top_k, winner pipeline, metric, value, average consensus rank, and timestamp. The Arena page tallies wins over time, showing the champion and current streaks, and the backend serves the full history through GET /api/evaluation/battles.

#### Research Instrument

The acceptability and quality evaluation uses a structured instrument with two components: a Technology Acceptance Model (TAM)-based questionnaire for end-users and an ISO/IEC 25010-based checklist for expert evaluators (Davis, 1989; ISO/IEC 25010:2023). Both components are organized into clearly defined sections, use a uniform ten-point response scale from 1 (lowest) to 10 (highest), and carry concise instructions for respondents.

The TAM questionnaire guides the assessment of user acceptance through four constructs. *Perceived usefulness* assesses whether Re:Search helps users find relevant literature for thesis writing more efficiently and supports their research tasks. *Perceived ease of use* assesses how easy the system is to learn, navigate, and operate, particularly the search, repository, upload, and Arena pages. *Attitude toward using* measures the user's overall disposition toward the system, including satisfaction and positive impression after using its features. *Behavioral intention* examines the user's willingness to use the system regularly in the future and to recommend it to others.

The ISO/IEC 25010 checklist translates the standard's nine product quality characteristics into structured items that IT experts rate while interacting with the system: *functional suitability* (whether the functions for importing, validating, searching, recommending, and comparing papers are complete, correct, and appropriate for thesis writers), *performance efficiency* (response time, loading speed, and behavior under expected use), *compatibility* (operation alongside common browsers and citation formats), *interaction capability* (clarity of controls, labels, feedback, and error prevention), *reliability* (consistent functioning, availability, and recovery from errors), *security* (controlled access, protection of stored data, and traceable actions), *maintainability* (how easily the system can be analyzed, tested, modified, and updated), *flexibility* (adaptation to different environments, workloads, and future extension), and *safety* (controlled behavior in the event of failure, with no harmful effects on stored data).

#### Population and Sample

The evaluation population consists of end-users and information technology (IT) experts. End-users are BSMCS students of Bulacan State University who write theses and search for related literature; they assess the system's acceptability through the TAM questionnaire. IT experts assess the system's software quality through the ISO/IEC 25010 checklist. Table 4 summarizes the evaluation sample.

Table 4

Summary of the Evaluation Sample Size

| Evaluators | Population | Sample Size |
|---|---|---|
| Student end-users | N/A | 77 |
| IT experts | N/A | 5 |

Purposive sampling will be used to select participants with direct knowledge and relevant experience related to the system, so that respondents can evaluate it according to its intended use (Nyimbili & Nyimbili, 2024). The minimum sample size for the end-user group will be computed with G*Power (Faul et al., 2009) for linear multiple regression under the F-test family with fixed model and R² deviation from zero (effect size f² = 0.15, α = 0.05, power = 0.80, three predictors representing the core TAM constructs), which yields a minimum of 77 respondents; the IT expert group will consist of five evaluators.

#### Data Collection

The researchers will collect data by running a planned Arena campaign of 36 runs: one free-text query and one seed paper drawn from each of the repository's six largest subject classifications (Machine Learning, Mathematical Analysis, Mathematical Modeling, Graph Theory, Linear Algebra, and Information Retrieval), each executed at top_k values of 5, 10, and 15, for 6 × 2 × 3 = 36 runs. The queries and seed papers will be selected by the researchers to represent each class's dominant topics, and the final selection will be recorded together with the corpus's subject-class composition before data collection begins; each run writes a battle_runs row automatically, and the researchers will export the battle history at the end of the campaign. The evaluation corpus is the repository itself, which holds 168 papers at the time of writing, 145 of them valid for recommendation. Runs logged during development walkthroughs exercised the instrument and are excluded from the reported results: the researchers will reset the battle history before the campaign, so the win tally, champion, and streaks reflect the formal runs only.

The acceptability and quality data will be collected in evaluation sessions. The researchers will first coordinate with the selected student end-users and IT experts to schedule their sessions. Before the evaluation, each participant will receive a brief walkthrough of the prototype's pages and features to ensure understanding of its functionality. Respondents will then explore the system independently and complete their instrument, the TAM questionnaire or the ISO/IEC 25010 checklist, using the ten-point scale. To maintain neutrality, responses will be completed individually and treated as confidential, and quantitative ratings will be collected together with optional qualitative comments and suggestions for improvement.

#### Data Processing and Analysis

The researchers will process the battle history with descriptive statistics: vote counts and average ranks per paper in the consensus ranking, score distributions per pipeline, and win shares per pipeline (wins divided by total battles). Agreement analysis will summarize the pairwise measures, showing which configurations behave alike and which diverge, both in selection (overlap@k) and in position (mean rank gap). Winner determination applies the independence-weighted consensus rule per battle, and the tally across battles identifies the configuration with the most wins and the best average consensus rank. Table 3 summarizes the metrics and their interpretations.

Table 3

Evaluation Metrics and Interpretations

| Metric | Formula | Interpretation |
|---|---|---|
| Consensus votes | Number of pipelines that ranked paper d | Breadth of agreement on d |
| Average rank | Mean of d's ranks across its voters | How high d sits on average |
| Pairwise overlap@k | Number of shared papers in two top_k lists | Shared selection at k |
| Mean rank gap | Mean of \|rank_P(d) − rank_Q(d)\| over shared papers | Positional divergence between pipelines |
| Independence weight | 1 − Jaccard(component sets of P and Q) | Strength of cross-evidence between pipelines |
| Winner share | Captured weighted consensus ÷ maximum possible | Share of the strongest evidence a pipeline captured |

The study will report these results descriptively; no inferential statistics will be applied to the comparison, because the Arena produces system-internal agreement measures. No accept/reject language will be attached to the hypotheses; the statistics will describe observed differences within the bounds stated in the Limitations section. The Chapter I hypotheses will be assessed from the campaign's observed statistics: win shares and average consensus ranks for consensus capture, and overlap and mean rank gap for ranking agreement. Every statistic will be computed overall and separately for the two query types (free-text runs and seed-paper runs), and per subject class where counts allow, so conclusions about metadata-inclusive pipelines are reported per query type and conclusions about lexical effects per class. The researchers will interpret the win tally and the agreement structure as evidence about which configurations agree with the widest set of independent signals, within the bounds stated in the Limitations section.

The acceptability and quality ratings will be analyzed with descriptive statistics. Each instrument item uses the ten-point rating scale from 1 (lowest) to 10 (highest), which allows finer differentiation of respondent perceptions. The overall rating for each criterion will be summarized with the weighted mean, and the standard deviation will be computed alongside it to measure the variability of responses and the consistency across participants. Mean scores will be interpreted with the verbal interpretation scale in Table 5, which links score intervals to five levels of acceptance.

Table 5

Verbal Interpretation Scale

| Mean Score Interval | Level of Acceptance |
|---|---|
| 8.21 - 10.00 | Highly Acceptable |
| 6.41 - 8.20 | Moderately Acceptable |
| 4.61 - 6.40 | Acceptable |
| 2.81 - 4.60 | Fairly Acceptable |
| 1.00 - 2.80 | Poorly Acceptable |

The same scale interprets both instruments, so the acceptability ratings of the end-users and the quality ratings of the IT experts are reported on one scheme and can be compared descriptively. No inferential tests will be applied to the ratings either: the analysis reports observed means and their variability within the purposively selected groups, bounded by the Limitations section.

### Ethical Considerations

The corpus work uses publicly available academic metadata and open-access documents collected by the researchers for educational research, and all processing runs on a single local machine. The evaluation involves human respondents: participation of the student end-users and IT experts will be voluntary, informed consent will be obtained from each participant before any session, the purpose of the study and the right to withdraw at any time without penalty will be stated in advance, and responses will be coded so that individual raters are not identified in the results. Only ratings and optional comments will be recorded, and research files will be stored securely and accessed only by the researchers. All citations in this chapter come from the approved source list and were verified manually against their DOI or publisher records; no bibliographic detail was taken from model recall. AI-assisted tools were used for drafting this chapter and for scaffolding code during development, and every technical claim was checked against the running prototype, its tests, and the live database.

### Limitations of the Method

1. **Single corpus.** The evaluation runs on one local repository (168 papers, 145 valid for recommendation), so the results may not transfer to larger or differently sourced collections.
2. **Single semantic model.** All S-BERT scores rest on one embedding model (all-MiniLM-L6-v2); other models could rank the corpus differently.
3. **System-internal agreement.** The Arena measures agreement among pipelines, not relevance against human judgments, so it cannot certify which pipeline best serves real users. The human evaluation covers acceptability and ISO/IEC 25010 quality ratings, not ranking relevance, so relevance against human judgments remains for future work.
4. **Heuristic extraction.** Metadata comes from pdfplumber text extraction without OCR, so scanned or poorly encoded PDFs degrade the corpus.
5. **Lexical corpus bias.** TF-IDF similarity depends on shared vocabulary, so the topical spread of the corpus bounds what the lexical component can express.
6. **No collaborative signals.** The prototype is content-based only; collaborative, popularity, or usage signals are out of scope.
7. **Single-node operation.** SQLite and local storage bound scale and concurrency; the findings describe the prototype, not a production service.
8. **Purposive evaluation sample.** The end-users and IT experts are purposively selected rather than randomly sampled, so the acceptability and quality ratings describe the participating groups and do not generalize to all students or practitioners.

9. **Open-source web search, no licensed indexes.** The web-search and PDF-discovery features draw only on open scholarly sources (OpenAlex, Crossref, arXiv, DOAJ, Semantic Scholar and Unpaywall). Scopus and Web of Science are not queried, because both require an institutional licence or API credentials, and neither OpenAlex nor Crossref reports whether a journal is indexed in them. The system therefore cannot restrict results to Scopus- or Web of Science-indexed journals, and its coverage of paywalled, licensed-index literature is partial. See `limitation-bibliographic-sources.md`.

### AI-Assisted Research Disclosure

AI-assisted tools were used for drafting this chapter and for scaffolding code during development. All citations were manually verified against the approved source list; no authors, DOIs, statistics, or implementation details were fabricated, and every technical claim was checked against the repository code, its tests, and the live database. The full provenance and verification trail is kept in the file audit-trail.md.
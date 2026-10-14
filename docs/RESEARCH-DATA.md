# Arena & Lab: export, archive, delete — plus a sellable research dataset

**Status:** plan only. Nothing built.
**Written:** 2026-10-09
**Related:** `docs/PACKAGING.md`

---

## Why this is urgent, in a way the rest of the roadmap is not

Everything else can wait until after the final defense. This cannot, for one
reason: **the data has to exist before you collect it, and it has to be
clean before you collect it.**

Chapter III commits you to a 36-run Arena campaign, with development
walkthroughs explicitly excluded and `battle_runs` reset before collection
starts. Export/reset is therefore not a convenience feature — it is the
mechanism that makes the campaign's data defensible. If you cannot reset and
export cleanly on the morning of the campaign, you cannot honestly claim the
tally reflects only formal runs.

The same applies to selling the data afterwards: you cannot sell a dataset
whose provenance you cannot state.

---

## What I found in the code

### Arena — mostly server-side, and missing exactly the parts you need

`battle_runs` (`models.py:341`) is a real table and the Arena already writes
one row per run (`api.py:2706`). Current columns:

```
id, query, seed_paper_id, top_k, winner_pipeline_id,
winner_metric, winner_value, avg_consensus_rank, created_at
```

`GET /api/evaluation/battles` serves it paginated with a win tally. What is
**missing**:

- **No delete endpoint.** I grepped all routes — the only DELETEs are
  papers, library, and admin announcements. Chapter III says "the
  researchers will reset the battle history before the campaign"; there is no
  way to do that from the UI today.
- **No export.** No CSV, no JSON download anywhere in `Evaluation.tsx`.
- **The log is thinner than the response.** `CompareResponse`
  (`compare_service.py:142`) carries `pipelines`, `consensus`, and
  `pairwise` — full ranked lists, vote counts, avg ranks, overlap@k, and
  mean rank gaps. **None of that is persisted.** You store the winner's
  summary and throw away the entire agreement structure that Chapter III
  describes as your primary analysis.
- **No run identifier or subject class.** Nothing links a run to the six
  subject classes, and nothing marks a run as campaign vs. development. You
  would have to reconstruct that from query text by hand.

Current state of the table on this machine, which shows why the reset matters:

| Property | Value |
| --- | --- |
| Total runs | **65** |
| top_k | **10 only** (campaign needs 5, 10, 15) |
| Query type | **65 text, 0 seed** (campaign needs both) |
| Winners | tfidf_sbert_metadata 44, tfidf 12, tfidf_sbert 5, tfidf_metadata 4 |

Every one of these 65 is a development walkthrough and all of it must be
excluded from what you report. Right now you cannot separate them
programmatically — `created_at` is the only signal, and nothing tags a run
as belonging to the campaign.

### Lab — entirely client-side, so it is the bigger gap

This is the important structural finding. `Lab.tsx` passes `recordBattle:
false` (`Lab.tsx:331`) so simulations don't pollute the Arena, and then
stores results in **localStorage** (`paperrec_lab_battles`, `Lab.tsx:46`).
Its `LabRun` type (`Lab.tsx:37`) holds only:

```
recipeName, weights{tfidf,sbert,metadata}, winnerPipelineId,
winnerValue, createdAt
```

So the Lab's history:

- lives in one browser profile and vanishes on clear-site-data
- cannot be exported, analysed, or reproduced by anyone else
- **discards the recipe id, the diversify/MMR settings, the web sources and
  sort mode, and the whole consensus/pairwise structure** — the exact
  variables a researcher would want

If Lab experiments inform your paper, today that evidence is unrecoverable.
Fixing this means a server-side table, not a UI feature.

### Existing research-grade assets worth exporting

These already exist and have genuine value — you don't need to build them:

| Asset | Where | Content |
| --- | --- | --- |
| Corpus + provenance | `papers` table | 181 papers, 169 with abstracts, 180 with keywords, 144 with DOIs, 156 TF-IDF vectors, 155 S-BERT vectors. Extraction method tracked (`auto`/`bibtex`/`metadata`/`manual`), keyword provenance (`author` 16, `yake` 108, none 57) |
| Citation graph | `paper_citations` | **12,224 rows** — 6,994 `cited_by`, 5,230 `cites`, from OpenAlex. This is the graph that powers the similar-papers view |
| Learned weights | `app/data/learned_weights.json` | Result of a grid search: `{tfidf: 0.1, sbert: 0.9, metadata: 0.0}`, nDCG@10 = **0.539** vs 0.479 baseline, over 18 queries. A genuine, reproducible optimization result |
| Evaluation harness | `app/services/evaluation/` + `scripts/evaluate_recommendations.py` | Metrics, qrels loader, runner, offline CLI |
| Arena history | `battle_runs` | 65 runs (see above) |

The learned-weights result and the 12,224-row citation graph are the two most
interesting things you already own. Both are currently invisible to anyone
but you.

---

## Design

### Part 1 — Make the run log research-grade

The central change: **log the whole response, not just the winner.** One JSON
blob on the run row captures pipelines, consensus and pairwise exactly as
computed, so the agreement structure survives for analysis and export.

Add to `battle_runs`:

| Column | Why |
| --- | --- |
| `run_label` | Free text: names the campaign run, e.g. `campaign-ml-text-5` |
| `subject_class` | One of the six classes, or null. Enables per-class analysis without parsing query text |
| `query_kind` | `text` or `seed`. Currently indistinguishable in aggregate |
| `mmr_lambda`, `mmr_pool` | Only when diversify is on; otherwise null |
| `custom_weights` (JSON) | Set only for the custom pipeline |
| `response_json` | The full `CompareResponse` snapshot |
| `corpus_size`, `corpus_version` | Paper count at run time, so results stay interpretable if the corpus changes |

`corpus_version` matters more than it looks: Chapter III quotes 168 papers /
145 valid. If your corpus drifts during the campaign, a run's numbers stop
being comparable. A recorded corpus size lets you defend that.

### Part 2 — Arena: export / archive / delete

Four endpoints under `/api/evaluation/battles`:

- **`GET /export?format=csv|jsonl`** — CSV for a spreadsheet, JSONL for
  analysis. CSV flattens winner metrics; JSONL carries the full response blob
  so nothing is lost. Both include run labels and timestamps.
- **`POST /archive`** — write the current history to a timestamped file under
  `storage/exports/`, then clear the table. This is the campaign workflow:
  archive development history, start clean, run the 36.
- **`DELETE`** — clear, with a confirmation, since it is destructive.
- **`GET /stats`** — the aggregate table you need for Chapter IV: win shares
  per pipeline, overall and split by query kind and subject class.

UI, matching what `shots.ts` calls the Arena's records table: an **Export**
dropdown (CSV / JSONL), an **Archive and reset** button behind a confirm
dialog that states exactly how many runs will be archived and where.

### Part 3 — Lab: give experiments a server-side home

This is the larger piece, and I'd argue it's the one that matters most for the
paper.

- New `lab_runs` table mirroring the Arena's, plus the knobs Lab has and the
  Arena doesn't: `recipe_id`, `recipe_name`, `weights`, `mmr_lambda`,
  `web_mode`, `web_sources`, `web_sort`, `open_access`, `top_k`,
  `response_json`, `run_label`.
- **Keep the localStorage copy as a cache**; write through to the server.
  Don't migrate — you want the existing 60-entry local history readable, and
  the client keys are stable.
- Same export/archive/delete surface.
- Lab already has the `run_label` idea in spirit (preset recipes); give both
  pages one shared research-namespace: `campaign-*`, `dev-*`, `demo-*`.

### Part 4 — The packaged dataset

A script, `scripts/export_research_dataset.py`, producing a versioned
directory:

```
research-dataset-v1/
  README.md              # what it is, how it was collected, how to cite
  DATA_LICENCE.md        # terms for redistribution
  MANIFEST.json          # every file, row count, sha256, generated-at
  corpus/
    papers.csv           # metadata + provenance, no vectors
    citations.csv        # all 12,224 citation edges
    corpus_summary.md    # composition by class, year, type, extraction method
  arena/
    battle_runs.csv      # flattened
    battle_runs.jsonl    # full responses
    arena_stats.csv      # win shares, pairwise agreement
  lab/
    lab_runs.csv / .jsonl
  evaluation/
    learned_weights.json
    qrels_sample.json
    evaluation_results.json
  environment/
    requirements-lock.txt
    model_card.md        # all-MiniLM-L6-v2, its licence, its limits
```

The README is what makes it sellable, so it needs more than file listings:

- **Provenance** — how each file was produced, which script, which commit
- **Collection protocol** — the campaign design from Chapter III, so a buyer
  can judge representativeness
- **Known biases** — the corpus is not a random sample of the literature; it
  is one thesis-writer's library, heavily Machine Learning
- **Limitations** — no human raters on the Arena measures, agreement is not
  correctness, single-machine
- **Citation guidance** — a suggested citation for the thesis

## What I would not do

**Do not build a general analytics/telemetry system.** Chapter III needs the
battle history and the corpus, and both are already structured. Product
analytics would add a privacy problem ("your data stays local" is in the
README) and solve nothing your panel will ask about.

**Do not treat "sell the data" as the driver of the design.** Build the
instrument first, for your own campaign. The dataset is a byproduct you
package afterwards. Designing the schema around a sale will make it worse for
the paper, which is the thing that is actually graded.

---

## The privacy and licensing question

This is where I want to be direct, because "sell the data" has consequences
that aren't obvious until after you've built it.

**Paper abstracts are not yours to sell.** Titles, abstracts, keywords and
DOIs are third-party copyrighted or licensed content. You aggregated
metadata for personal study use. Redistributing 181 abstracts commercially is
a different act, and the licences vary per publisher.

**What is genuinely yours:**
- Derived measurements (win shares, agreement statistics, overlap@k)
- Your pipeline configurations and the fusion algorithm
- The learned weights result (a finding)
- The citation *edges* (facts, not text — though OpenAlex is CC0, so
  verify per-record)
- Your own evaluation instruments (TAM questionnaire, ISO checklist)

**A defensible split:** sell the *analysis* — measurements, methodology,
code, instruments — and ship the corpus as a derived, non-invertible dataset:
IDs, DOIs, years, classes, and metrics, without abstracts. DOIs let a buyer
retrieve the originals themselves, so you've lost no reproducibility while
redistributing no copyrighted text.

If you want to include full text, that needs either a licence audit per
record or explicit publisher permission. I'd treat that as a separate
project, not part of this one.

I'd also flag: "your data stays local" appears in the README. Commercializing
derived data from those papers is a claim the README doesn't currently cover,
and the ethics section of Chapter III addresses the study's participants, not
the corpus. Worth a paragraph in both.

---

## Sequencing

| # | Work | Depends on | Blocks |
| --- | --- | --- | --- |
| 1 | Extend `battle_runs` + migration | — | everything |
| 2 | Log full response, run label, class, query kind | 1 | campaign |
| 3 | Arena export / archive / delete + UI | 1 | campaign reset |
| 4 | `scripts/export_research_dataset.py` + README | 2, 3 | selling data |
| 5 | `lab_runs` table + write-through | 1 | Lab analysis |
| 6 | Lab export UI | 5 | — |
| 7 | Licence review of what ships | — | selling data |

**Steps 1–3 are on the critical path for the campaign.** Everything else can
follow. I'd do 1–3 now, then 4, and treat 5–6 as a stretch if the campaign is
close.

Estimated: 1–3 in about a day, 4 in half a day, 5–6 in a day, 7 is a reading
task.

---

## Decisions I need from you

1. **Is Lab data part of the paper's evidence, or just your own exploration?**
   This decides whether step 5 is required or optional. If Lab results inform
   Chapter IV, it's required.
2. **Which corpus split do you want to ship?** My recommendation is
   metadata + derived measurements without abstracts. Full text is a
   different and much harder licensing question.
3. **Subject class on every run** — do you want it captured at run time (a
   dropdown on the Arena), or left to be inferred from the query? Capture is
   better for the campaign and worse for casual use.
4. **Do you need per-run corpus versioning?** I'd say yes, but it's one extra
   column and a little ceremony per run.

## What I need from you before building

Nothing blocking — items 1 and 2 change scope, not direction. If you want
the campaign unblocked first, say so and I'll build steps 1–3 only and leave
the licensing question untouched until after the defense.
# Re:Search

**A hybrid academic-paper recommender for thesis writing**, built at Bulacan State University (BSMCS).

Re:Search keeps a local repository of papers, ranks related literature with three signals (lexical, semantic and metadata), and lets you compare six ways of combining them side by side. It runs entirely on your own machine: a FastAPI + SQLite backend and a React + TypeScript frontend.

<p align="center">
  <img src="frontend/public/walkthrough/repository.png?v=indigo" alt="The Repository: filters, paper table and inspector" width="820">
</p>

> **Status:** a local research prototype. It is built to be explored and measured, not deployed.

---

## Main page

| | |
| --- | --- |
| **Find** | Search your own papers, rank them against a query or a seed paper, or rank the open scholarly web (OpenAlex, Crossref, arXiv) with the same algorithms. |
| **Add** | Drop PDFs, BibTeX, RIS or EndNote files, paste DOIs and arXiv ids, or send a Google Scholar citation. Everything is checked before it is saved. |
| **Compare** | The Arena runs all six pipelines on one query and tells you where they agree, where they split and which one wins, or that the call is too close to make. A tournament then tests them on many papers with known references. |
| **Keep** | A personal library you can organise into your own nested folders, with a dashboard, a similarity graph and a research chat that cites its sources. |
| **Explore** | A Lab for designing your own weights, dueling them against the presets and sweeping the whole blend triangle, plus a few playful extras we'd rather you discover than read about. |

---

## A look around

<table>
  <tr>
    <td width="33%"><img src="frontend/public/walkthrough/repository-web.png?v=indigo" alt="Web results ranked by an algorithm"><br><b>Recommend</b><br>Pick an algorithm and the results re-rank at once, on your papers or on the web.</td>
    <td width="33%"><img src="frontend/public/walkthrough/arena-winner.png?v=indigo" alt="The Arena's winner banner"><br><b>Arena</b><br>Six pipelines, one query: consensus, pairwise agreement and a winner.</td>
    <td width="33%"><img src="frontend/public/walkthrough/library-graph-selected.png?v=indigo" alt="The similar-papers graph with cluster labels"><br><b>My Library</b><br>See how your papers cluster, then ask questions across them.</td>
  </tr>
  <tr>
    <td><img src="frontend/public/walkthrough/upload-identifier-review.png?v=indigo" alt="The Upload review form"><br><b>Upload</b><br>Review what was extracted, fix it, and see a duplicate warning before you save.</td>
    <td><img src="frontend/public/walkthrough/lab-simulated.png?v=indigo" alt="The Lab's recipe bench"><br><b>Lab</b><br>Mix the three signals into your own recipe and test it against the presets.</td>
    <td><img src="frontend/public/walkthrough/repository-stats-for-nerds.png?v=indigo" alt="Stats for Nerds"><br><b>Stats for Nerds</b><br>The exact numbers behind any ranking, live as you search.</td>
  </tr>
</table>

---

## How it ranks

Each paper is turned into a prepared text (title, abstract and keywords) and scored three ways:

| Signal | What it measures |
| --- | --- |
| **TF-IDF** | Shared vocabulary: how much a query and a paper use the same, distinctive words. |
| **S-BERT** | Shared meaning: embeddings from `all-MiniLM-L6-v2`, so a paraphrase still matches. |
| **Metadata** | Title, abstract, keywords and publication year, weighted equally. |

Six fixed pipelines combine them (each alone, three pairs, and all three together), and a seventh, *custom*, takes your own weights. The scores are normalized, fused, and ties are broken by year and then title, so the same input always gives the same ranking. The mathematics, with a worked example, is in the wiki's **Engine** manual.

---

## Organising and checking

| | |
| --- | --- |
| **Folders** | My Library keeps folders like Zotero or Mendeley: nested, a paper can sit in several, and nothing is deleted when a folder is. Drag papers onto a folder (the ghost turns into a folder as you reach it), or right-click a paper and pick one. Right-click menus always open fully inside the window. |
| **Honest verdicts** | A battle's winner is the pipeline most others agree with, which is not the same as the best one. A lead of under two points is shown as *too close to call*, and only decisive wins are tallied. |
| **Judging** | A battle on a seed paper is scored against that paper's own references; a text battle can be judged by ticking what is relevant, blind to which pipeline found it. Judged battles pool into a board that states a verdict only once there are enough of them. |
| **Series** | Run many queries, or sampled library papers, under one label and read them as one board with intervals. |
| **Sweep** | In the Lab, score a grid of blends on leave-one-out queries and see where quality lives on the TF-IDF / S-BERT / metadata triangle. The best blend is picked on half of the queries and confirmed on the other half, so a lucky winner is not mistaken for a finding. |

---

## The wiki

Re:Search documents itself. Once it is running, open the app and go to:

| Where | What is inside |
| --- | --- |
| **Walkthrough** (`/walkthrough`) | Every page and feature, with screenshots, laid out like a wiki: a page for each part of the application. |
| **Engine** (`/walkthrough-engine`) | Every formula the system computes, the similar-papers graph, how the Arena votes, and a worked example you can follow by hand. |

There is a search box, a contents rail and full-screen figures. We kept the surprises out of this README on purpose.

---

## Three ways to see it

| Mode | For |
| --- | --- |
| **Library** | Visitors: a calm "smarter librarian" with only the features the library staff enable. |
| **Researcher** | The full tool, every control switched on. |
| **Presentation** | The version that ships: no developer controls, the study's own features, formal names throughout, and a plain Settings page (account, preferences, about). |

Switch in **Settings**; Presentation has its own Settings page with the same switch. In Library and Presentation, the demo Pro purchase (nothing is charged) opens the **Lab** as a beta, with the tree in its Garden tab, and in Presentation the pixel pet too, all without developer controls. Presentation can also be left with a key combination and a password; the wiki says how.

---

## Quick start

You need **Python 3.10+** and **Node.js 18+**. The first run downloads the S-BERT model, so it needs internet once.

```bash
# 1. Backend  (from the project root)
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m scripts.rebuild_recommendation   # build the TF-IDF and S-BERT index
uvicorn app.api:app --reload --port 8000

# 2. Frontend  (in a second terminal)
cd frontend
npm install
npm run dev                           # http://localhost:5173
```

Sign in with any email and password: it is a single-user local app. For the research chat, copy `.env.example` to `.env` and add a `GROQ_API_KEY` (optional; everything else works without it). The longer, step-by-step version, with prerequisites and troubleshooting, is in [`docs/SETUP.md`](docs/SETUP.md).

---

## Under the hood

| Layer | Built with |
| --- | --- |
| Backend | FastAPI, SQLAlchemy, SQLite |
| Text and models | scikit-learn (TF-IDF), sentence-transformers (S-BERT), pdfplumber, YAKE |
| Sources | OpenAlex, Crossref, arXiv, Unpaywall, Semantic Scholar (public APIs, no scraping) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |

```text
app/            FastAPI app, models, and the services behind every feature
  services/recommendation/   the three signals, fusion, the Arena's comparison
frontend/       the React app (pages, components, the wiki)
scripts/        maintenance and evaluation scripts (rebuild the index, bulk upload, ...)
test/           backend tests
research-scholar-extension/  an optional Chrome extension for Google Scholar
thesis-paper/   the thesis chapters, appendices and LaTeX
docs/           the setup guide
```

---

## Tests

```bash
python -m unittest discover -s test          # backend
cd frontend && npm run test:units            # frontend logic
cd frontend && npm run check                 # type-check
```

To try destructive actions (deleting papers, say) without touching your data, point a second backend at a copy of the database with `RESEARCH_DB_PATH=/path/to/copy.db`; add `RESEARCH_CORS_ORIGINS=http://localhost:5174` if you also run a second dev server.

---

## Good to know

- **Scope.** One machine, one SQLite file, text-based signals only. There is no collaborative filtering and no user profiling; scanned PDFs are not OCR'd, so extraction from them is rough. The thesis lists the delimitations in full.
- **Your data stays local.** Web lookups only ask public scholarly APIs; nothing is uploaded anywhere. Saving a web result copies its metadata into your own database.
- **Rebuild after big changes.** The index goes stale when the repository changes; the app says so and offers a rebuild button.

---

*Re:Search · BulSU BSMCS thesis project.*

# Setup guide

The step-by-step installation notes for Re:Search, kept from the original README.
The [README](../README.md) has the quick start; come here for prerequisites,
environment problems and where things are stored.

> Written for the early prototype. Commands and folder names are still right;
> for what the application does today, read the in-app wiki (`/walkthrough`)
> rather than any feature description in this file.

---

## Requirements

### Backend

- Python 3.10 or newer
- Internet access for the first S-BERT model download
- Enough disk space for the S-BERT model and generated representations

Main Python dependencies include:

- SQLAlchemy
- FastAPI
- Uvicorn
- pdfplumber
- scikit-learn
- sentence-transformers
- joblib
- NumPy
- YAKE
- requests
- python-multipart

### Frontend

- Node.js 18 or newer
- npm

Frontend dependencies include:

- React 18
- React Router 6
- TypeScript 5
- Tailwind CSS 3
- Vite 5

---

## Project Structure

```text
kazuyaaaadesu-tfidf-sbert-metadata-recommendationsystem/
│
├── app/
│   ├── api.py
│   ├── database.py
│   ├── schemas.py
│   ├── data/
│   │   └── tfidf_vectorizer.joblib
│   ├── models/
│   │   └── models.py
│   ├── repositories/
│   │   └── queries.py
│   └── services/
│       ├── bib_extraction.py
│       ├── classification.py
│       ├── extraction.py
│       ├── latex_extraction.py
│       ├── local_user.py
│       ├── pdf_finder.py
│       ├── storage.py
│       ├── text_preparation.py
│       ├── upload_paper.py
│       ├── validation.py
│       └── recommendation/
│           ├── search_service.py
│           ├── similarity.py
│           ├── sbert_pipeline.py
│           └── tfidf_pipeline.py
│
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── api.ts
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── BibTeXImport.tsx
│       │   ├── FindPdfPanel.tsx
│       │   ├── PaperViewerModal.tsx
│       │   ├── RecommendationIndexAlert.tsx
│       │   ├── RecommendationRebuildButton.tsx
│       │   ├── Upload.google-scholar-dnd.tsx
│       │   ├── WeightBar.tsx
│       │   └── ui/
│       ├── data/
│       │   └── pipelineConfigs.ts
│       ├── layouts/
│       │   ├── AppLayout.tsx
│       │   └── AuthLayout.tsx
│       └── pages/
│           ├── auth/
│           ├── evaluation/
│           ├── main/
│           └── repository/
│
├── research-scholar-extension/
│   ├── background.js
│   ├── content.js
│   └── manifest.json
│
├── scripts/
│   ├── bulk_upload.py
│   ├── classify_existing_papers.py
│   ├── init_script.py
│   ├── inspect_papers.py
│   ├── migrate_add_battle_research_log.py
│   ├── migrate_add_stored_path.py
│   ├── rebuild_recommendation.py
│   ├── rebuild_recommendation_index.py
│   ├── reextract_metadata.py
│   ├── search_papers.py
│   └── view_database.py
│
├── storage/
│   ├── recommendation_index_status.json
│   ├── exports/
│   └── papers/
│
├── test/
│   ├── test_extraction.py
│   └── test_upload_flow.py
│
├── requirements.txt
└── README.md
```

---

## Setup

The project has two separately installed environments:

- **Python environment** for the FastAPI backend, database, PDF/BibTeX processing, and recommendation pipelines.
- **Node.js environment** for the React/Vite frontend.

You should install both before running the complete application.

> **Windows note:** The commands below use PowerShell. Run them from the project root unless the command explicitly changes into `frontend/`.

### 0. Install the prerequisites

Install the following before creating the project environments:

#### Python

Use **Python 3.10 or newer**.

Verify the installation:

```powershell
python --version
```

Expected format:

```text
Python 3.x.x
```

If `python` is not recognized on Windows, install Python and make sure it is available on `PATH`.

#### Node.js and npm

Install **Node.js 18 or newer**. npm is included with Node.js.

Verify both:

```powershell
node --version
npm --version
```

Expected format:

```text
v18.x.x
10.x.x
```

#### Git

Git is recommended for cloning and updating the repository.

Verify:

```powershell
git --version
```

### 1. Open the project

If the repository has already been cloned:

```powershell
cd "G:\OJT files\TFIDF-SBERT-Metadata-RecommendationSystem"
```

If cloning from Git:

```powershell
git clone <repository-url>
cd <repository-folder>
```

The project root should contain:

```text
README.md
requirements.txt
app/
frontend/
scripts/
storage/
test/
```

### 2. Create the Python virtual environment

From the project root:

```powershell
python -m venv .venv
```

This creates a local Python environment inside:

```text
.venv/
```

Each developer should have their own `.venv`.

### 3. Activate the Python environment

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
source .venv/bin/activate
```

If activation is successful, the terminal should show:

```text
(.venv)
```

If PowerShell blocks the activation script, you can allow scripts for the current PowerShell user with:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Then activate the environment again:

```powershell
.\.venv\Scripts\Activate.ps1
```

### 4. Upgrade pip

With `.venv` activated:

```powershell
python -m pip install --upgrade pip
```

### 5. Install backend dependencies

Install the exact project dependency list:

```powershell
python -m pip install -r requirements.txt
```

The current `requirements.txt` includes:

```text
SQLAlchemy>=2.0
pdfplumber>=0.11
scikit-learn
sentence-transformers
joblib
numpy
yake
fastapi>=0.111
uvicorn[standard]>=0.30
python-multipart>=0.0.9
requests
```

Verify important packages after installation:

```powershell
python -c "import fastapi, sqlalchemy, sklearn, sentence_transformers, pdfplumber; print('Backend dependencies OK')"
```

### 6. Initialize the database

Only initialize the database when it has not already been initialized:

```powershell
python -m scripts.init_script
```

This creates the required SQLite tables.

The database is expected at:

```text
app/data/academic_repository.db
```

> **Important:** If the repository already contains the team's populated `academic_repository.db`, do **not** run the initialization script unnecessarily. Work on the existing database instead.

### 7. Run the stored-path migration if required

If you are using an older database that does not contain the `stored_path` column:

```powershell
python -m scripts.migrate_add_stored_path
```

The migration is safe to run when the column already exists; the script checks for the column before adding it.

Do not run unrelated migrations unless the project actually requires them.

### 7b. Run the battle-log migration if required

If you are using an older database whose `battle_runs` table predates the
research log, add the run's label, subject class, query kind, knobs, corpus
fingerprint and stored comparison response:

```powershell
python -m scripts.migrate_add_battle_research_log
```

Existing rows are untouched; only `query_kind` is filled in, from
`query IS NULL`. The script is safe to run more than once.

### 8. Prepare the storage directories

The application uses:

```text
storage/
├── recommendation_index_status.json
├── exports/
└── papers/
```

If these directories do not exist yet, create them:

```powershell
New-Item -ItemType Directory -Force .\storage\papers
```

The application also creates required storage directories when saving files.

### 9. Install frontend dependencies

Open a second terminal, or remain in the first terminal and change directories after finishing backend setup:

```powershell
cd frontend
npm install
```

This installs the dependencies declared in:

```text
frontend/package.json
```

The frontend uses:

- React 18
- React Router 6
- TypeScript 5
- Tailwind CSS 3
- Vite 5

Verify the frontend can build:

```powershell
npm run build
```

If the build succeeds, return to the project root when needed:

```powershell
cd ..
```

### 10. Configure the frontend API URL

The frontend reads:

```text
VITE_API_URL
```

If it is not provided, the frontend falls back to:

```text
http://localhost:8000
```

For local development, no environment variable is normally required if the backend is running on the default FastAPI port.

If a custom backend URL is required, create:

```text
frontend/.env.local
```

with:

```text
VITE_API_URL=http://localhost:8000
```

Do not commit local secrets or machine-specific environment files.

### 11. Build the initial recommendation index

After the database contains papers, build the recommendation representations before using TF-IDF or S-BERT recommendations:

```powershell
cd "G:\OJT files\TFIDF-SBERT-Metadata-RecommendationSystem"
.\.venv\Scripts\Activate.ps1
python -m scripts.rebuild_recommendation
```

The master rebuild:

1. Classifies papers when Subject/Category is missing.
2. Preserves existing Subject/Category values.
3. Validates recommendation metadata.
4. Rebuilds `prepared_text`.
5. Fits and stores the TF-IDF vectorizer.
6. Stores TF-IDF vectors.
7. Generates S-BERT embeddings.

The first S-BERT run can take significantly longer because the model may need to download.

The current S-BERT implementation uses:

```text
all-MiniLM-L6-v2
```

The model must be available locally before recommendation requests can complete.

### 12. Start the backend

From the project root with `.venv` activated:

```powershell
uvicorn app.api:app --reload
```

The API normally runs at:

```text
http://localhost:8000
```

FastAPI's interactive API documentation is normally available at:

```text
http://localhost:8000/docs
```

### 13. Start the frontend

Open another terminal:

```powershell
cd "G:\OJT files\TFIDF-SBERT-Metadata-RecommendationSystem\frontend"
npm run dev
```

Vite normally runs at:

```text
http://localhost:5173
```

The frontend communicates with the backend using the configured `VITE_API_URL`, or `http://localhost:8000` by default.

### 14. Optional — install the Google Scholar browser extension

The repository also contains:

```text
research-scholar-extension/
├── background.js
├── content.js
└── manifest.json
```

The extension is a Chrome Manifest V3 extension for sending Google Scholar BibTeX citations into the local Re:Search frontend.

To load it in Chrome:

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the project's `research-scholar-extension/` folder.
6. Keep the Re:Search frontend running at `http://localhost:5173` or `http://127.0.0.1:5173`.

The extension manifest currently targets Chrome 110+.

### 15. Verify the installation

With the backend running, verify the API:

```powershell
Invoke-WebRequest http://localhost:8000/docs
```

Then verify the frontend by opening:

```text
http://localhost:5173
```

You should be able to access the Re:Search interface.

For a backend smoke test, run:

```powershell
python -m test.test_upload_flow sample.pdf
```

For repository search:

```powershell
python -m scripts.search_papers --pipeline tfidf --query "neural networks"
```

or:

```powershell
python -m scripts.search_papers --pipeline sbert --query "neural networks"
```

### Recommended installation order

For a clean first-time setup, use this order:

```text
Install Python
      ↓
Install Node.js
      ↓
Open project root
      ↓
Create + activate .venv
      ↓
Install requirements.txt
      ↓
Initialize/migrate database if required
      ↓
npm install inside frontend/
      ↓
Add/import papers
      ↓
Run rebuild_recommendation
      ↓
Start FastAPI
      ↓
Start Vite
      ↓
Open Re:Search in the browser
```

---

## Environment Verification

Before troubleshooting the application, verify that the correct tools are being used:

```powershell
python --version
python -m pip --version
node --version
npm --version
```

When the Python virtual environment is active, `python` and `pip` should resolve to the `.venv` environment.

You can also verify the installed Python dependencies with:

```powershell
python -c "import fastapi, sqlalchemy, sklearn, sentence_transformers, pdfplumber; print('Backend dependencies OK')"
```

For the frontend, from `frontend/`:

```powershell
npm run build
```

A successful build confirms that the installed Node dependencies and TypeScript/Vite configuration are usable.

---

## Running the Application

The backend and frontend run as separate development processes.

### Backend

From the project root:

```powershell
uvicorn app.api:app --reload
```

The API is normally available at:

```text
http://localhost:8000
```

### Frontend

In a second terminal:

```powershell
cd frontend
npm run dev
```

The Vite development server normally uses:

```text
http://localhost:5173
```

The frontend uses the `VITE_API_URL` environment variable when provided and otherwise falls back to:

```text
http://localhost:8000
```

---

## Database and Storage

### SQLite database

The application database is stored at:

```text
app/data/academic_repository.db
```

### TF-IDF vectorizer

```text
app/data/tfidf_vectorizer.joblib
```

### Uploaded paper files

```text
storage/papers/
```

Paper files are stored using the paper ID, for example:

```text
storage/papers/74.pdf
```

or, for imported BibTeX records:

```text
storage/papers/74.bib
```

The database stores the relative storage path.

### Recommendation index status

```text
storage/recommendation_index_status.json
```

This file records whether repository changes have made the recommendation index stale.

### Battle log exports

```text
storage/exports/
```

The Arena writes a JSONL archive of its recorded battle runs here when the
battle log is archived and reset, for example:

```text
storage/exports/battle_runs-20261009-142501.jsonl
```

Each line carries one run in full, including the consensus ranking and
pairwise agreement computed at the time. The directory is created when the
first archive is written. Existing archives are never overwritten, and
nothing in the application deletes them -- this is collected study data.

---

## Common Issues

### `ModuleNotFoundError: No module named 'app'`

Run Python modules from the project root:

```powershell
python -m scripts.view_database
```

instead of executing a module file directly.

### S-BERT model download problems

Check that:

- `.venv` is activated.
- `requirements.txt` has been installed.
- Internet access is available.
- Enough disk space is available.
- The selected S-BERT model can be downloaded.

An unauthenticated Hugging Face warning does not necessarily mean the model failed to load.

### Search results are outdated

Rebuild the recommendation data:

```powershell
python -m scripts.rebuild_recommendation
```

### Search results are unexpected

Check:

- The paper has valid recommendation metadata.
- `prepared_text` contains the expected title, abstract, and keywords.
- Recommendation vectors were generated after the latest metadata changes.
- The repository contains enough related papers for the query.

### Duplicate papers

Repeated imports or test uploads can create multiple records for the same paper.

Inspect the database:

```powershell
python -m scripts.view_database
```

Duplicate detection and cleanup remain a development concern before final evaluation.

---

# Packaging Re:Search as a macOS `.dmg`

**Status:** plan only. Nothing in this file has been built yet.
**Written:** 2026-10-09

## What we want

One double-clickable `Re-Search.app` that opens a window, starts its own
backend, and shows the app. The `.dmg` is just the installer wrapper; the
app itself is the deliverable.

Today the app is two processes the user starts by hand (a terminal running
uvicorn on :8000, and Vite on :5173). Packaging removes both steps.

---

## The hard constraint: torch

Measured on this machine:

| Thing | Size |
| --- | --- |
| `.venv` in total | **1.2 GB** |
| `torch` alone | 587 MB |
| `transformers` | 115 MB |
| `sentence-transformers` | 6 MB |
| `scikit-learn` | 49 MB |
| S-BERT model (`all-MiniLM-L6-v2`, real size) | 87 MB |
| `app/data` (indexes + vectorizer) | 12 MB |
| `storage/papers` | 93 MB |
| `frontend/dist` | 58 MB |
| `frontend/public` (wiki screenshots) | 51 MB |
| Electron itself | ~250 MB installed |

The backend cannot be shipped as source — the user would need Python and a
1.2 GB virtualenv. So the backend must be frozen into a binary or shipped
wholesale. **This is the decision that drives the whole plan, and it has a
real cost: the `.dmg` will land somewhere between 900 MB and 1.6 GB.**

The single biggest lever is torch. It is needed only to run the S-BERT
encoder. If we are willing to drop the semantic signal, torch, transformers
and sentence-transformers all go away and the app becomes a few hundred MB.
That is a *product* decision, not a build decision, and I have not made it.

---

## Options considered

### Option A — Electron shell + shipped virtualenv

Bundle `.venv`, `.dmg` holds a `python` binary and site-packages.

- Pros: no PyInstaller fights; fastest route to a working app; the backend
  runs the exact code that passes the tests today.
- Cons: `torch` ships as loose files inside the app bundle; macOS Gatekeeper
  quarantines an unsigned bundle of native `.dylib`s more aggressively than a
  single signed binary. Large.
- Risk: medium. Mostly packaging plumbing.

### Option B — Electron shell + PyInstaller one-file backend

Freeze `app.api:app` into one executable.

- Pros: cleanest bundle layout; only the imported modules ship.
- Cons: PyInstaller must trace sentence-transformers + torch + sklearn
  dynamic imports. Hidden-import lists are usually needed and are the usual
  source of "works on my machine" failures. One-file mode also unpacks to
  `/tmp` on each launch, which slows start-up noticeably with a 587 MB
  payload; onedir mode avoids that but is less tidy.
- Risk: **high.** This is where the time goes.

### Option C — drop torch, ship the lexical + metadata signals only

Rebuild the index without S-BERT, ship no torch.

- Pros: by far the smallest app (~250–350 MB), no PyInstaller pain, fast
  cold start.
- Cons: changes the product. Three of the six Arena pipelines and the
  semantic cluster graph lose a signal. The README, the wiki and the thesis
  chapters all describe S-BERT as one of the three signals, so the docs
  would need updating too.
- Risk: low technically, high in terms of scope.

### Recommendation

**Option A first, then evaluate B.** A is a few hours of work and produces
something that demonstrably runs; if its bundle behaviour with torch turns
out to be bad, B is the fallback. C should only be taken if the size is the
binding constraint, and it is a thesis-scope decision, not a build one.

---

## Also fixed along the way (these are real changes, not build steps)

The frontend and backend currently assume two servers, and packaging breaks
both assumptions. Each item below is a code change that must land for the
`.app` to work.

1. **Serve the built frontend from FastAPI.** There is no `StaticFiles`
   mount today. Mount `frontend/dist` at `/` and the whole CORS problem
   disappears: one origin, `http://127.0.0.1:<port>`.
2. **API base URL.** `src/api.ts:4` hardcodes `http://localhost:8000`. It
   must read the port the app actually launched on. Simplest correct fix: a
   relative base (`""`) once the frontend is served by the backend. The dev
   server keeps `VITE_API_URL` for the split-server workflow.
3. **Router.** `createBrowserRouter` needs real URL paths. Serving over
   HTTP (fix 1) makes that work as-is; Electron loading `file://` would not,
   so this is why fix 1 is not optional.
4. **Writable data directory.** `app/database.py:19` and
   `app/services/storage.py:29` resolve paths relative to the source tree.
   Inside a signed app bundle that location is read-only. Both must move to
   `~/Library/Application Support/Re-Search/`, with first-run copy of the
   seed database and indexes. Same for the index writes in
   `vector_index.py:62`.
5. **HF model cache.** `sbert_pipeline.py:83` walks
   `~/.cache/huggingface`. In a packaged app that cache may be empty, so the
   first launch would try to download 87 MB. Set `HF_HOME` (or
   `SENTENCE_TRANSFORMERS_HOME`) into Application Support and ship the model
   inside the bundle for a copy on first run.
6. **`.env` / `GROQ_API_KEY`.** Never bake the real key into the bundle. Read
   it from Application Support, and let the research chat degrade to its
   existing "not configured" message when absent — that path already exists
   at `research_chat.py:385`.
7. **Port selection.** Hardcoding 8000 means a second instance, or a
   collision with something else on the machine, breaks the app. Bind to
   port 0, read the chosen port back, and hand it to the frontend.
8. **Backend lifecycle.** Electron starts uvicorn as a child process and must
   kill it on quit, or the app leaves an orphan holding the port.

---

## Step 1 — Make the backend serve the frontend (no Electron yet)

Goal: `uvicorn app.api:app --port 8000` alone gives the whole app in a
browser. This is worth doing on its own, independent of packaging: it
removes the two-terminal workflow and proves the single-origin assumption.

- Mount `StaticFiles` for `frontend/dist` at `/`, with an SPA fallback so
  deep links like `/walkthrough` resolve.
- Switch the frontend base URL to relative; keep `VITE_API_URL` for dev.
- Verify by hand: every page loads, a recommendation runs, deep links work.

**Done when** the browser at :8000 is indistinguishable from the :5173 build.

## Step 2 — Move state out of the source tree

- Add a `RESEARCH_DATA_DIR` resolver defaulting to the project root (so
  tests and the existing workflow are untouched) and pointing at
  `~/Library/Application Support/Re-Search` in the packaged build.
- Point `database.py`, `storage.py` and `vector_index.py` at it.
- First run: copy the seed database, the indexes and the vectorizer if the
  destination is empty.
- Verify: launch twice, confirm state persists and nothing is written back
  into the repo.

**Done when** a packaged build never writes inside its own bundle.

## Step 3 — Scaffolding the Electron shell

- `electron/main.ts`: pick a free port, spawn the backend as a child
  process, wait for `/api/health`, open a window at that port, kill the
  child on quit.
- `electron/preload.ts`: keep the renderer sandboxed; no `nodeIntegration`.
- Point `VITE_API_URL` at the chosen port at build time.
- Verify as a plain app: launch, quit, confirm no orphan uvicorn remains.

## Step 4 — Bundle the backend (Option A)

- Ship the virtualenv; set `HF_HOME` into Application Support and copy the
  model on first run.
- `electron-builder` config: `app` product, `dmg` target, `mac` category,
  hardened runtime, no `asar` for the virtualenv (native `.dylib`s must stay
  unpacked and executable).

## Step 5 — Signing and the `.dmg`

**There is no signing identity on this machine** — `security find-identity`
reports `0 valid identities found`. So the output will be an **unsigned**
`.dmg`.

- Without signing, macOS Gatekeeper blocks the app on first open. Users must
  right-click → Open, or run
  `xattr -dr com.apple.quarantine /Applications/Re-Search.app`.
- This is fine for a thesis demo on your own machine and for sharing with a
  supervisor, but it is not distributable to anyone else without an Apple
  Developer account (free tier is enough, but it needs enrolment and a
  notarisation round-trip).
- Decide: demo-only unsigned, or enrol in Apple Developer and notarise.

## Step 6 — Verify the packaged app

- Launch from Finder, not a terminal.
- Full pass: Repository search, a web search, Recommend, Arena, My Library
  graph, Upload a PDF, Ask the tree, and the research chat's
  no-key message.
- Quit and confirm no orphaned processes and no writes into the bundle.
- Confirm state survives a relaunch and an app restart.

---

## Effort and risk, honestly

| Step | Estimate | Risk |
| --- | --- | --- |
| 1 — serve frontend from FastAPI | 1–2 h | low |
| 2 — move state to Application Support | 2–3 h | medium (touches persistence) |
| 3 — Electron shell | 3–4 h | medium (process lifecycle) |
| 4 — bundle the backend | 3–5 h | medium–high (torch on macOS) |
| 5 — sign and package | 1 h + enrolment | low, but blocked without an identity |
| 6 — verify | 1–2 h | low |

Roughly two working days for Option A, with the PyInstaller fallback adding
most of a day if it is needed.

---

## Open questions for you

1. **Is the size acceptable?** ~1.2 GB is the honest figure if S-BERT ships.
   If you want it materially smaller, that is Option C and it changes the
   product, not just the build.
2. **Unsigned or signed?** Unsigned is fine for a demo on your own machine.
   Distribution to other machines needs Apple Developer enrolment.
3. **Which signal set ships?** Only matters if you go with Option C.
4. **Where should the app live?** I have assumed
   `~/Library/Application Support/Re-Search/`. Say if you want it elsewhere.
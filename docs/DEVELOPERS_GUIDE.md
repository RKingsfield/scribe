# Developer's guide

How to get scribe running locally and start contributing.

## Prerequisites

- Python 3.12+
- Node.js 18+
- Docker (for production builds and deployment)

## Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
uvicorn scribe.main:app --reload    # dev server on :8000
```

### Running tests

```bash
cd backend
pytest -q                            # full suite
pytest tests/test_foo.py::test_bar   # single test while iterating
```

Tests use `tmp_path`-based project trees — no filesystem mocking. The backend test stage also runs inside the Docker build, so a failing test blocks the image from being built.

## Frontend

```bash
cd frontend
npm install
npm run dev                          # vite dev server on :5173
npm run build                        # production build
```

### Running tests

```bash
cd frontend
npx vitest run                       # full suite
npx vitest run src/lib/syncEngine    # single file
```

Frontend tests use vitest + fake-indexeddb.

## Configuration

| Variable | Default | What it does |
|----------|---------|-------------|
| `WRITING_ROOT` | `/data/writing` | Where your novel directories live |
| `APPDATA_ROOT` | `/data/appdata` | App data (git config, RAG recipes) |
| `ORCHESTRATOR_URL` | `http://localhost:11435` | OpenAI-compatible LLM endpoint for chat and rewrite |
| `ANTHROPIC_API_KEY` | unset | Enables Claude models in the model picker |
| `QDRANT_URL` | unset | Qdrant endpoint for RAG queries |
| `EMBED_URL` | unset | Embedding server for RAG queries |
| `AUTOCOMMIT_INTERVAL_MIN` | `10` | Minutes between automatic git commits |

## Building and deploying

```bash
docker build -t scribe .
docker run -d \
  -p 3030:3030 \
  -v /path/to/writing:/data/writing \
  -v /path/to/appdata:/data/appdata \
  scribe
```

The Dockerfile is multi-stage: a frontend build stage, then a backend runtime stage. A dedicated test stage runs pytest inside the build — the image won't build if any test fails.

For production, point your reverse proxy at port 3030. Mount two volumes: one for your writing directory (novel files) and one for app data (git config, RAG recipes). Both paths are configurable via the environment variables above.

Scribe has no external database — all state is on the filesystem. Back up the two mounted volumes and you've backed up everything.

## Project layout

```
backend/    FastAPI + Python 3.12 (GitPython, APScheduler, watchdog, python-frontmatter)
frontend/   React 18 + Vite + TypeScript + CodeMirror 6 + Dexie + cmdk
docs/       ARCHITECTURE / DESIGN / this file
Dockerfile  multi-stage: frontend build → backend runtime
```

## Contributing

The codebase is split cleanly between backend (Python) and frontend (TypeScript). Both can run independently in dev mode — the Vite dev server proxies API requests to the backend.

Before submitting changes:

1. Backend tests pass: `cd backend && pytest -q`
2. Frontend builds cleanly: `cd frontend && npm run build`
3. Frontend tests pass: `cd frontend && npx vitest run`

The Docker build runs backend tests as a build stage, so anything that passes locally will pass in CI.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data model, module layout, request flow
- [DESIGN.md](DESIGN.md) — why it's built this way, each trade-off explained

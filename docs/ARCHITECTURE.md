# Architecture

How scribe works: data model, backend layers, API surface, frontend modules, sync engine, and deploy pipeline.

## Data model

All content is plaintext markdown with YAML frontmatter, stored on disk in a directory-per-chapter layout.

```
<writing-root>/
  <project-slug>/
    project.yml                       # title, slug, author, default_model, acts, categories
    .git/                             # auto-init'd, pushes to configured remote
    chapters/
      01_Chapter_01/                    # two-counter slug: position 1, chapter #1
        chapter.md                    # frontmatter: title, summary, chapter, order, act
        01.md                         # scene -- frontmatter: scene, order, status, pov, words_target, summary, title
      17_Chapter_16/                  # two-counter slug: position 17, chapter #16
        chapter.md
        01.md
        02.md
      16_Interlude_01/                # position 16, interlude #1
        chapter.md                    # frontmatter includes kind: interlude, interlude: 1
        01.md
    references/*.md                   # frontmatter: title, aliases, tags
    character-profiles/*.md           # frontmatter: title, aliases, tags
    <custom-folder>/*.md              # user-defined categories via project.yml
```

### Slug format

Two-counter slugs: `{position:02d}_{Chapter|Interlude}_{ordinal:02d}`. Position is a single filesystem-ordering counter shared across chapters and interludes. Ordinal is per-kind (chapter ordinals stay tight even with interludes inserted between them).

### Sort order

`order` frontmatter is the sort key for both chapters and scenes. Filenames are stable and never auto-renumbered on reorder. Drag-reorder updates `order` values only.

### Structural hierarchy

Chapter is a structural wrapper (like Act). Status, POV, and word target live on scenes only. `chapter.md` holds title, summary, chapter number, order, and act assignment.

### Conflict files

When an offline write loses an etag race, the loser is written as `<stem>.conflict.<deviceId>.<timestamp>.md` next to the canonical file. Conflict files are plaintext markdown, CLI-mergeable.

## Backend

FastAPI, Python 3.12. Thin routes over a layered architecture:

```
routes/          # HTTP handlers (thin)
storage/         # FS abstraction: paths, atomic write, frontmatter, manifest, project.yml model
chat/            # Scope bundles + Anthropic SSE translation
rag/             # Recipe builder (deterministic YAML)
export/          # Manuscript composer + pandoc subprocess
git/             # Git wrapper + autocommit scheduler
```

### Storage layer

| Module | Responsibility |
|--------|---------------|
| `paths.py` | Slug + path resolution. Blocks `..`, absolute paths, hidden dirs |
| `fs.py` | Atomic writes (temp + fsync + rename), sha256, etag = sha256[:16] of mtime+size+content |
| `frontmatter.py` | Parse/serialize via `python-frontmatter`, word_count helper |
| `project.py` | `project.yml` Pydantic model with `Act` (name only; membership from chapter frontmatter) and `Category` (name + folder + codex flag). `resolved_categories` returns configured categories or defaults |
| `helpers.py` | `slugify`, `classify_chapter_kind`, `slug_position`, `order_sort_key` |
| `manifest.py` | Recursive walk for sync |
| `structure.py` | `list_chapter_dirs`, `list_scenes` |

### Chat layer

- `context.py` -- `ScopeRequest` (Pydantic), `build_bundle(slug, scope, include_codex)` reads files for the requested scope, `render_system_prompt(title, bundle)` formats the system message. Bundle exposes `estimated_tokens = char_count // 4` for UI hint.
- `anthropic.py` -- `convert_messages` splits OpenAI-style messages into Anthropic's `(system, messages)` shape, `stream_anthropic` streams and re-emits in OpenAI SSE format, `ThinkBlockFilter` suppresses `<think>` blocks across chunk boundaries, `strip_think_blocks` regex for non-streaming.

### Export layer

`compose_manuscript` walks chapters in `order`, then scenes in `order`, drops frontmatter, emits `***` between scenes, strips `[[scene beats]]` by default. Optionally adds title page and chapter summaries. Non-markdown formats pipe through pandoc.

### Git layer

Git wrapper with a `BackgroundScheduler` for periodic autocommit + push.

## API

| Area | Endpoints | Notes |
|------|-----------|-------|
| Projects | `GET /api/projects`, `GET/PUT /api/projects/{slug}`, `POST /api/projects/{slug}/init` | Full nested tree with chapters, scenes, categories |
| Files | `GET/PUT/DELETE /api/projects/{slug}/file?path=`, `POST /file/move` | ETag concurrency; conflict-on-mismatch with `X-On-Conflict: save-as-conflict` |
| Structure | `POST /chapter/new`, `POST /chapter/{slug}/scene/new`, `DELETE /chapter/{slug}`, `POST /reorder`, `POST /scene/move`, `POST /character/new`, `POST /reference/new`, `POST /category/{folder}/new` | Auto-computes slugs/ordinals; scene/move is atomic cross-chapter |
| Sync | `GET /sync` (manifest with sha256+mtime per file), `GET/DELETE /conflicts` | Conflict files are plaintext |
| Git | `POST /git/commit` | Manual trigger; autocommit runs in background |
| Chat | `POST /chat/stream`, `POST /chat/rewrite`, `POST /chat/summarize`, `POST /scope/preview` | Routes to Anthropic for `claude-*` models |
| Models | `GET /api/models` | Proxies upstream + synthetic Claude entries when API key set |
| RAG | `GET/PUT/DELETE /rag/*`, `POST /rag/query` | Recipe on disk; ingest is external |
| Export | `GET /export?format=md\|docx\|html\|epub` | Composes manuscript, pipes to pandoc for non-md |
| Review | `GET/POST/PATCH/DELETE /review/sessions`, public `/review/t/{token}/*` | Token-gated beta reader access, sidecar comment storage |

## Frontend

React 18 + Vite + TypeScript + CodeMirror 6 + Dexie + cmdk.

```
src/
  app/                 # App.tsx (router), CommandPalette (cmdk), StatusBar, Toast
  features/
    project/           # ProjectView (shell), WriteView (3-pane), ChapterFlow, PlanBoard, Inspector, ReviewView
    sidebar/           # Sidebar.tsx -- act-grouped chapters, drag-reorderable, dynamic categories
    editor/            # Editor.tsx (CM6), codexLink, liveMarkdown, typewriter, detectKind
    chat/              # ChatView, ScopePicker, ChatThread, streaming.ts, threads.ts
    rewrite/           # RewriteDialog, diff.ts (word-level LCS)
    rag/               # RagPanel
    export/            # ExportPanel
    review/            # ManuscriptReader, CommentRail, BetaReaderView, anchoring.ts
    sync/              # ConflictsBanner
  lib/
    api.ts             # fetch wrappers
    syncEngine.ts      # singleton -- all data flow
    db.ts              # Dexie schema
    offlineTree.ts     # Pure functions for local tree mutation
```

### Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | ProjectPicker | Project selection |
| `/p/:slug` | ProjectView | Shell, redirects to /write |
| `/p/:slug/write` | WriteView | 3-pane: sidebar, editor, inspector |
| `/p/:slug/plan` | PlanBoard | Outline + status modes |
| `/p/:slug/chat` | ChatView | Scope picker + streaming |
| `/p/:slug/review` | ReviewView | Session management + manuscript reader |
| `/review/t/:token` | BetaReaderView | Standalone, public, token-gated |

### State management

No Redux/Zustand. React state + `localStorage` for persistence (theme, typewriter mode, sidebar/inspector collapse, plan mode, helper model, tag filters). `syncEngine` is a singleton class with listeners, not a React context -- keeps sync logic out of the React render cycle.

### Editor

CodeMirror 6 host. No line numbers, no active-line highlight. Typography: Source Serif 4 for body, Inter for UI, JetBrains Mono for tags.

Custom extensions:

| Extension | Purpose |
|-----------|---------|
| `liveMarkdown.ts` | Walks syntax tree, decorates emphasis/bold/code/strikethrough, hides markup chars when cursor is outside |
| `codexLink.ts` | Decorates character/reference names, Ctrl-click navigates to entry |
| `typewriter.ts` | Centered cursor mode |

Keyboard shortcuts: Mod-B/I/Shift-X/E for bold/italic/strikethrough/code, Mod-Shift-R for rewrite dialogue.

### Styling

Feature-scoped CSS files under `styles/`, imported via `styles/index.css` in cascade order (tokens first, responsive last). CSS variables in `tokens.css`. Dark default (warm charcoal), light "paper" mode (warm cream). Toggle persisted in localStorage.

## Sync and offline

The sync engine is local-first: writes go to IndexedDB immediately, then flush to the server in the background.

```
User edit
    |
    v
syncEngine.saveFile(slug, path, body, frontmatter, baseEtag)
    |
    |-- IDB cache.put({ ..., serverEtag: effectiveEtag })
    |
    +-- IDB pending.add({ ..., baseEtag: effectiveEtag })  (coalesced per file)
    |
    v  (background, 30s interval + online event)
flush()
    |
    |-- flushStructureOps()  -- replays queued creates/deletes/reorders
    |     +-- On success: remapTempPaths() in cache + tree + pending
    |
    +-- drain pending queue
          PUT /file with If-Match: baseEtag
          |
          |-- 200 OK -> cache.put({ serverEtag: response.etag }), pending.delete
          |
          +-- 412 + X-On-Conflict -> server writes conflict file
                cache.put({ serverEtag: response.etag })
                record conflict in IDB
```

### Design points

Reads are cache-first: `getFile`, `getTree`, `listProjects` return from IndexedDB immediately when cached, then background-refresh from the network. Writes are local-first: `saveFile` writes to cache + pending queue before attempting the network call. Pending writes are coalesced per (slug, path) so fast typing doesn't pile up stale states.

The cache's `serverEtag` is authoritative; the caller's `baseEtag` is only used on cold cache (see DESIGN.md #6 for the bug that taught us this).

Create chapter, create scene, and reorder all work offline via queued operations + local tree patching (`offlineTree.ts`). On reconnect: flush structure ops (with temp-to-real path remapping), flush pending writes, then tree refresh. `navigator.onLine` is a fast-path hint but not relied on for correctness.

## PWA / service worker

Precaches the full app shell from the build-time asset manifest. Hashed assets are cache-first; navigation is network-first with an index.html fallback. API requests are not intercepted -- letting them fail naturally means the sync engine's IDB cache handles offline reads and writes without the SW getting in the way.

Offline workflow: prefetch all project files into IndexedDB, go offline, read/edit/create via cached tree + pending queue, come online, auto-sync. Features that need the network (chat, rewrite, RAG, export, review) show a "requires internet" guard when offline.

## CI / deploy

```
git push to main
    |
    v
CI workflow
  1. checkout
  2. docker login to registry
  3. docker build --target test (pytest -- fails build if tests fail)
  4. docker build (runtime image)
  5. push image:latest + image:<sha>
  6. ssh to deploy host: docker pull + compose up -d
    |
    v
Live
```

Multi-stage Dockerfile: frontend build stage, then backend runtime stage. A dedicated test stage runs pytest inside the build -- the build fails if any test fails.

## Testing

Backend tests (pytest) cover storage, routes, structure ops, chat/streaming/Anthropic translation, sync integration, RAG, export, and review. Tests use `tmp_path`-based project trees, no filesystem mocking.

Frontend tests (vitest + fake-indexeddb) cover `offlineTree.ts` pure tree mutations, `syncEngine.ts` flush logic (etag authority, coalescing, conflict recording), and `sceneDrag.ts` move resolution.

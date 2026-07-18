# Design decisions

Why scribe works the way it does. Each numbered section below expands on a row in this table.

## Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Directory-per-chapter, not flat scene files | Flat files can't express chapter-level metadata distinct from per-scene metadata |
| 2 | `order` frontmatter as sort key, filenames stable | Renaming files is destructive and breaks CLI-agent workflows |
| 3 | Two-counter slug (`position_Kind_ordinal`) | `ls` order matches reading order; interludes don't bump chapter ordinal |
| 4 | One git repo per novel | Deleting a novel shouldn't rewrite shared git history |
| 5 | Local-first sync with IDB + etag | Typing must never feel laggy; writes go to IDB before the network |
| 6 | Cache's `serverEtag` is authoritative, caller's is fallback | Letting callers stamp the cache with stale etags caused conflict markers on every second save |
| 7 | No in-container RAG ingest | RAG tooling is ~1.5 GB; baking it into the image couples two release cycles |
| 8 | Anthropic SSE translated server-side | Keeps the frontend SSE parser unchanged; upstream provider is invisible to the SPA |
| 9 | Single ChapterFlow for 1 and N scenes | Count-based UX gating is almost always wrong; one layout handles N=1 fine |
| 10 | Shared helper model key (`scribe.rewrite.model`) | One mental model for "AI helper LLM"; separate keys add friction |
| 11 | Custom CM6 editor over TipTap/Lexical | Plaintext-on-disk fidelity; TipTap's doc tree round-trips markdown imperfectly |
| 12 | Manuscript composed server-side | `order` frontmatter is the sort key; pandoc multi-input mode needs files listed in dependency order |
| 13 | Chat in-app, not OpenWebUI plugin | OpenWebUI's plugin model is a tools sidecar, not a frontend embed; in-app chat shares the project tree |
| 14 | Atomic scene move endpoint | Half-moved scenes with no rollback; write-before-delete so a crash leaves a duplicate, not data loss |
| 15 | Act membership from frontmatter only | Range-based assignment contradicts drag-to-reorder; ranges were never maintained |

---

### 1. Directory-per-chapter

Originally planned flat files (`chapters/01.md`, `chapters/11.1.md`). Pivoted to `chapters/01/{chapter.md, 01.md}` because flat can't express chapter-level metadata distinct from per-scene metadata (chapter has its own summary/POV/character tags, plus scene-children with their own metadata). Single-scene chapters: `chapter.md` (metadata) + `01.md` (prose). When you split a chapter, just create `02.md`.

### 2. Order frontmatter as sort key

Filenames and `order` values can desync (`01.md` might have `order: 5.7` after dragging). Renaming files is destructive and breaks existing CLI-agent workflows. New chapter inserted near the start gets fractional `order`; renumbering files would change every chapter's history.

### 3. Two-counter slugs

Requirements: filesystem `ls` order matches reading order; `+ New Chapter` works without renaming; interludes don't bump the chapter ordinal.

Solution: `{position:02d}_{Chapter|Interlude}_{ordinal:02d}`. Position is a single counter shared across chapters and interludes (so `ls` order is correct). Ordinal is per-kind (so chapter ordinals stay tight even with interludes).

Edge cases: empty orphan dirs (failed delete) don't claim a position -- only non-empty dirs contribute to max_position. The caller's chapter field is a starting hint, not a hard constraint -- auto-bumps if it would collide.

Lesson: when a single counter encodes multiple concerns (filesystem order, chapter numbering, kind-aware bumping), split it into two distinct fields.

### 4. One repo per novel

Each novel is a separate git repo. Deleting a novel from the app shouldn't rewrite shared history.

### 5. Sync engine design

Local mirror in IDB (Dexie). Every read and write goes through the engine; it caches file body + frontmatter + server-etag locally so an offline reload still has content.

Pending-write queue is coalesced per (slug, path), so fast typing doesn't pile up writes; only the latest body is queued. Save path is local-first: `saveFile()` writes to IDB before attempting the network call. Flush loop runs in the background.

Conflict policy: server creates the marker, not the client. When flush gets an etag mismatch, the server writes the loser to a `.conflict.<deviceId>.<ts>.<ext>` file. Multiple conflicts can pile up; the resolution UI lists them all.

Service worker is intentionally minimal: precaches the SPA shell, stale-while-revalidate for hashed assets. API is not intercepted because caching API responses in the SW would race with the engine's IDB writes.

### 6. Etag bug and fix

First user-visible bug after the chapter-flow redesign: every save caused a conflict marker to be written.

Root cause: `syncEngine.saveFile()` was overwriting the cache's `serverEtag` with the caller's stale `baseEtag` on every save. The first save worked (caller's etag matched server), but the second save re-stamped the cache with the old etag, causing the PUT to use a stale `If-Match`.

Fix: cache is the source of truth. `saveFile` reads the cache first and uses its `serverEtag` if present; the caller's `baseEtag` is only used on cold cache (first time seeing the file).

Lesson: when a cache stores a "last known authoritative state" stamp, the cache must be the authority. Methods that take a stamp as input should treat it as a fallback, never as a fresh write.

### 7. No in-container RAG ingest

RAG ingest tooling is heavy (sentence-transformers, model download, GPU/CPU embed servers). Baking the binary into the scribe image would balloon it ~1.5 GB and tightly couple two release cycles. Instead, scribe writes the recipe to a shared volume and surfaces the literal CLI command. Recipe references host paths so it runs identically from any machine with the data mounted.

Deterministic yaml: `build_recipe` always produces the same dict from the same inputs. "Regenerate recipe" is idempotent.

Collection naming: `scribe-<slug>` prefix groups per-project corpora visually in collection listings.

### 8. Anthropic SSE translation

Frontend already understood OpenAI-style `data: {choices:[{delta:{content:"..."}}]}` chunks. Anthropic's Messages API streams a different shape (typed events). Two options: teach the frontend both formats, or translate in the backend. Chose backend translation. The boundary stays clean, the existing `streaming.ts` parser is unchanged, and the upstream provider is invisible to the SPA except for an `upstream` field in the leading `event: meta` chunk.

System-prompt placement: OpenAI puts system messages in the `messages` array; Anthropic expects a top-level `system` field. `convert_messages()` handles this split transparently.

`ThinkBlockFilter` suppresses `<think>` blocks from reasoning models across SSE chunk boundaries (stateful). Non-streaming path uses regex.

`max_tokens` is required by Anthropic (OpenAI accepts missing). Defaults to 4096 if not specified.

### 9. Single ChapterFlow

Initially gated `ChapterFlow` on `scenes.length > 1`, falling back to a plain Editor+Inspector for single-scene chapters. This was flagged immediately: two layouts means two code paths and a jarring experience when a chapter gains/loses a scene. Fix: drop the threshold to `>= 1`.

Lesson: count-based UX gating ("if 2+ items, use layout A; otherwise layout B") is almost always wrong. Pick the layout that handles N=1 gracefully and use it for everything.

### 10. Shared helper model key

Rewrite, summarize, and future AI helpers all share `localStorage['scribe.rewrite.model']`. The user wants one mental model: "this is the LLM my AI helpers use." They don't want to configure rewrite vs summarize separately.

### 11. Custom CM6 editor

About 600 lines: CM6 host + 4 custom extensions (liveMarkdown, codexLink, typewriter, toggleWrap) + EditorHandle for rewrite. TipTap, MDXEditor, and Lexical offer tables, slash commands, mention UI, etc. -- but their data model is a structured doc tree where markdown is a serialization that round-trips imperfectly. For a novelist editing prose with `[[scene beats]]` and codex-aware highlighting, almost none of those features matter, and plaintext-on-disk is the whole point.

If `@`-mention codex picker is ever wanted, `@codemirror/autocomplete` slots in without changing the editor's shape.

### 12. Server-side manuscript composition

Pandoc has multi-input mode, but relying on it for chapter/scene order means either renaming files (rejected, filenames are stable) or listing paths in dependency order on every invocation. Easier to compose unified markdown server-side, frontmatter-stripped, with explicit chapter headings + `***` scene breaks, then pipe one stream into pandoc.

Scene beats (`[[...]]`) are author scaffolding, not reader-facing prose, so they're stripped by default in export. Toggle available for authors who want notes in their draft exports.

### 13. Chat in-app vs OpenWebUI

OpenWebUI's plugin model is a tools/functions sidecar, not a frontend embed. In-app chat means: scope selection (everything/act/chapter/scene/codex) has direct access to the project tree; context assembly shares the same codebase; rewrite shares the same plumbing; and there's no second auth story.

### 14. Atomic scene move

Cross-chapter scene drag is not "rename" and not "reorder", it's both: move the file to a new chapter dir, update frontmatter, reorder siblings in both source and destination. Splitting into two round-trips risks half-moved scenes with no rollback. `POST /scene/move` does everything atomically, writing before deleting so a crash leaves a harmless duplicate, not data loss. Conflict-file siblings (`.conflict.*.md`) are moved alongside.

Frontend plumbing mirrors the pattern: `resolveSceneMove()` is a pure helper shared by Sidebar and PlanBoard that computes the move from dnd-kit events, then dispatches to either `syncEngine.reorderItems` (same-chapter) or `syncEngine.moveScene` (cross-chapter). Offline moves patch the queued `new-scene` op in place if the scene hasn't been flushed yet.

---

## Other design notes

### Rewrite: modal over inline popup

A floating "Rewrite" pill above the selection (Notion-style) sounds nicer, but CM6 selection rendering + DOM overlay anchored to a CM range is fiddly, and the rewrite needs space for side-by-side preview + diff + instruction box. A modal is more honest: this isn't a quick action, it's a focused comparison.

Voice-matching via +/-600 chars of surrounding context, not RAG. For a focused passage rewrite this is sufficient.

Word-level LCS diff instead of character diff. Gives clean boundaries on prose: "walked very quickly" -> "strode" shows as block changes, not character noise.

### Review system: fuzzy text anchoring

Comments use `{prefix, exact, suffix}` text anchors rather than character offsets. This survives edits to surrounding text because the anchor can be fuzzy-matched against the current document state.

### Drag-and-drop took four iterations

1. Tiny grip glyph as drag target -- too narrow to hit reliably.
2. Whole row draggable with `PointerSensor distance: 6` to separate click from drag.
3. One global DndContext spanning the chapters section. The per-act version meant a lone chapter in an act had nothing to swap with.
4. Dragging across acts writes `act` frontmatter. The old range-based assignment meant chapters snapped back after a drag. Empty acts got explicit drop zones.

### New scene/chapter shouldn't navigate away from plan view

The plan view is a planning context, not an editing context. Creating a scene or chapter shouldn't punt the user into the editor.

---

## Known couplings

### Slug computation

Both backend and frontend compute position/ordinal for new chapters. Backend is authoritative; frontend mirrors the algorithm for offline creates (temp slug). If the backend algorithm changes, offline creates may produce mismatched ordinals until reconnect, when `flushStructureOps` replays against the real backend.

### Helper model preference

All AI helpers share one `localStorage` key, exposed in the rewrite dialogue header and ChapterFlow scene sidecard. The Outline button reads the same key but doesn't expose a picker inline -- the tooltip shows the current value.

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
| 16 | Review sessions stored in APPDATA_ROOT, not WRITING_ROOT | Session tokens are app state, not novel content; storing in WRITING_ROOT committed them to the per-novel Forgejo repo |
| 17 | Generic webhook alerting over ntfy-specific | `ALERT_WEBHOOK_URL` + style flag keeps the published app provider-agnostic; ntfy is one style, generic JSON is the default |
| 18 | Conflict response returns canonical body | Returning the submitted body poisoned the cache, letting auto-save silently overwrite the winner |
| 19 | Block pending writes during active conflicts | Without this, the 800ms debounced save re-queues the editor's content before the user can resolve |
| 20 | Unconditional PUT /file without If-Match | Sync engine's cold-cache path sends no If-Match; server treats omission as explicit opt-out of conflict detection |

---

### 1. Directory-per-chapter

Originally planned flat files (`chapters/01.md`, `chapters/11.1.md`). Pivoted to `chapters/01/{chapter.md, 01.md}` because flat can't express chapter-level metadata distinct from per-scene metadata (chapter has its own summary/POV/character tags, plus scene-children with their own metadata). Single-scene chapters: `chapter.md` (metadata) + `01.md` (prose). When you split a chapter, just create `02.md`.

### 2. Order frontmatter as sort key

Filenames and `order` values can desync (`01.md` might have `order: 5.7` after dragging). Renaming files is destructive and breaks existing CLI-agent workflows. New chapter inserted near the start gets fractional `order`. Renumbering files instead would change every chapter's history.

### 3. Two-counter slugs

Requirements: filesystem `ls` order matches reading order; `+ New Chapter` works without renaming; interludes don't bump the chapter ordinal.

Solution: `{position:02d}_{Chapter|Interlude}_{ordinal:02d}`. Position is a single counter shared across chapters and interludes (so `ls` order is correct). Ordinal is per-kind (so chapter ordinals stay tight even with interludes).

Edge cases: empty orphan dirs (failed delete) don't claim a position: only non-empty dirs contribute to max_position. The caller's chapter field is a starting hint, not a hard constraint: the backend auto-bumps if it would collide.

Lesson: when a single counter encodes multiple concerns (filesystem order, chapter numbering, kind-aware bumping), split it into two distinct fields.

### 4. One repo per novel

Each novel is a separate git repo. Deleting a novel from the app shouldn't rewrite shared history.

### 5. Sync engine design

Local mirror in IndexedDB (via Dexie). Every read and write goes through the engine, which caches file body + frontmatter + server-etag locally so an offline reload still has content.

Pending-write queue is coalesced per (slug, path), so fast typing doesn't pile up writes: only the latest body is queued. Save path is local-first: `saveFile()` writes to IDB before attempting the network call. Flush loop runs in the background.

Conflict policy: server creates the marker, not the client. When flush gets an etag mismatch, the server writes the loser to a `.conflict.<deviceId>.<ts>.<ext>` file. Multiple conflicts can pile up, and the resolution UI lists them all.

Service worker is intentionally minimal: precaches the SPA shell, stale-while-revalidate for hashed assets. API is not intercepted because caching API responses in the SW would race with the engine's IDB writes.

### 6. Etag bug and fix

First user-visible bug after the chapter-flow redesign: every save caused a conflict marker to be written.

Root cause: `syncEngine.saveFile()` was overwriting the cache's `serverEtag` with the caller's stale `baseEtag` on every save. The first save worked (caller's etag matched server), but the second save re-stamped the cache with the old etag, causing the PUT to use a stale `If-Match`.

Fix: cache is the source of truth. `saveFile` reads the cache first and uses its `serverEtag` if present. The caller's `baseEtag` is only used on cold cache (first time seeing the file).

Lesson: when a cache stores a "last known authoritative state" stamp, the cache must be the authority. Methods that take a stamp as input should treat it as a fallback, never as a fresh write.

Corollary: reads never stamp the cache while a write is pending for that file: `getFile`'s network refresh skips its `cache.put` entirely when `db.pending` holds an entry for `(slug, path)`. Only a flush response is allowed to reconcile the cache's etag.

### 7. No in-container RAG ingest

RAG ingest tooling is heavy (sentence-transformers, model download, GPU/CPU embed servers). Baking the binary into the scribe image would balloon it ~1.5 GB and tightly couple two release cycles. Instead, scribe writes the recipe to a shared volume and surfaces the literal CLI command. Recipe references host paths so it runs identically from any machine with the data mounted.

Deterministic yaml: `build_recipe` always produces the same dict from the same inputs. "Regenerate recipe" is idempotent.

Collection naming: `scribe-<slug>` prefix groups per-project corpora visually in collection listings.

### 8. Anthropic SSE translation

Frontend already understood OpenAI-style `data: {choices:[{delta:{content:"..."}}]}` chunks. Anthropic's Messages API streams a different shape (typed events). Two options: teach the frontend both formats, or translate in the backend. Chose backend translation. The boundary stays clean, the existing `streaming.ts` parser is unchanged, and the upstream provider is invisible to the SPA except for an `upstream` field in the leading `event: meta` chunk.

System-prompt placement: OpenAI puts system messages in the `messages` array, but Anthropic expects a top-level `system` field. `convert_messages()` handles this split transparently.

`ThinkBlockFilter` suppresses `<think>` blocks from reasoning models across SSE chunk boundaries (stateful). Non-streaming path uses regex.

`max_tokens` is required by Anthropic (OpenAI accepts missing). Defaults to 4096 if not specified.

### 9. Single ChapterFlow

Initially gated `ChapterFlow` on `scenes.length > 1`, falling back to a plain Editor+Inspector for single-scene chapters. This was flagged immediately: two layouts means two code paths and a jarring experience when a chapter gains/loses a scene. Fix: drop the threshold to `>= 1`.

Lesson: count-based UX gating ("if 2+ items, use layout A; otherwise layout B") is almost always wrong. Pick the layout that handles N=1 gracefully and use it for everything.

### 10. Shared helper model key

Rewrite, summarize, and future AI helpers all share `localStorage['scribe.rewrite.model']`. The user wants one mental model: "this is the LLM my AI helpers use." They don't want to configure rewrite vs summarize separately.

### 11. Custom CM6 editor

About 600 lines: CM6 host + 4 custom extensions (liveMarkdown, codexLink, typewriter, toggleWrap) + EditorHandle for rewrite. TipTap, MDXEditor, and Lexical offer tables, slash commands, mention UI, etc. But their data model is a structured doc tree where markdown is a serialization that round-trips imperfectly. For a novelist editing prose with `[[scene beats]]` and codex-aware highlighting, almost none of those features matter, and plaintext-on-disk is the whole point.

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

1. Tiny grip glyph as drag target: too narrow to hit reliably.
2. Whole row draggable with `PointerSensor distance: 6` to separate click from drag.
3. One global DndContext spanning the chapters section. The per-act version meant a lone chapter in an act had nothing to swap with.
4. Dragging across acts writes `act` frontmatter. The old range-based assignment meant chapters snapped back after a drag. Empty acts got explicit drop zones.

### New scene/chapter shouldn't navigate away from plan view

The plan view is a planning context, not an editing context. Creating a scene or chapter shouldn't punt the user into the editor.

### Polling instead of a filesystem watcher

Out-of-band edits to the markdown (vim, a CLI agent, another device) are picked up by polling, not by an inotify/`watchdog` watcher. `keepaliveTrees` refreshes every cached project's tree on a 60s timer and `getFile`/`getTree` background-refresh on every read, so external changes surface within ~60s for structure and on next open for file bodies. A `watchdog` dependency was scaffolded for event-driven detection and dropped. Polling is simpler and adequate for a single-user app. Don't re-add a watcher without a concrete need.

---

## Known couplings

### Slug computation

Both backend and frontend compute position/ordinal for new chapters. Backend is authoritative. Frontend mirrors the algorithm for offline creates (temp slug). If the backend algorithm changes, offline creates may produce mismatched ordinals until reconnect, when `flushStructureOps` replays against the real backend.

### Helper model preference

All AI helpers share one `localStorage` key, exposed in the rewrite dialogue header and ChapterFlow scene sidecard. OutlineBoard reads from localStorage at point of use (generate callback + tooltip) to avoid stale mount-time reads.

---

### 15. Act renames are positional, same-length only

Chapters carry their act in frontmatter and `project.yml`'s `acts` list is just names, so a rename has to be inferred from the old and new lists. A PUT with a same-length acts list is treated as a positional rename sweep and propagates name changes into chapter frontmatter. A length change is add/remove and propagates nothing. Renaming and deleting acts in one save therefore loses the rename (two saves apply both correctly), which is accepted over adding rename metadata to the API for a case this rare.

### 16. Review sessions in APPDATA_ROOT

Review session data (`sessions.yml`) was originally stored inside the novel directory (`WRITING_ROOT/<slug>/review/`). This meant session tokens (secrets) were committed to the per-novel Forgejo repo by the autocommit scheduler. Moved to `APPDATA_ROOT/<slug>/review/sessions.yml` (fifth codebase review, 2026-07-31). Comments (`comments.yml`) stay in the novel dir: they're content, not secrets.

`resolve_token` scans `APPDATA_ROOT` directories, O(projects × sessions) per reviewer request. Acceptable at current scale. Revisit when the project archival workflow lands.

### 17. Generic webhook alerting

Autocommit failures were silent for ~3 months (stale `index.lock` from the slug migration, 2026-05-13 to 2026-08-02). Added webhook alerting on `commit_all_projects` failure, throttled to one alert per project per hour.

Two styles via `ALERT_WEBHOOK_STYLE`: `ntfy` (text body + ntfy-specific headers) and `json` (generic `{"title", "message"}` POST body, default). This keeps the published app provider-agnostic: any webhook receiver (ntfy, Slack, Discord, Gotify, custom) works with the JSON style.

Config: `ALERT_WEBHOOK_URL` (full URL including topic/channel), `ALERT_WEBHOOK_TOKEN` (optional Bearer token), `ALERT_WEBHOOK_STYLE` (`json` or `ntfy`).

### 18. Conflict response returns canonical body

The PUT /file conflict response originally returned the *submitted* body (the losing edit) alongside the canonical file's etag. The sync engine cached this pair (the loser's body with the winner's etag), so the next auto-save flush sent the loser's content with a valid etag and silently overwrote the winner. Fix: read the canonical file and return its body/frontmatter in the conflict response.

### 19. Block pending writes during active conflicts

Even with #18 fixed, the editor's 800ms debounced save re-queues the in-memory content before the user has time to resolve the conflict. `saveFile()` now checks `db.conflicts` for the file's canonical path and returns early if a conflict exists. Edits stay in the editor (in memory) but don't flush to the server until the conflict is resolved.

The unsaved buffer is not lost while it is blocked — as long as its editor stays mounted, it becomes the third input to resolution. (A blocked buffer whose editor unmounts before the conflict is resolved — navigating to a different chapter — exists nowhere liftable and is dropped; accepted limitation, since persisting blocked buffers would need a store of their own.) When the conflict modal opens on a file the active editor holds unsaved changes for, the editor buffer is lifted in as a third **Editor** column beside Server and Conflict, and the user picks per zone across all three (the three-way diff aligns conflict and editor onto the server canonical as a shared spine). Whichever whole-document or merged result the user commits is written through the modal's PUT, and the editor then reloads that canonical unconditionally. The buffer was a merge input consumed by the resolve, so `useFileEditor.onConflictResolved` never replays it over the resolution — there is no dirty-branch that keeps the buffer alive.

Corollary: when a PUT comes back as a conflict while a newer save raced it into the queue, the retry keeps its stale etag and produces a second conflict file rather than advancing to the current server etag. The advance looks like an optimisation (no "redundant" conflict file) but lets the retry silently overwrite the canonical winner — and since conflict resolution reloads the editor, that second file is the only durable copy of the newest keystrokes. Don't optimise it away.

Accepted limitation: the buffer is snapshotted once, at the moment the conflict is activated in the modal (the same moment the canonical and conflict bodies are fetched). Keystrokes typed into the editor while the modal is open are not re-snapshotted, so they are not reflected in the Editor column and are discarded by the reload on resolve. Resolving a conflict is a deliberate, foreground act on a single-user app; re-snapshotting a live buffer mid-merge is not worth the churn.

### 20. Unconditional PUT /file without If-Match

`PUT /file` with no `If-Match` header writes unconditionally, even to an existing file. This is intentional: the sync engine's cold-cache path (first write before the cache has a server etag) sends no `If-Match`, and the server treats that as "caller accepts whatever is on disk." Once the cache has a `serverEtag`, all subsequent flushes include `If-Match` and get the full conflict-detection path. New file creation goes through the no-`If-Match` path (or structure ops). External callers (CLI tools, scripts) that want conflict safety must supply `If-Match`; omitting it is an explicit opt-out.

A conditional write to a file that no longer exists is refused with 412 — an `If-Match` claim about a missing file is a stale-path write (the concrete case: a conflict-resolve PUT racing a replayed scene move would otherwise recreate a ghost file at the scene's old path). The one exception is `X-On-Conflict: save-as-conflict` callers — the sync engine's flush — where the file is recreated: a scene deleted on another device while this one holds queued edits resurrects loss-free instead of jamming the flush queue on a permanent 412. That carve-out means a flush PUT racing a scene move can still leave an orphan `.md` at the scene's old path server-side; the client refuses to commit the stale result (the flush re-checks the row's path before committing), so the orphan is inert and the next conflict sweep or manual tidy removes it — the same trade this exception already takes for deleted scenes.

### 21. Conditional delete replay

`DELETE /file` accepts an optional `If-Match`. When it is present and the file's current etag differs, the delete is refused with 412; the file is left alone. Without the header the delete is unconditional, and a missing file is still 404 either way. The contract covers file deletes only: `DELETE /chapter/{slug}` takes no `If-Match` and stays unconditional, since a chapter delete is a structural act on a directory rather than a claim about one file's bytes.

A delete queued offline carries the cache row's `serverEtag` in its op payload and replays with that etag as `If-Match`, so a delete decided against yesterday's copy cannot destroy a paragraph another device wrote this morning. The 412 is a permanent failure, so the op parks in `StuckOpsBanner` where the choice — discard the delete, or retry it after looking at the file — belongs to the writer. Deletes issued while online send no `If-Match`: the user is looking at the current file when they press the button. A file created offline has only the `'offline'` placeholder etag and no server copy to guard, so its replay stays unconditional. So does a file that was never cached at all — deleted from the sidebar without ever being opened — since there is no cache row to take an etag from. The same applies once our own queue has moved on: a replayed reorder or scene move rewrites the files it touches, so the successful replay clears `baseEtag` on any queued delete of a path it touched — the etag guards against another device, not against this one.

### 22. Retry unparks the whole project

The `StuckOpsBanner` Retry button clears `stuckAt` / `attempts` / `lastError` on every parked item for the project — structure ops and pending writes both — and flushes. Parked items are skipped by the flush loop, so fixing one op's cause and unparking only that op leaves its dependents parked behind it: a delete that failed because its chapter was gone unblocks nothing while the reorder queued after it stays asleep. Unparking everything costs one round of re-attempts, and anything still genuinely broken re-parks with a fresh error. Discard stays per item, since discarding is the destructive half.

### 23. Transient fallback can duplicate an online create

Sync failures split into transient (network errors, 5xx, 429 — retried in place) and permanent (parked; see #22). The transient half has a cost we accept: an online create whose call fails transiently falls back to queueing the op offline, so a 502 arriving after the backend has already written the chapter or scene replays into a duplicate — creates are not idempotent, and the ordinal auto-bump hands the replay a fresh slug rather than colliding with the original. The alternative is a client-generated idempotency key carried on every create and remembered server-side, which is a lot of machinery for a duplicate the writer can see in the sidebar and delete.

---

## Future

### Project archival workflow

Projects will cap at roughly a dozen. As completed novels accumulate, a "finalise / archive" state would let the app skip finished projects for sync keepalive polling and review-token walks. No design yet. Raised during the third codebase review (2026-07-27) when examining the O(projects) review-token lookup.

---

## Accepted limitations

### Offline structure ops vs. concurrent structural edits

Body edits racing across devices are handled: the loser is written to a `.conflict.*` file and nothing is lost (see #5-6). Structure ops are a different class. If a device queues structural changes offline (create/delete/move) and the same project's *structure* is changed from elsewhere before that queue flushes (another device, or editing the files directly on disk), the queued op can be rejected at replay (e.g. a scene created into a chapter that no longer exists). A permanently rejected op parks with `stuckAt`, the rest of the queue drains past it, and `StuckOpsBanner` names it with its last error and a retry / discard choice.

The mitigations that were cheap are done: temp-path remapping covers every single-device offline sequence, chapter deletion is idempotent (deleting something already gone succeeds), and a queued file delete replays conditionally (#21). What remains unbuilt is per-op conflict resolution UI — the banner offers retry or discard, not a merge. Not worth the machinery for a single-user app.

Practice: flush a device's offline queue (come online, let the sync badge clear) before editing the same project from another device or directly on disk.

### Narrow offline-op races (transient, self-healing)

Three edges of the offline-op machinery are accepted rather than engineered
around. `remapTempPaths` assumes index 0 of an offline chapter's scenes is the
original first scene; if that scene was deleted or moved out before flush, the
local tree briefly mispoints one scene until the same flush's tree refresh
corrects it. Deleting a scene via a temp path in the one-frame window after its
remap completes is a silent no-op (the queued delete 404-tolerates away); the
retry works. A beta reader posting a comment in the same instant the owner
deletes the session can leave an orphaned row in `comments.yml`; every reader
filters by session id, so it is invisible litter. Offline delete of a chapter
cancels queued moves into it, so a scene moved into the chapter then deleted
with it survives in its source chapter server-side — a loss-free resurrect.

### Tree reads recompute word counts from disk

`GET /api/projects/{slug}` rebuilds the whole tree on every call, reading each scene body to compute live word counts: there is no word-count index. A debounced scene save triggers a tree refresh, so a save re-reads the active novel from disk; the tree keepalive refreshes every cached project on a 60s timer. At single-user scale (a dozen novels, files hot in ZFS ARC) this is milliseconds and not worth an index. If a single novel ever grows large enough to feel it, the fix is to cache `word_count` keyed on the file etag, or serve a structure-only tree (no scene bodies) to the sidebar/plan views that don't need live counts. Filesystem-is-the-index is the deliberate tradeoff (no DB, fully greppable), and the read cost is the price.

import { db, fileKey, getDeviceId } from '../db';
import { countWords } from '../words';
import type { FileGet, ProjectTree, ProjectListItem } from '../api';
import {
  getFile as apiGetFile,
  putFile as apiPutFile,
  isTransientError,
} from '../api';
import * as treeOps from './tree';
import * as structOps from './structure';
import { flushStructureOps } from './structureFlush';
import * as prefetchOps from './prefetch';

export const FLUSH_INTERVAL_MS = 30_000;
export const SAVE_DEBOUNCE_MS = 800;
const TREE_KEEPALIVE_MS = 60_000;

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'conflict';

export interface SyncSnapshot {
  status: SyncStatus;
  pendingCount: number;
  stuckPendingCount: number;
  conflictCount: number;
  structureOpsCount: number;
  stuckOpsCount: number;
  prefetchProgress: { done: number; total: number } | null;
  lastError: string | null;
  lastFlushAt: number | null;
}

type Listener = (s: SyncSnapshot) => void;

export class SyncEngine {
  private listeners = new Set<Listener>();
  private pathRemapListeners = new Set<(oldPath: string, newPath: string) => void>();
  private conflictResolvedListeners = new Set<(slug: string, canonicalPath: string) => void>();
  private snapshot: SyncSnapshot = {
    status: 'idle',
    pendingCount: 0,
    stuckPendingCount: 0,
    conflictCount: 0,
    structureOpsCount: 0,
    stuckOpsCount: 0,
    prefetchProgress: null,
    lastError: null,
    lastFlushAt: null,
  };
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private deviceId: string | null = null;

  onPathRemap(fn: (oldPath: string, newPath: string) => void): () => void {
    this.pathRemapListeners.add(fn);
    return () => this.pathRemapListeners.delete(fn);
  }

  onConflictResolved(fn: (slug: string, canonicalPath: string) => void): () => void {
    this.conflictResolvedListeners.add(fn);
    return () => this.conflictResolvedListeners.delete(fn);
  }

  async init() {
    this.deviceId = await getDeviceId();
    await this.refreshCounts();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.flush());
      window.addEventListener('offline', () => this.set({ status: 'offline' }));
    }
    window.setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    window.setInterval(() => this.keepaliveTrees(), TREE_KEEPALIVE_MS);
    this.flush();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): SyncSnapshot {
    return this.snapshot;
  }

  set(partial: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  async refreshCounts() {
    const pendingCount = await db.pending.count();
    const stuckPendingCount = await db.pending.filter(p => !!p.stuckAt).count();
    const conflictCount = await db.conflicts.count();
    const structureOpsCount = await db.structureOps.count();
    const stuckOpsCount = await db.structureOps.filter(op => !!op.stuckAt).count();
    // Stuck rows don't count as active work — an all-stuck queue must settle to
    // idle/offline, not spin 'syncing' forever. The stuck counts surface separately.
    const activeStructureOpsCount = structureOpsCount - stuckOpsCount;
    const activePendingCount = pendingCount - stuckPendingCount;
    let status: SyncStatus;
    if (conflictCount > 0) status = 'conflict';
    else if ((activePendingCount > 0 || activeStructureOpsCount > 0) && !navigator.onLine) status = 'offline';
    else if (activePendingCount > 0 || activeStructureOpsCount > 0) status = 'syncing';
    else status = 'idle';
    this.set({
      pendingCount, stuckPendingCount, conflictCount,
      structureOpsCount, stuckOpsCount, status,
    });
  }

  // Unparks every stuck item for the project, not just one: flush skips parked rows,
  // so a fixed parent op would otherwise leave its unblocked dependents parked forever.
  // Anything still genuinely broken re-parks with a fresh error on this flush.
  async retryStuck(slug: string): Promise<void> {
    const cleared = { stuckAt: undefined, attempts: 0, lastError: undefined };
    const ops = await db.structureOps.where('slug').equals(slug).filter(op => !!op.stuckAt).toArray();
    for (const op of ops) await db.structureOps.update(op.id!, cleared);
    const writes = await db.pending.filter(p => p.slug === slug && !!p.stuckAt).toArray();
    for (const w of writes) await db.pending.update(w.id!, cleared);
    await this.refreshCounts();
    await this.flush();
  }

  // --- File I/O ---

  async getFile(slug: string, path: string): Promise<FileGet> {
    const cached = await db.cache.get(fileKey(slug, path));
    if (cached && navigator.onLine) {
      const etagAtFetch = cached.serverEtag;
      apiGetFile(slug, path)
        .then(async (fresh) => {
          const pending = await db.pending.where({ slug, path }).first();
          if (pending) return;
          const current = await db.cache.get(fileKey(slug, path));
          if (!current || current.serverEtag !== etagAtFetch) return;
          await db.cache.put({
            key: fileKey(slug, path),
            slug,
            path,
            body: fresh.body,
            frontmatter: fresh.frontmatter,
            serverEtag: fresh.etag,
            cachedAt: Date.now(),
          });
        })
        .catch((e) => {
          if (!isTransientError(e)) console.warn('background refresh failed', e);
        });
      return {
        path: cached.path,
        body: cached.body,
        frontmatter: cached.frontmatter,
        etag: cached.serverEtag,
        word_count: countWords(cached.body),
      };
    }
    if (navigator.onLine) {
      try {
        const fresh = await apiGetFile(slug, path);
        const pending = await db.pending.where({ slug, path }).first();
        if (!pending) {
          await db.cache.put({
            key: fileKey(slug, path),
            slug,
            path,
            body: fresh.body,
            frontmatter: fresh.frontmatter,
            serverEtag: fresh.etag,
            cachedAt: Date.now(),
          });
        }
        return fresh;
      } catch (e) {
        // Only a transient failure means the network is the problem — a 404 or 422
        // is the request being wrong while the connection is fine.
        if (isTransientError(e)) this.set({ status: 'offline', lastError: String(e) });
        else this.set({ lastError: String(e) });
      }
    }
    if (cached) {
      return {
        path: cached.path,
        body: cached.body,
        frontmatter: cached.frontmatter,
        etag: cached.serverEtag,
        word_count: countWords(cached.body),
      };
    }
    throw new Error(
      `File not in local cache and network unavailable: ${path}`,
    );
  }

  async saveFile(
    slug: string,
    path: string,
    body: string,
    frontmatter: Record<string, unknown>,
    callerEtag: string,
  ): Promise<'queued' | 'blocked'> {
    const key = fileKey(slug, path);
    // Cache + pending commit atomically so flush()'s compare-and-delete can't interleave mid-pair.
    // The conflict check lives inside the transaction so a resolve that deletes the marker
    // mid-save can't let a stale buffer slip past the write-block.
    let blocked = false;
    await db.transaction('rw', db.cache, db.pending, db.conflicts, async () => {
      const hasConflict = await db.conflicts
        .where('canonicalPath').equals(path)
        .and(c => c.slug === slug)
        .first();
      if (hasConflict) {
        blocked = true;
        return;
      }
      const cached = await db.cache.get(key);
      const effectiveEtag = cached?.serverEtag ?? callerEtag;
      await db.cache.put({
        key,
        slug,
        path,
        body,
        frontmatter,
        serverEtag: effectiveEtag,
        cachedAt: Date.now(),
      });
      const existing = await db.pending.where({ slug, path }).first();
      if (existing) {
        await db.pending.update(existing.id!, {
          body,
          frontmatter,
          baseEtag: effectiveEtag,
          queuedAt: Date.now(),
          attempts: 0,
          lastError: undefined,
          stuckAt: undefined,
        });
      } else {
        await db.pending.add({
          slug,
          path,
          body,
          frontmatter,
          baseEtag: effectiveEtag,
          queuedAt: Date.now(),
          attempts: 0,
        });
      }
    });
    if (blocked) return 'blocked';
    await this.refreshCounts();
    this.flush();
    return 'queued';
  }

  // --- Flush ---

  // A caller joining an in-flight run gets that run's promise, not an immediate
  // resolve — so an awaited flush() always means "queue drained or errored".
  async flush(): Promise<void> {
    if (this.flushing) return this.flushPromise ?? Promise.resolve();
    this.flushPromise = this.runFlush();
    return this.flushPromise;
  }

  private async runFlush(): Promise<void> {
    this.flushing = true;
    // Only flip to 'syncing' when there's actually something to send — otherwise every
    // 30s tick flashes the status (and briefly masks the conflict badge) for nothing.
    // Stuck ops don't count (mirrors refreshCounts' activeStructureOpsCount) — an
    // all-stuck queue must stay settled, not flash 'syncing' every tick.
    const activeStructureOps = await db.structureOps.filter(op => !op.stuckAt).count();
    const activePending = await db.pending.filter(p => !p.stuckAt).count();
    const hasWork = activePending > 0 || activeStructureOps > 0;
    if (hasWork) this.set({ status: 'syncing' });
    const structureOpsProcessed = await flushStructureOps(this);
    let lastError: string | null = null;
    let pendingProcessed = 0;
    let blockedByTransient = false;
    try {
      // Repeat while items keep arriving mid-run, so a joined flush() only resolves
      // once the queue is actually empty (or a write has failed transiently).
      do {
        while (true) {
          // Stuck writes are parked, not gone — skip them so later writes still flush.
          const next = await db.pending.orderBy('queuedAt').filter(p => !p.stuckAt).first();
          if (!next) break;
          try {
            const result = await apiPutFile(
              next.slug,
              next.path,
              { body: next.body, frontmatter: next.frontmatter },
              next.baseEtag,
              {
                onConflict: 'save-as-conflict',
                deviceId: this.deviceId ?? undefined,
              },
            );
            if (result.conflict && result.conflict_path) {
              await this.recordConflict(next.slug, result.conflict_path);
            }
            // Re-read, stamp cache, and delete in one transaction: a saveFile that refreshed
            // this row mid-PUT bumped queuedAt, so drop neither the newer body from the queue
            // nor let the stale server body clobber the cache — leave it for the next iteration.
            const committed = await db.transaction('rw', db.cache, db.pending, async () => {
              const current = await db.pending.get(next.id!);
              // A move-scene rekey relocated this row mid-PUT: both the etag we hold and the
              // cache key we'd stamp belong to the old path, so commit nothing and let the
              // next iteration re-read the row where it now lives.
              if (current && current.path !== next.path) return false;
              if (current && current.queuedAt !== next.queuedAt) {
                // A newer save refreshed this row mid-PUT. On a clean write, advance the row's
                // baseEtag to what the server now holds so the retry's If-Match matches (else the
                // server rejects the newer body into a spurious conflict); keep the newer body and
                // stamp it into cache under the fresh etag. On a conflict, leave the row untouched:
                // the stale-etag retry writes a second conflict file, which is the only durable
                // copy of the newest keystrokes once resolution reloads the editor. Advancing the
                // etag here would let the retry silently overwrite the canonical winner.
                if (!result.conflict) {
                  await db.pending.update(next.id!, { baseEtag: result.etag });
                  await db.cache.put({
                    key: fileKey(next.slug, next.path),
                    slug: next.slug,
                    path: next.path,
                    body: current.body,
                    frontmatter: current.frontmatter,
                    serverEtag: result.etag,
                    cachedAt: Date.now(),
                  });
                }
                return false;
              }
              await db.cache.put({
                key: fileKey(next.slug, next.path),
                slug: next.slug,
                path: next.path,
                body: result.body,
                frontmatter: result.frontmatter,
                serverEtag: result.etag,
                cachedAt: Date.now(),
              });
              await db.pending.delete(next.id!);
              return true;
            });
            if (!committed) continue;
            pendingProcessed++;
          } catch (e) {
            const message = String(e);
            lastError = message;
            if (isTransientError(e)) {
              await db.pending.update(next.id!, {
                attempts: next.attempts + 1,
                lastError: message,
              });
              blockedByTransient = true;
              break;
            }
            // A permanent failure (stale etag on a missing file, a rejected path)
            // never clears by itself — park the write and keep draining the rest.
            // Parking is conditional on the row still holding the body we sent, at the path
            // we sent it to: a save that landed mid-PUT — or a rekey that moved the row to a
            // path this failure says nothing about — deserves its own attempt.
            await db.transaction('rw', db.pending, async () => {
              const current = await db.pending.get(next.id!);
              if (!current || current.queuedAt !== next.queuedAt || current.path !== next.path) return;
              await db.pending.update(next.id!, {
                attempts: next.attempts + 1,
                lastError: message,
                stuckAt: Date.now(),
              });
            });
          }
        }
      } while (!blockedByTransient && (await db.pending.filter(p => !p.stuckAt).count()) > 0);
      this.set({
        lastFlushAt: Date.now(),
        lastError,
      });
    } finally {
      this.flushing = false;
      this.flushPromise = null;
      await this.refreshCounts();
      if (structureOpsProcessed > 0 || pendingProcessed > 0) {
        const trees = await db.trees.toArray();
        for (const entry of trees) {
          try {
            if (navigator.onLine) await this.getTree(entry.slug);
          } catch { /* best-effort */ }
        }
      }
    }
  }

  // --- Conflicts ---

  async listConflicts() {
    return db.conflicts.toArray();
  }

  async dismissConflict(key: string): Promise<void> {
    const conflict = await db.conflicts.get(key);
    await db.conflicts.delete(key);
    await this.refreshCounts();
    if (conflict) {
      for (const fn of this.conflictResolvedListeners) fn(conflict.slug, conflict.canonicalPath);
    }
  }

  private async recordConflict(slug: string, conflictPath: string) {
    const m = conflictPath.match(
      /^(?<dir>(?:.*\/)?)(?<stem>.+)\.conflict\.(?<device>[A-Za-z0-9_-]+)\.(?<ts>\d{8}T\d{6}Z)\.(?<ext>[^./]+)$/,
    );
    if (!m || !m.groups) return;
    const { dir, stem, device, ts, ext } = m.groups;
    const canonical = `${dir}${stem}.${ext}`;
    const key = fileKey(slug, conflictPath);
    await db.conflicts.put({
      key,
      slug,
      path: conflictPath,
      canonicalPath: canonical,
      deviceId: device,
      timestamp: ts,
      noticedAt: Date.now(),
    });
  }

  // --- Tree ---

  async getCachedTree(slug: string): Promise<ProjectTree | null> {
    const cached = await db.trees.get(slug);
    return cached ? cached.tree : null;
  }

  async putCachedTree(slug: string, tree: ProjectTree): Promise<void> {
    await db.trees.put({ slug, tree, cachedAt: Date.now() });
  }

  async getTree(slug: string, forceRefresh = false): Promise<ProjectTree> {
    return treeOps.getTree(this, slug, forceRefresh);
  }

  async keepaliveTrees(): Promise<void> {
    return treeOps.keepaliveTrees(this);
  }

  async listProjects(): Promise<ProjectListItem[]> {
    return treeOps.listProjects();
  }

  // --- Path remap (used by structure modules) ---

  // Cache + pending + conflicts rekey in one transaction, so a concurrent saveFile
  // committing mid-rekey can't re-create a row under the old path behind our back.
  // Listeners fire only once the rename is fully durable.
  async rekeyLocalPath(slug: string, oldPath: string, newPath: string): Promise<void> {
    await db.transaction('rw', db.cache, db.pending, db.conflicts, async () => {
      const cached = await db.cache.get(fileKey(slug, oldPath));
      if (cached) {
        await db.cache.put({ ...cached, key: fileKey(slug, newPath), path: newPath });
        await db.cache.delete(cached.key);
      }
      const pendings = await db.pending.where({ slug, path: oldPath }).toArray();
      for (const p of pendings) {
        await db.pending.update(p.id!, { path: newPath });
      }
      await this.rekeyConflictMarkers(slug, oldPath, newPath);
    });
    for (const fn of this.pathRemapListeners) fn(oldPath, newPath);
  }

  // Every local path rename (temp-path assignment, offline move, post-move
  // flush remap) must carry device-local conflict markers along with cache
  // + pending, or the marker orphans at a path nothing points to any more.
  // No-op when the old path never had a marker (e.g. a fresh temp scene).
  private async rekeyConflictMarkers(slug: string, oldCanonicalPath: string, newCanonicalPath: string): Promise<void> {
    const markers = await db.conflicts
      .where('canonicalPath').equals(oldCanonicalPath)
      .and(m => m.slug === slug)
      .toArray();
    if (markers.length === 0) return;

    const lastSlash = newCanonicalPath.lastIndexOf('/');
    const newDir = newCanonicalPath.slice(0, lastSlash);
    const newStem = newCanonicalPath.slice(lastSlash + 1).replace(/\.md$/, '');

    for (const marker of markers) {
      const newPath = `${newDir}/${newStem}.conflict.${marker.deviceId}.${marker.timestamp}.md`;
      await db.conflicts.delete(marker.key);
      await db.conflicts.put({
        ...marker,
        key: fileKey(slug, newPath),
        path: newPath,
        canonicalPath: newCanonicalPath,
      });
    }
  }

  // --- Structure (delegate) ---

  createChapter(
    slug: string,
    payload: {
      kind?: 'chapter' | 'interlude';
      act?: string;
      title?: string;
      chapter?: number;
      slug?: string;
    },
  ) {
    return structOps.createChapter(this, slug, payload);
  }

  createScene(slug: string, chapterSlug: string, payload: { title?: string }) {
    return structOps.createScene(this, slug, chapterSlug, payload);
  }

  createCategoryEntry(slug: string, folder: string, payload: { title: string; slug?: string }) {
    return structOps.createCategoryEntry(this, slug, folder, payload);
  }

  removeChapter(slug: string, chapterSlug: string) {
    return structOps.removeChapter(this, slug, chapterSlug);
  }

  deleteScene(slug: string, scenePath: string) {
    return structOps.deleteScene(this, slug, scenePath);
  }

  deleteCategoryEntry(slug: string, path: string) {
    return structOps.deleteCategoryEntry(this, slug, path);
  }

  reorderItems(slug: string, items: { path: string; order: number; act?: string | null }[]) {
    return structOps.reorderItems(this, slug, items);
  }

  moveScene(
    slug: string,
    payload: {
      srcPath: string;
      dstChapterSlug: string;
      srcOrder: { path: string; order: number }[];
      dstOrder: { path: string; order: number }[];
    },
  ) {
    return structOps.moveScene(this, slug, payload);
  }

  // --- Prefetch (delegate) ---

  prefetchProject(slug: string) {
    return prefetchOps.prefetchProject(this, slug);
  }

  getPrefetchedAt(slug: string) {
    return prefetchOps.getPrefetchedAt(slug);
  }
}

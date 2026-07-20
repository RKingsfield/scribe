import { useEffect, useState } from 'react';
import { ConflictMarker, cryptoRandomId, db, ensureOpen, fileKey, getDeviceId } from './db';
import { countWords } from './words';
import {
  addChapterToTree,
  addSceneToTree,
  addCategoryEntryToTree,
  removeChapterFromTree,
  removeSceneFromTree,
  removeCategoryEntryFromTree,
  applyReorderToTree,
  remapTempPaths,
  moveSceneInTree,
  isOfflinePath,
} from './offlineTree';
import {
  FileGet,
  ProjectTree,
  ProjectListItem,
  getFile as apiGetFile,
  putFile as apiPutFile,
  getProject as apiGetProject,
  listProjects as apiListProjects,
  newChapter as apiNewChapter,
  newScene as apiNewScene,
  newCategoryEntry as apiNewCategoryEntry,
  deleteChapter as apiDeleteChapter,
  deleteFile as apiDeleteFile,
  reorder as apiReorder,
  moveScene as apiMoveScene,
  isNetworkError,
} from './api';

const PROJECT_LIST_TIMEOUT_MS = 3000;
const PREFETCH_BATCH_SIZE = 5;
export const FLUSH_INTERVAL_MS = 30_000;
const TREE_KEEPALIVE_MS = 60_000;
export const SAVE_DEBOUNCE_MS = 800;

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'conflict';

export interface SyncSnapshot {
  status: SyncStatus;
  pendingCount: number;
  conflictCount: number;
  structureOpsCount: number;
  prefetchProgress: { done: number; total: number } | null;
  lastError: string | null;
  lastFlushAt: number | null;
}

type Listener = (s: SyncSnapshot) => void;

function mapTempPath(
  path: string,
  tempPrefix: string,
  target: { slug: string; meta_path: string; first_scene_path: string },
): string | null {
  if (!path.startsWith(tempPrefix)) return null;
  const rest = path.slice(tempPrefix.length);
  if (rest === 'chapter.md') return target.meta_path;
  if (rest.startsWith('_offline_')) return path.replace(tempPrefix, `chapters/${target.slug}/`);
  return target.first_scene_path;
}

class SyncEngine {
  private listeners = new Set<Listener>();
  private pathRemapListeners = new Set<(oldPath: string, newPath: string) => void>();

  onPathRemap(fn: (oldPath: string, newPath: string) => void): () => void {
    this.pathRemapListeners.add(fn);
    return () => this.pathRemapListeners.delete(fn);
  }
  private snapshot: SyncSnapshot = {
    status: 'idle',
    pendingCount: 0,
    conflictCount: 0,
    structureOpsCount: 0,
    prefetchProgress: null,
    lastError: null,
    lastFlushAt: null,
  };
  private flushing = false;
  private deviceId: string | null = null;

  // navigator.onLine is a fast-path hint, not a correctness gate — every network call has its own error handling.
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

  /**
   * Read a file. Online: hit network and refresh cache. Offline: return cache.
   */
  async getFile(slug: string, path: string): Promise<FileGet> {
    const cached = await db.cache.get(fileKey(slug, path));
    if (cached && navigator.onLine) {
      apiGetFile(slug, path)
        .then(async (fresh) => {
          const pending = await db.pending.where({ slug, path }).first();
          if (pending) return;
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
        .catch(() => {});
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
        this.set({ status: 'offline', lastError: String(e) });
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

  async getTree(slug: string, forceRefresh = false): Promise<ProjectTree> {
    const cached = await db.trees.get(slug);
    if (cached && navigator.onLine && !forceRefresh) {
      apiGetProject(slug)
        .then((tree) => db.trees.put({ slug, tree, cachedAt: Date.now() }))
        .catch(() => {});
      return cached.tree;
    }
    if (navigator.onLine) {
      try {
        const tree = await apiGetProject(slug);
        await db.trees.put({ slug, tree, cachedAt: Date.now() });
        return tree;
      } catch (e) {
        this.set({ status: 'offline', lastError: String(e) });
        if (cached) return cached.tree;
      }
    }
    if (cached) return cached.tree;
    throw new Error(`Project tree not in cache and network unavailable: ${slug}`);
  }

  async getCachedTree(slug: string): Promise<ProjectTree | null> {
    const cached = await db.trees.get(slug);
    return cached ? (cached.tree) : null;
  }

  async putCachedTree(slug: string, tree: ProjectTree): Promise<void> {
    await db.trees.put({ slug, tree, cachedAt: Date.now() });
  }

  async listProjects(): Promise<ProjectListItem[]> {
    await ensureOpen();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROJECT_LIST_TIMEOUT_MS);
      const result = await apiListProjects(controller.signal);
      clearTimeout(timer);
      return result;
    } catch {
      const cached = await db.trees.toArray();
      return cached.map((entry) => ({
        slug: entry.slug,
        title: entry.tree.title,
      }));
    }
  }

  private async queueStructureOp(
    slug: string,
    op: 'new-chapter' | 'new-scene' | 'new-category-entry' | 'delete-chapter' | 'reorder' | 'move-scene',
    payload: Record<string, unknown>,
    tempId: string,
  ): Promise<void> {
    await db.structureOps.add({
      slug,
      op,
      payload,
      tempId,
      queuedAt: Date.now(),
      attempts: 0,
    });
    await this.refreshCounts();
  }

  async createChapter(
    slug: string,
    payload: {
      kind?: 'chapter' | 'interlude';
      act?: string;
      title?: string;
      chapter?: number;
      slug?: string;
    },
  ): Promise<{ slug: string; path: string; meta_path: string; first_scene_path: string; kind: 'chapter' | 'interlude'; chapter: number | null; interlude: number | null; position: number }> {
    if (navigator.onLine) {
      try {
        const result = await apiNewChapter(slug, payload);
        await this.getTree(slug, true);
        return result;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tempId = cryptoRandomId();
    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot create chapter offline without cached tree');

    const kind = payload.kind ?? 'chapter';
    const { tree: updated, metaPath, scenePath } = addChapterToTree(tree, {
      kind,
      act: payload.act,
      title: payload.title,
      tempId,
    });

    await this.putCachedTree(slug, updated);
    const added = updated.chapters.find(c => c.slug === `_offline_${tempId}`)!;

    const metaFm: Record<string, unknown> = { title: payload.title ?? '', kind };
    if (kind === 'chapter') metaFm.chapter = added.chapter;
    else metaFm.interlude = added.interlude;
    if (added.act) metaFm.act = added.act;
    metaFm.order = added.order;

    await db.cache.put({
      key: fileKey(slug, metaPath),
      slug, path: metaPath,
      body: '', frontmatter: metaFm,
      serverEtag: 'offline', cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey(slug, scenePath),
      slug, path: scenePath,
      body: '', frontmatter: {},
      serverEtag: 'offline', cachedAt: Date.now(),
    });

    await this.queueStructureOp(slug, 'new-chapter', payload, tempId);

    return {
      slug: added.slug, path: added.path,
      meta_path: metaPath, first_scene_path: scenePath,
      kind, chapter: added.chapter, interlude: added.interlude,
      position: added.order ?? 0,
    };
  }

  async createScene(
    slug: string,
    chapterSlug: string,
    payload: { title?: string },
  ): Promise<{ scene: number; path: string }> {
    if (navigator.onLine) {
      try {
        const result = await apiNewScene(slug, chapterSlug, payload);
        await this.getTree(slug, true);
        return result;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tempId = cryptoRandomId();
    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot create scene offline without cached tree');

    const { tree: updated, scenePath } = addSceneToTree(tree, chapterSlug, tempId);
    await this.putCachedTree(slug, updated);

    const ch = updated.chapters.find(c => c.slug === chapterSlug);
    const scene = ch?.scenes.find(s => s.path === scenePath);

    await db.cache.put({
      key: fileKey(slug, scenePath),
      slug, path: scenePath,
      body: '', frontmatter: payload.title ? { title: payload.title } : {},
      serverEtag: 'offline', cachedAt: Date.now(),
    });

    await this.queueStructureOp(slug, 'new-scene', { chapterSlug, ...payload }, tempId);

    return { scene: scene?.scene ?? 1, path: scenePath };
  }

  async createCategoryEntry(
    slug: string,
    folder: string,
    payload: { title: string; slug?: string },
  ): Promise<{ path: string; title: string }> {
    if (navigator.onLine) {
      try {
        const result = await apiNewCategoryEntry(slug, folder, payload);
        await this.getTree(slug, true);
        return result;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tempId = cryptoRandomId();
    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot create entry offline without cached tree');

    const { tree: updated, entryPath } = addCategoryEntryToTree(tree, folder, {
      title: payload.title, tempId,
    });
    await this.putCachedTree(slug, updated);

    await db.cache.put({
      key: fileKey(slug, entryPath),
      slug, path: entryPath,
      body: '', frontmatter: { title: payload.title },
      serverEtag: 'offline', cachedAt: Date.now(),
    });

    await this.queueStructureOp(slug, 'new-category-entry', { folder, ...payload }, tempId);
    return { path: entryPath, title: payload.title };
  }

  async removeChapter(slug: string, chapterSlug: string): Promise<void> {
    if (navigator.onLine) {
      try {
        await apiDeleteChapter(slug, chapterSlug);
        await this.getTree(slug, true);
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot delete chapter offline without cached tree');

    const updated = removeChapterFromTree(tree, chapterSlug);
    await this.putCachedTree(slug, updated);
    await this.queueStructureOp(slug, 'delete-chapter', { chapterSlug }, chapterSlug);
  }

  /**
   * Delete a scene. Online-only — no offline queue.
   */
  async deleteScene(slug: string, scenePath: string): Promise<void> {
    await apiDeleteFile(slug, scenePath);

    const tree = await this.getCachedTree(slug);
    if (tree) {
      await this.putCachedTree(slug, removeSceneFromTree(tree, scenePath));
    }

    await db.cache.delete(fileKey(slug, scenePath));
    await db.pending.where({ slug, path: scenePath }).delete();

    await this.getTree(slug, true);
  }

  /**
   * Delete a category entry. Online-only — no offline queue.
   */
  async deleteCategoryEntry(slug: string, path: string): Promise<void> {
    await apiDeleteFile(slug, path);

    const tree = await this.getCachedTree(slug);
    if (tree) {
      await this.putCachedTree(slug, removeCategoryEntryFromTree(tree, path));
    }

    await db.cache.delete(fileKey(slug, path));
    await db.pending.where({ slug, path }).delete();

    await this.getTree(slug, true);
  }

  async reorderItems(
    slug: string,
    items: { path: string; order: number; act?: string | null }[],
  ): Promise<void> {
    if (navigator.onLine) {
      try {
        await apiReorder(slug, items);
        await this.getTree(slug, true);
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot reorder offline without cached tree');

    const updated = applyReorderToTree(tree, items);
    await this.putCachedTree(slug, updated);
    await this.queueStructureOp(slug, 'reorder', { items }, cryptoRandomId());
  }

  async moveScene(
    slug: string,
    payload: {
      srcPath: string;
      dstChapterSlug: string;
      srcOrder: { path: string; order: number }[];
      dstOrder: { path: string; order: number }[];
    },
  ): Promise<void> {
    const { srcPath, dstChapterSlug, srcOrder, dstOrder } = payload;

    if (navigator.onLine) {
      try {
        const result = await apiMoveScene(slug, {
          src_path: srcPath,
          dst_chapter_slug: dstChapterSlug,
          src_order: srcOrder,
          dst_order: dstOrder,
        });
        await this.remapSinglePath(slug, srcPath, result.new_path);
        await this.getTree(slug, true);
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }

    const tree = await this.getCachedTree(slug);
    if (!tree) throw new Error('Cannot move scene offline without cached tree');

    if (isOfflinePath(srcPath)) {
      const ops = await db.structureOps.where('slug').equals(slug).toArray();
      let matched = false;
      for (const op of ops) {
        if (op.op === 'new-scene') {
          const opPayload = op.payload as { chapterSlug: string };
          const expectedPath = `chapters/${opPayload.chapterSlug}/_offline_${op.tempId}.md`;
          if (expectedPath === srcPath) {
            await db.structureOps.update(op.id!, {
              payload: { ...op.payload, chapterSlug: dstChapterSlug },
            });
            matched = true;
            break;
          }
        }
      }

      const tempId = cryptoRandomId();
      const { tree: updated, tempScenePath } = moveSceneInTree(
        tree, srcPath, dstChapterSlug, srcOrder, dstOrder, tempId,
      );
      await this.putCachedTree(slug, updated);
      await this.rekeyLocalPath(slug, srcPath, tempScenePath);
      if (!matched) {
        await this.queueStructureOp(slug, 'move-scene', {
          srcPath,
          dstChapterSlug,
          srcOrder,
          dstOrder,
        }, tempId);
      }
      return;
    }

    const tempId = cryptoRandomId();
    const { tree: updated, tempScenePath } = moveSceneInTree(
      tree, srcPath, dstChapterSlug, srcOrder, dstOrder, tempId,
    );
    await this.putCachedTree(slug, updated);
    await this.rekeyLocalPath(slug, srcPath, tempScenePath);
    await this.queueStructureOp(slug, 'move-scene', {
      srcPath,
      dstChapterSlug,
      srcOrder,
      dstOrder,
    }, tempId);
  }

  async flushStructureOps(): Promise<number> {
    let processed = 0;
    while (true) {
      const next = await db.structureOps.orderBy('queuedAt').first();
      if (!next) break;

      try {
        switch (next.op) {
          case 'new-chapter': {
            const { kind, act, title, chapter, slug: chapterSlug } = next.payload as {
              kind?: 'chapter' | 'interlude'; act?: string; title?: string;
              chapter?: number; slug?: string;
            };
            const result = await apiNewChapter(next.slug, { kind, act, title, chapter, slug: chapterSlug });
            await this.remapPaths(
              next.slug,
              `_offline_${next.tempId}`,
              {
                slug: result.slug,
                path: `chapters/${result.slug}`,
                meta_path: result.meta_path,
                first_scene_path: result.first_scene_path,
              },
            );
            break;
          }
          case 'new-scene': {
            const { chapterSlug, ...rest } = next.payload as { chapterSlug: string; title?: string };
            const result = await apiNewScene(next.slug, chapterSlug, rest);
            const tempPath = `chapters/${chapterSlug}/_offline_${next.tempId}.md`;
            await this.remapSinglePath(next.slug, tempPath, result.path);
            break;
          }
          case 'new-category-entry': {
            const { folder, ...rest } = next.payload as { folder: string; title: string; slug?: string };
            const result = await apiNewCategoryEntry(next.slug, folder, rest);
            const tempPath = `${folder}/_offline_${next.tempId}.md`;
            await this.remapSinglePath(next.slug, tempPath, result.path);
            break;
          }
          case 'delete-chapter': {
            const { chapterSlug } = next.payload as { chapterSlug: string };
            await apiDeleteChapter(next.slug, chapterSlug);
            break;
          }
          case 'reorder': {
            const { items } = next.payload as { items: { path: string; order: number; act?: string | null }[] };
            await apiReorder(next.slug, items);
            break;
          }
          case 'move-scene': {
            const { srcPath, dstChapterSlug, srcOrder, dstOrder } = next.payload as {
              srcPath: string;
              dstChapterSlug: string;
              srcOrder: { path: string; order: number }[];
              dstOrder: { path: string; order: number }[];
            };
            const result = await apiMoveScene(next.slug, {
              src_path: srcPath,
              dst_chapter_slug: dstChapterSlug,
              src_order: srcOrder,
              dst_order: dstOrder,
            });
            const tempPath = `chapters/${dstChapterSlug}/_offline_${next.tempId}.md`;
            await this.remapSinglePath(next.slug, tempPath, result.new_path);
            break;
          }
        }
        await db.structureOps.delete(next.id!);
        processed++;
      } catch (e) {
        await db.structureOps.update(next.id!, {
          attempts: next.attempts + 1,
          lastError: String(e),
        });
        break;
      }
    }
    await this.refreshCounts();
    return processed;
  }

  private async remapPaths(
    slug: string,
    tempSlug: string,
    target: { slug: string; path: string; meta_path: string; first_scene_path: string },
  ): Promise<void> {
    const tree = await this.getCachedTree(slug);
    if (tree) {
      const updated = remapTempPaths(tree, tempSlug, target);
      await this.putCachedTree(slug, updated);
    }

    const tempPrefix = `chapters/${tempSlug}/`;
    const cached = await db.cache.where('slug').equals(slug).toArray();
    for (const entry of cached) {
      const newPath = mapTempPath(entry.path, tempPrefix, target);
      if (newPath === null) continue;

      await db.cache.put({ ...entry, key: fileKey(slug, newPath), path: newPath });
      await db.cache.delete(entry.key);

      await db.transaction('rw', db.pending, async () => {
        const pendings = await db.pending.where({ slug, path: entry.path }).toArray();
        for (const p of pendings) {
          await db.pending.update(p.id!, { path: newPath });
        }
      });

      for (const fn of this.pathRemapListeners) fn(entry.path, newPath);
    }

    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    for (const op of ops) {
      const payload = op.payload as Record<string, unknown>;
      const next: Record<string, unknown> = { ...payload };
      let changed = false;

      for (const key of ['chapterSlug', 'dstChapterSlug'] as const) {
        if (next[key] === tempSlug) {
          next[key] = target.slug;
          changed = true;
        }
      }
      if (typeof next.srcPath === 'string') {
        const mapped = mapTempPath(next.srcPath, tempPrefix, target);
        if (mapped !== null) {
          next.srcPath = mapped;
          changed = true;
        }
      }
      for (const key of ['items', 'srcOrder', 'dstOrder'] as const) {
        const arr = next[key] as { path: string }[] | undefined;
        if (!Array.isArray(arr)) continue;
        const mapped = arr.map(entry => {
          const newPath = mapTempPath(entry.path, tempPrefix, target);
          return newPath !== null ? { ...entry, path: newPath } : entry;
        });
        if (mapped.some((entry, i) => entry.path !== arr[i].path)) {
          next[key] = mapped;
          changed = true;
        }
      }

      if (changed) {
        await db.structureOps.update(op.id!, { payload: next });
      }
    }
  }

  private async rekeyLocalPath(
    slug: string,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const cached = await db.cache.get(fileKey(slug, oldPath));
    if (cached) {
      await db.cache.put({ ...cached, key: fileKey(slug, newPath), path: newPath });
      await db.cache.delete(cached.key);
    }

    await db.transaction('rw', db.pending, async () => {
      const pendings = await db.pending.where({ slug, path: oldPath }).toArray();
      for (const p of pendings) {
        await db.pending.update(p.id!, { path: newPath });
      }
    });

    for (const fn of this.pathRemapListeners) fn(oldPath, newPath);
  }

  private async remapSinglePath(
    slug: string,
    tempPath: string,
    realPath: string,
  ): Promise<void> {
    const tree = await this.getCachedTree(slug);
    if (tree) {
      const chapters = tree.chapters.map(c => ({
        ...c,
        scenes: c.scenes.map(s =>
          s.path === tempPath ? { ...s, path: realPath } : s,
        ),
      }));
      const categories = tree.categories.map(cat => ({
        ...cat,
        entries: cat.entries.map(e =>
          e.path === tempPath ? { ...e, path: realPath } : e,
        ),
      }));
      await this.putCachedTree(slug, { ...tree, chapters, categories });
    }

    await this.rekeyLocalPath(slug, tempPath, realPath);

    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    for (const op of ops) {
      const payload = op.payload as Record<string, unknown>;
      const next: Record<string, unknown> = { ...payload };
      let changed = false;

      if (next.srcPath === tempPath) {
        next.srcPath = realPath;
        changed = true;
      }
      for (const key of ['items', 'srcOrder', 'dstOrder'] as const) {
        const arr = next[key] as { path: string }[] | undefined;
        if (!Array.isArray(arr)) continue;
        const mapped = arr.map(entry => entry.path === tempPath ? { ...entry, path: realPath } : entry);
        if (mapped.some((entry, i) => entry.path !== arr[i].path)) {
          next[key] = mapped;
          changed = true;
        }
      }

      if (changed) {
        await db.structureOps.update(op.id!, { payload: next });
      }
    }
  }

  private async keepaliveTrees(): Promise<void> {
    if (!navigator.onLine) return;
    const cached = await db.trees.toArray();
    for (const entry of cached) {
      try {
        const fresh = await apiGetProject(entry.slug);
        await this.putCachedTree(entry.slug, fresh);
      } catch {
        // Silently skip — keepalive is best-effort
      }
    }
  }

  /**
   * Save a file. Always writes to local cache + queue first; network attempt
   * is best-effort and happens via flush().
   */
  async saveFile(
    slug: string,
    path: string,
    body: string,
    frontmatter: Record<string, unknown>,
    callerEtag: string,
  ): Promise<void> {
    const key = fileKey(slug, path);
    // Cache's serverEtag is authoritative; callerEtag is a cold-cache fallback only.
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
    // Coalesce: if we already have a pending write for this file, replace it.
    await db.transaction('rw', db.pending, async () => {
      const existing = await db.pending.where({ slug, path }).first();
      if (existing) {
        await db.pending.update(existing.id!, {
          body,
          frontmatter,
          baseEtag: effectiveEtag,
          queuedAt: Date.now(),
          attempts: 0,
          lastError: undefined,
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
    await this.refreshCounts();
    this.flush();
  }

  /**
   * Drain the pending queue. Safe to call concurrently — re-entrant calls return immediately.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    this.set({ status: 'syncing' });
    const structureOpsProcessed = await this.flushStructureOps();
    let lastError: string | null = null;
    let pendingProcessed = 0;
    try {
      while (true) {
        const next = await db.pending.orderBy('queuedAt').first();
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
          // Update cache to reflect server's new state.
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
          pendingProcessed++;
        } catch (e) {
          lastError = String(e);
          await db.pending.update(next.id!, {
            attempts: next.attempts + 1,
            lastError,
          });
          // Stop flushing on first failure to avoid hammering the server.
          break;
        }
      }
      this.set({
        lastFlushAt: Date.now(),
        lastError,
      });
    } finally {
      this.flushing = false;
      await this.refreshCounts();
      // Refresh trees from server, but only if this flush actually did something
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

  async listConflicts() {
    return db.conflicts.toArray();
  }

  async dismissConflict(key: string): Promise<void> {
    await db.conflicts.delete(key);
    await this.refreshCounts();
  }

  private async recordConflict(slug: string, conflictPath: string) {
    // conflict path: <stem>.conflict.<deviceId>.<ts>.<ext>
    // canonical = strip the .conflict.<...>.<ts> chunk.
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

  async prefetchProject(slug: string): Promise<void> {
    const tree = await this.getTree(slug);

    const paths: string[] = [];
    for (const ch of tree.chapters) {
      paths.push(ch.meta_path);
      for (const sc of ch.scenes) paths.push(sc.path);
    }
    for (const cat of tree.categories) {
      for (const entry of cat.entries) paths.push(entry.path);
    }

    const total = paths.length;
    let done = 0;
    this.set({ prefetchProgress: { done, total } });

    for (let i = 0; i < paths.length; i += PREFETCH_BATCH_SIZE) {
      const batch = paths.slice(i, i + PREFETCH_BATCH_SIZE);
      await Promise.all(
        batch.map(async (p) => {
          try {
            await this.getFile(slug, p);
          } catch {
            // Skip files that fail — best-effort prefetch
          }
          done++;
          this.set({ prefetchProgress: { done, total } });
        }),
      );
    }

    await db.kv.put({
      key: `prefetchedAt::${slug}`,
      value: String(Date.now()),
    });
    this.set({ prefetchProgress: null });
  }

  async getPrefetchedAt(slug: string): Promise<number | null> {
    const entry = await db.kv.get(`prefetchedAt::${slug}`);
    return entry ? Number(entry.value) : null;
  }

  private set(partial: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private async refreshCounts() {
    const pendingCount = await db.pending.count();
    const conflictCount = await db.conflicts.count();
    const structureOpsCount = await db.structureOps.count();
    let status: SyncStatus;
    if (conflictCount > 0) status = 'conflict';
    else if ((pendingCount > 0 || structureOpsCount > 0) && !navigator.onLine) status = 'offline';
    else if (pendingCount > 0 || structureOpsCount > 0) status = 'syncing';
    else status = 'idle';
    this.set({ pendingCount, conflictCount, structureOpsCount, status });
  }
}

export const syncEngine = new SyncEngine();


export type ConflictRow = ConflictMarker;

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}


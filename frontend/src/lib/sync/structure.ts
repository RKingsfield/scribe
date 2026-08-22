import type { SyncEngine } from './core';
import { cryptoRandomId, db, fileKey, OFFLINE_ETAG, type StructureOp } from '../db';
import {
  newChapter as apiNewChapter,
  newScene as apiNewScene,
  newCategoryEntry as apiNewCategoryEntry,
  deleteChapter as apiDeleteChapter,
  deleteFile as apiDeleteFile,
  reorder as apiReorder,
  moveScene as apiMoveScene,
  isTransientError,
} from '../api';
import {
  addChapterToTree,
  addSceneToTree,
  addCategoryEntryToTree,
  removeChapterFromTree,
  removeSceneFromTree,
  removeCategoryEntryFromTree,
  applyReorderToTree,
  moveSceneInTree,
  isOfflinePath,
} from '../offlineTree';
import { remapSinglePath } from './structureFlush';

async function queueStructureOp<T extends StructureOp['op']>(
  engine: SyncEngine,
  slug: string,
  op: T,
  payload: Extract<StructureOp, { op: T }>['payload'],
  tempId: string,
): Promise<void> {
  await db.structureOps.add({
    slug,
    op,
    payload,
    tempId,
    queuedAt: Date.now(),
    attempts: 0,
  } as StructureOp);
  await engine.refreshCounts();
}

export async function createChapter(
  engine: SyncEngine,
  slug: string,
  payload: {
    kind?: 'chapter' | 'interlude';
    act?: string;
    title?: string;
    chapter?: number;
    slug?: string;
  },
): Promise<{
  slug: string; path: string; meta_path: string; first_scene_path: string;
  kind: 'chapter' | 'interlude'; chapter: number | null; interlude: number | null; position: number;
}> {
  if (navigator.onLine) {
    try {
      const result = await apiNewChapter(slug, payload);
      await engine.getTree(slug, true);
      return result;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tempId = cryptoRandomId();
  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot create chapter offline without cached tree');

  const kind = payload.kind ?? 'chapter';
  const { tree: updated, metaPath, scenePath } = addChapterToTree(tree, {
    kind,
    act: payload.act,
    title: payload.title,
    tempId,
  });

  await engine.putCachedTree(slug, updated);
  const added = updated.chapters.find(c => c.slug === `_offline_${tempId}`)!;

  const defaultTitle = kind === 'chapter' ? `Chapter ${added.chapter}` : `Interlude ${added.interlude}`;
  const metaFm: Record<string, unknown> = { title: payload.title || defaultTitle, kind };
  if (kind === 'chapter') metaFm.chapter = added.chapter;
  else metaFm.interlude = added.interlude;
  if (added.act) metaFm.act = added.act;
  metaFm.order = added.order;

  await db.cache.put({
    key: fileKey(slug, metaPath),
    slug, path: metaPath,
    body: '', frontmatter: metaFm,
    serverEtag: OFFLINE_ETAG, cachedAt: Date.now(),
  });
  await db.cache.put({
    key: fileKey(slug, scenePath),
    slug, path: scenePath,
    body: '', frontmatter: {},
    serverEtag: OFFLINE_ETAG, cachedAt: Date.now(),
  });

  await queueStructureOp(engine, slug, 'new-chapter', payload, tempId);

  return {
    slug: added.slug, path: added.path,
    meta_path: metaPath, first_scene_path: scenePath,
    kind, chapter: added.chapter, interlude: added.interlude,
    position: added.order ?? 0,
  };
}

export async function createScene(
  engine: SyncEngine,
  slug: string,
  chapterSlug: string,
  payload: { title?: string },
): Promise<{ scene: number; path: string }> {
  if (navigator.onLine) {
    try {
      const result = await apiNewScene(slug, chapterSlug, payload);
      await engine.getTree(slug, true);
      return result;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tempId = cryptoRandomId();
  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot create scene offline without cached tree');

  const { tree: updated, scenePath } = addSceneToTree(tree, chapterSlug, tempId);
  await engine.putCachedTree(slug, updated);

  const ch = updated.chapters.find(c => c.slug === chapterSlug);
  const scene = ch?.scenes.find(s => s.path === scenePath);

  await db.cache.put({
    key: fileKey(slug, scenePath),
    slug, path: scenePath,
    body: '', frontmatter: payload.title ? { title: payload.title } : {},
    serverEtag: OFFLINE_ETAG, cachedAt: Date.now(),
  });

  await queueStructureOp(engine, slug, 'new-scene', { chapterSlug, ...payload }, tempId);

  return { scene: scene?.scene ?? 1, path: scenePath };
}

export async function createCategoryEntry(
  engine: SyncEngine,
  slug: string,
  folder: string,
  payload: { title: string; slug?: string },
): Promise<{ path: string; title: string }> {
  if (navigator.onLine) {
    try {
      const result = await apiNewCategoryEntry(slug, folder, payload);
      await engine.getTree(slug, true);
      return result;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tempId = cryptoRandomId();
  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot create entry offline without cached tree');

  const { tree: updated, entryPath } = addCategoryEntryToTree(tree, folder, {
    title: payload.title, tempId,
  });
  await engine.putCachedTree(slug, updated);

  await db.cache.put({
    key: fileKey(slug, entryPath),
    slug, path: entryPath,
    body: '', frontmatter: { title: payload.title },
    serverEtag: OFFLINE_ETAG, cachedAt: Date.now(),
  });

  await queueStructureOp(engine, slug, 'new-category-entry', { folder, ...payload }, tempId);
  return { path: entryPath, title: payload.title };
}

// Purge cached files, queued writes, and structure ops belonging to a deleted chapter so a stale
// pending edit can't recreate it server-side. Returns true if the chapter was only ever offline.
async function purgeChapterArtifacts(slug: string, chapterSlug: string): Promise<boolean> {
  const dirPrefix = `chapters/${chapterSlug}/`;

  // One transaction so a mid-purge crash can't leave pending writes that recreate deleted content.
  return db.transaction('rw', db.cache, db.pending, db.structureOps, async () => {
    const cached = await db.cache.where('slug').equals(slug).toArray();
    for (const entry of cached) {
      if (entry.path.startsWith(dirPrefix)) await db.cache.delete(entry.key);
    }

    const pendings = await db.pending.where('slug').equals(slug).toArray();
    for (const p of pendings) {
      if (p.path.startsWith(dirPrefix)) await db.pending.delete(p.id!);
    }

    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    let neverCreatedServerSide = false;
    for (const op of ops) {
      const targetsChapter =
        (op.op === 'new-scene' && op.payload.chapterSlug === chapterSlug) ||
        (op.op === 'move-scene' && op.payload.dstChapterSlug === chapterSlug) ||
        (op.op === 'new-chapter' && `_offline_${op.tempId}` === chapterSlug);
      if (!targetsChapter) continue;
      if (op.op === 'new-chapter') neverCreatedServerSide = true;
      await db.structureOps.delete(op.id!);
    }
    return neverCreatedServerSide;
  });
}

export async function removeChapter(
  engine: SyncEngine,
  slug: string,
  chapterSlug: string,
): Promise<void> {
  if (navigator.onLine) {
    try {
      await apiDeleteChapter(slug, chapterSlug);
      await purgeChapterArtifacts(slug, chapterSlug);
      await engine.getTree(slug, true);
      await engine.refreshCounts();
      return;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot delete chapter offline without cached tree');

  const updated = removeChapterFromTree(tree, chapterSlug);
  await engine.putCachedTree(slug, updated);
  const neverCreatedServerSide = await purgeChapterArtifacts(slug, chapterSlug);
  if (neverCreatedServerSide) {
    await engine.refreshCounts();
    return;
  }
  await queueStructureOp(engine, slug, 'delete-chapter', { chapterSlug }, chapterSlug);
}

// Purge a single deleted file's cached copy and queued write, and cancel its still-queued
// create op if it was an offline-created item (never reached the server → nothing to delete).
// `matchCreate` decides whether a queued create op targets this path. Returns true when a
// create was cancelled (deletion needs no server round-trip).
async function purgeDeletedPath(
  slug: string,
  path: string,
  matchCreate: (op: StructureOp) => boolean,
): Promise<boolean> {
  return db.transaction('rw', db.cache, db.pending, db.structureOps, async () => {
    await db.cache.delete(fileKey(slug, path));
    await db.pending.where({ slug, path }).delete();

    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    let neverCreatedServerSide = false;
    for (const op of ops) {
      if (!matchCreate(op)) continue;
      neverCreatedServerSide = true;
      await db.structureOps.delete(op.id!);
    }
    return neverCreatedServerSide;
  });
}

// The etag a queued delete replays as If-Match. A cache row still carrying the offline
// placeholder has no server copy to guard, so the replay stays unconditional.
async function queuedDeleteBaseEtag(slug: string, path: string): Promise<string | undefined> {
  const cached = await db.cache.get(fileKey(slug, path));
  if (!cached || cached.serverEtag === OFFLINE_ETAG) return undefined;
  return cached.serverEtag;
}

export async function deleteScene(
  engine: SyncEngine,
  slug: string,
  scenePath: string,
): Promise<void> {
  const matchCreate = (op: StructureOp) =>
    op.op === 'new-scene' &&
    `chapters/${op.payload.chapterSlug}/_offline_${op.tempId}.md` === scenePath;

  // An offline-created path has never existed server-side — deleting it is purely local.
  if (navigator.onLine && !isOfflinePath(scenePath)) {
    try {
      await apiDeleteFile(slug, scenePath);
      await purgeDeletedPath(slug, scenePath, matchCreate);
      await engine.getTree(slug, true);
      await engine.refreshCounts();
      return;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot delete scene offline without cached tree');

  await engine.putCachedTree(slug, removeSceneFromTree(tree, scenePath));
  const baseEtag = await queuedDeleteBaseEtag(slug, scenePath);
  const neverCreatedServerSide = await purgeDeletedPath(slug, scenePath, matchCreate);
  if (neverCreatedServerSide) {
    await engine.refreshCounts();
    return;
  }
  await queueStructureOp(engine, slug, 'delete-scene', { path: scenePath, baseEtag }, scenePath);
}

export async function deleteCategoryEntry(
  engine: SyncEngine,
  slug: string,
  path: string,
): Promise<void> {
  const matchCreate = (op: StructureOp) =>
    op.op === 'new-category-entry' &&
    `${op.payload.folder}/_offline_${op.tempId}.md` === path;

  if (navigator.onLine && !isOfflinePath(path)) {
    try {
      await apiDeleteFile(slug, path);
      await purgeDeletedPath(slug, path, matchCreate);
      await engine.getTree(slug, true);
      await engine.refreshCounts();
      return;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot delete entry offline without cached tree');

  await engine.putCachedTree(slug, removeCategoryEntryFromTree(tree, path));
  const baseEtag = await queuedDeleteBaseEtag(slug, path);
  const neverCreatedServerSide = await purgeDeletedPath(slug, path, matchCreate);
  if (neverCreatedServerSide) {
    await engine.refreshCounts();
    return;
  }
  await queueStructureOp(engine, slug, 'delete-category-entry', { path, baseEtag }, path);
}

export async function reorderItems(
  engine: SyncEngine,
  slug: string,
  items: { path: string; order: number; act?: string | null }[],
): Promise<void> {
  if (navigator.onLine) {
    try {
      await apiReorder(slug, items);
      await engine.getTree(slug, true);
      return;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot reorder offline without cached tree');

  const updated = applyReorderToTree(tree, items);
  await engine.putCachedTree(slug, updated);
  await queueStructureOp(engine, slug, 'reorder', { items }, cryptoRandomId());
}

export async function moveScene(
  engine: SyncEngine,
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
      await remapSinglePath(engine, slug, srcPath, result.new_path);
      await engine.getTree(slug, true);
      return;
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
  }

  const tree = await engine.getCachedTree(slug);
  if (!tree) throw new Error('Cannot move scene offline without cached tree');

  if (isOfflinePath(srcPath)) {
    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    const queuedCreate = ops.find(op =>
      op.op === 'new-scene' &&
      `chapters/${op.payload.chapterSlug}/_offline_${op.tempId}.md` === srcPath,
    );

    // Reuse the queued create's tempId so flush's temp-path remap still matches the moved file.
    const tempId = queuedCreate ? queuedCreate.tempId : cryptoRandomId();
    const { tree: updated, tempScenePath } = moveSceneInTree(
      tree, srcPath, dstChapterSlug, srcOrder, dstOrder, tempId,
    );
    await engine.putCachedTree(slug, updated);
    await engine.rekeyLocalPath(slug, srcPath, tempScenePath);
    if (queuedCreate) {
      // Carry the dragged order into the create so the scene is born at the dropped position,
      // and reorder the real siblings separately (the create replays first by queuedAt).
      const draggedOrder = dstOrder.find(o => o.path === srcPath)?.order;
      await db.structureOps.update(queuedCreate.id!, {
        payload: { ...queuedCreate.payload, chapterSlug: dstChapterSlug, order: draggedOrder },
      });
      const siblingItems = [...srcOrder, ...dstOrder].filter(o => o.path !== srcPath);
      if (siblingItems.length > 0) {
        await queueStructureOp(engine, slug, 'reorder', { items: siblingItems }, cryptoRandomId());
      }
    } else {
      await queueStructureOp(engine, slug, 'move-scene', {
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
  await engine.putCachedTree(slug, updated);
  await engine.rekeyLocalPath(slug, srcPath, tempScenePath);
  await queueStructureOp(engine, slug, 'move-scene', {
    srcPath,
    dstChapterSlug,
    srcOrder,
    dstOrder,
  }, tempId);
}

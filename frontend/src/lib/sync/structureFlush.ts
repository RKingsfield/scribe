import type { SyncEngine } from './core';
import type { StructureOp } from '../db';
import { db } from '../db';
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
import { remapTempPaths } from '../offlineTree';

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

// A reorder or move rewrites the files it touches, which changes their etags. Any queued
// delete of one of those paths still carries the etag from before our own write, so it
// would 412 forever — drop it. The guard exists against other devices, not against us.
async function dropDeleteEtags(slug: string, rewritten: string[]): Promise<void> {
  const paths = new Set(rewritten);
  if (paths.size === 0) return;
  const ops = await db.structureOps.where('slug').equals(slug).toArray();
  for (const op of ops) {
    if (op.op !== 'delete-scene' && op.op !== 'delete-category-entry') continue;
    if (!op.payload.baseEtag || !paths.has(op.payload.path)) continue;
    await db.structureOps.update(op.id!, {
      payload: { path: op.payload.path },
    } as Partial<StructureOp>);
  }
}

export async function flushStructureOps(engine: SyncEngine): Promise<number> {
  let processed = 0;
  while (true) {
    // Stuck ops are parked, not gone — skip them here (in queuedAt order) so
    // the rest of the queue keeps draining; they still surface via stuckOpsCount.
    const next = await db.structureOps.orderBy('queuedAt').filter(op => !op.stuckAt).first();
    if (!next) break;

    try {
      switch (next.op) {
        case 'new-chapter': {
          const { kind, act, title, chapter, slug: chapterSlug } = next.payload;
          const result = await apiNewChapter(next.slug, { kind, act, title, chapter, slug: chapterSlug });
          await remapPaths(
            engine,
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
          const { chapterSlug, ...rest } = next.payload;
          const result = await apiNewScene(next.slug, chapterSlug, rest);
          const tempPath = `chapters/${chapterSlug}/_offline_${next.tempId}.md`;
          await remapSinglePath(engine, next.slug, tempPath, result.path);
          break;
        }
        case 'new-category-entry': {
          const { folder, ...rest } = next.payload;
          const result = await apiNewCategoryEntry(next.slug, folder, rest);
          const tempPath = `${folder}/_offline_${next.tempId}.md`;
          await remapSinglePath(engine, next.slug, tempPath, result.path);
          break;
        }
        case 'delete-chapter': {
          const { chapterSlug } = next.payload;
          await apiDeleteChapter(next.slug, chapterSlug);
          break;
        }
        case 'delete-scene':
        case 'delete-category-entry': {
          // 404 = already gone (another device deleted it) → success, keeps replay idempotent.
          // The captured etag makes the replay conditional: another device's newer edit
          // survives as a 412 park instead of being destroyed by a stale queued delete.
          await apiDeleteFile(next.slug, next.payload.path, {
            tolerate404: true,
            ifMatch: next.payload.baseEtag,
          });
          break;
        }
        case 'reorder': {
          const { items } = next.payload;
          const result = await apiReorder(next.slug, items);
          await dropDeleteEtags(next.slug, result.updated);
          break;
        }
        case 'move-scene': {
          const { srcPath, dstChapterSlug, srcOrder, dstOrder } = next.payload;
          const result = await apiMoveScene(next.slug, {
            src_path: srcPath,
            dst_chapter_slug: dstChapterSlug,
            src_order: srcOrder,
            dst_order: dstOrder,
          });
          const tempPath = `chapters/${dstChapterSlug}/_offline_${next.tempId}.md`;
          await remapSinglePath(engine, next.slug, tempPath, result.new_path);
          await dropDeleteEtags(next.slug, [
            result.new_path,
            ...srcOrder.map(o => o.path),
            ...dstOrder.map(o => o.path),
          ]);
          break;
        }
      }
      await db.structureOps.delete(next.id!);
      processed++;
    } catch (e) {
      if (isTransientError(e)) {
        // Retry the same op next flush, in place — the queue stays ordered.
        await db.structureOps.update(next.id!, {
          attempts: next.attempts + 1,
          lastError: String(e),
        });
        break;
      }
      // Permanent failures won't resolve on their own (e.g. the target was
      // deleted from elsewhere) — park the op and keep draining the rest.
      await db.structureOps.update(next.id!, {
        attempts: next.attempts + 1,
        lastError: String(e),
        stuckAt: Date.now(),
      });
    }
  }
  await engine.refreshCounts();
  return processed;
}

function remapArrayPaths<T extends { path: string }>(
  arr: T[],
  mapFn: (path: string) => string | null,
): { arr: T[]; changed: boolean } {
  let changed = false;
  const mapped = arr.map(e => {
    const newPath = mapFn(e.path);
    if (newPath === null) return e;
    changed = true;
    return { ...e, path: newPath };
  });
  return { arr: mapped, changed };
}

function remapQueuedOpForChapter(
  op: StructureOp,
  tempSlug: string,
  tempPrefix: string,
  target: { slug: string; path: string; meta_path: string; first_scene_path: string },
): StructureOp | null {
  const mapPath = (path: string) => mapTempPath(path, tempPrefix, target);

  switch (op.op) {
    case 'new-chapter':
    case 'new-category-entry':
      return null;
    case 'new-scene':
    case 'delete-chapter': {
      if (op.payload.chapterSlug !== tempSlug) return null;
      return { ...op, payload: { ...op.payload, chapterSlug: target.slug } };
    }
    case 'delete-scene':
    case 'delete-category-entry': {
      const mapped = mapPath(op.payload.path);
      return mapped !== null ? { ...op, payload: { ...op.payload, path: mapped } } : null;
    }
    case 'reorder': {
      const { arr, changed } = remapArrayPaths(op.payload.items, mapPath);
      return changed ? { ...op, payload: { ...op.payload, items: arr } } : null;
    }
    case 'move-scene': {
      let payload = op.payload;
      let changed = false;

      if (payload.dstChapterSlug === tempSlug) {
        payload = { ...payload, dstChapterSlug: target.slug };
        changed = true;
      }
      const mappedSrcPath = mapPath(payload.srcPath);
      if (mappedSrcPath !== null) {
        payload = { ...payload, srcPath: mappedSrcPath };
        changed = true;
      }
      const srcOrder = remapArrayPaths(payload.srcOrder, mapPath);
      if (srcOrder.changed) {
        payload = { ...payload, srcOrder: srcOrder.arr };
        changed = true;
      }
      const dstOrder = remapArrayPaths(payload.dstOrder, mapPath);
      if (dstOrder.changed) {
        payload = { ...payload, dstOrder: dstOrder.arr };
        changed = true;
      }

      return changed ? { ...op, payload } : null;
    }
  }
}

async function remapPaths(
  engine: SyncEngine,
  slug: string,
  tempSlug: string,
  target: { slug: string; path: string; meta_path: string; first_scene_path: string },
): Promise<void> {
  const tree = await engine.getCachedTree(slug);
  if (tree) {
    const updated = remapTempPaths(tree, tempSlug, target);
    await engine.putCachedTree(slug, updated);
  }

  const tempPrefix = `chapters/${tempSlug}/`;
  const cached = await db.cache.where('slug').equals(slug).toArray();
  for (const entry of cached) {
    const newPath = mapTempPath(entry.path, tempPrefix, target);
    if (newPath === null) continue;
    await engine.rekeyLocalPath(slug, entry.path, newPath);
  }

  const ops = await db.structureOps.where('slug').equals(slug).toArray();
  for (const op of ops) {
    const remapped = remapQueuedOpForChapter(op, tempSlug, tempPrefix, target);
    if (remapped) {
      await db.structureOps.update(op.id!, { payload: remapped.payload } as Partial<StructureOp>);
    }
  }
}

function remapQueuedOpForPath(op: StructureOp, tempPath: string, realPath: string): StructureOp | null {
  const mapPath = (path: string) => path === tempPath ? realPath : null;

  switch (op.op) {
    case 'new-chapter':
    case 'new-scene':
    case 'new-category-entry':
    case 'delete-chapter':
      return null;
    case 'delete-scene':
    case 'delete-category-entry': {
      const mapped = mapPath(op.payload.path);
      return mapped !== null ? { ...op, payload: { ...op.payload, path: mapped } } : null;
    }
    case 'reorder': {
      const { arr, changed } = remapArrayPaths(op.payload.items, mapPath);
      return changed ? { ...op, payload: { ...op.payload, items: arr } } : null;
    }
    case 'move-scene': {
      let payload = op.payload;
      let changed = false;

      if (payload.srcPath === tempPath) {
        payload = { ...payload, srcPath: realPath };
        changed = true;
      }
      const srcOrder = remapArrayPaths(payload.srcOrder, mapPath);
      if (srcOrder.changed) {
        payload = { ...payload, srcOrder: srcOrder.arr };
        changed = true;
      }
      const dstOrder = remapArrayPaths(payload.dstOrder, mapPath);
      if (dstOrder.changed) {
        payload = { ...payload, dstOrder: dstOrder.arr };
        changed = true;
      }

      return changed ? { ...op, payload } : null;
    }
  }
}

export async function remapSinglePath(
  engine: SyncEngine,
  slug: string,
  tempPath: string,
  realPath: string,
): Promise<void> {
  const tree = await engine.getCachedTree(slug);
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
    await engine.putCachedTree(slug, { ...tree, chapters, categories });
  }

  await engine.rekeyLocalPath(slug, tempPath, realPath);

  const ops = await db.structureOps.where('slug').equals(slug).toArray();
  for (const op of ops) {
    const remapped = remapQueuedOpForPath(op, tempPath, realPath);
    if (remapped) {
      await db.structureOps.update(op.id!, { payload: remapped.payload } as Partial<StructureOp>);
    }
  }
}

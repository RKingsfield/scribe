import type { SyncEngine } from './core';
import type { ProjectTree, ProjectListItem } from '../api';
import {
  getProject as apiGetProject,
  listProjects as apiListProjects,
  isTransientError,
} from '../api';
import { db, ensureOpen } from '../db';

const PROJECT_LIST_TIMEOUT_MS = 3000;

export async function getTree(
  engine: SyncEngine,
  slug: string,
  forceRefresh = false,
): Promise<ProjectTree> {
  const cached = await db.trees.get(slug);
  if (cached && navigator.onLine && !forceRefresh) {
    apiGetProject(slug)
      .then((tree) => db.trees.put({ slug, tree, cachedAt: Date.now() }))
      .catch((e) => {
        if (!isTransientError(e)) console.warn('background refresh failed', e);
      });
    return cached.tree;
  }
  if (navigator.onLine) {
    try {
      const tree = await apiGetProject(slug);
      await db.trees.put({ slug, tree, cachedAt: Date.now() });
      return tree;
    } catch (e) {
      // Only a transient failure means the network is the problem — a 404 on a deleted
      // project is the request being wrong while the connection is fine.
      if (isTransientError(e)) engine.set({ status: 'offline', lastError: String(e) });
      else engine.set({ lastError: String(e) });
      if (cached) return cached.tree;
    }
  }
  if (cached) return cached.tree;
  throw new Error(`Project tree not in cache and network unavailable: ${slug}`);
}

export async function keepaliveTrees(engine: SyncEngine): Promise<void> {
  if (!navigator.onLine) return;
  // Skip the poll entirely on a backgrounded tab — nothing to keep warm.
  if (typeof document !== 'undefined' && document.hidden) return;
  const cached = await db.trees.toArray();
  await Promise.all(
    cached.map(async (entry) => {
      try {
        const fresh = await apiGetProject(entry.slug);
        await engine.putCachedTree(entry.slug, fresh);
      } catch {
        // best-effort
      }
    }),
  );
}

export async function listProjects(): Promise<ProjectListItem[]> {
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

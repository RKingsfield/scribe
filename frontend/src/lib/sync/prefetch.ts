import type { SyncEngine } from './core';
import { db, fileKey } from '../db';
import { getFile as apiGetFile } from '../api';

const PREFETCH_BATCH_SIZE = 5;

export async function prefetchProject(engine: SyncEngine, slug: string): Promise<void> {
  const tree = await engine.getTree(slug);

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
  engine.set({ prefetchProgress: { done, total } });

  for (let i = 0; i < paths.length; i += PREFETCH_BATCH_SIZE) {
    const batch = paths.slice(i, i + PREFETCH_BATCH_SIZE);
    await Promise.all(
      batch.map(async (p) => {
        try {
          const existing = await db.cache.get(fileKey(slug, p));
          const hadRow = existing !== undefined;
          const etagAtFetch = existing?.serverEtag;
          const fresh = await apiGetFile(slug, p);
          // Same protection as getFile's background refresh: don't clobber a queued local edit.
          const pending = await db.pending.where({ slug, path: p }).first();
          // Only write when the world is unchanged since the snapshot (mirrors getFile's
          // guard) - a slow prefetch response must not clobber a newer cache entry, resurrect
          // a row deleted while the GET was in flight, or overwrite a row created mid-flight
          // (e.g. the user opened this uncached scene while the prefetch GET was in the air).
          const current = await db.cache.get(fileKey(slug, p));
          const worldChanged = hadRow
            ? (!current || current.serverEtag !== etagAtFetch)
            : current !== undefined;
          if (!pending && !worldChanged) {
            await db.cache.put({
              key: fileKey(slug, p),
              slug,
              path: p,
              body: fresh.body,
              frontmatter: fresh.frontmatter,
              serverEtag: fresh.etag,
              cachedAt: Date.now(),
            });
          }
        } catch {
          // best-effort
        }
        done++;
        engine.set({ prefetchProgress: { done, total } });
      }),
    );
  }

  await db.kv.put({
    key: `prefetchedAt::${slug}`,
    value: String(Date.now()),
  });
  engine.set({ prefetchProgress: null });
}

export async function getPrefetchedAt(slug: string): Promise<number | null> {
  const entry = await db.kv.get(`prefetchedAt::${slug}`);
  return entry ? Number(entry.value) : null;
}

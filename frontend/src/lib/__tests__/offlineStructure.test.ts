import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, fileKey, OFFLINE_ETAG, type StructureOp } from '../db';

if (typeof globalThis.navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
}
Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    getFile: vi.fn(),
    putFile: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    newChapter: vi.fn(),
    newScene: vi.fn(),
    newCategoryEntry: vi.fn(),
    deleteChapter: vi.fn(),
    deleteFile: vi.fn(),
    reorder: vi.fn(),
    moveScene: vi.fn(),
    isTransientError: actual.isTransientError,
    HttpError: actual.HttpError,
  };
});

vi.mock('../words', () => ({
  countWords: (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0),
}));

import { HttpError } from '../api';
import { syncEngine } from '../syncEngine';

async function clearAllTables() {
  await db.cache.clear();
  await db.pending.clear();
  await db.conflicts.clear();
  await db.kv.clear();
  await db.trees.clear();
  await db.structureOps.clear();
}

const emptyTree = {
  slug: 'proj',
  title: 'Test Project',
  author: null,
  rag_recipe: null,
  default_model: 'x',
  acts: [],
  chapters: [],
  categories: [],
};

function chapter(slug: string, chapterNo: number, scenePaths: string[]) {
  return {
    path: `chapters/${slug}`,
    meta_path: `chapters/${slug}/chapter.md`,
    slug,
    kind: 'chapter' as const,
    title: `Chapter ${chapterNo}`,
    summary: null,
    chapter: chapterNo,
    interlude: null,
    order: chapterNo,
    act: null,
    word_count: 0,
    scenes: scenePaths.map((p, i) => ({
      path: p, title: null, summary: null,
      scene: i + 1, order: i + 1, pov: null, status: null, words_target: null, word_count: 0,
    })),
  };
}

describe('offline structure-op integrity', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('F5: queued scene edit + delete chapter leaves no stale rows and never recreates the file', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md'])],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    const scenePath = 'chapters/01_Chapter_01/01.md';
    const metaPath = 'chapters/01_Chapter_01/chapter.md';

    // A still-queued scene edit under the chapter about to be deleted.
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'unsynced edit', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey('proj', metaPath), slug: 'proj', path: metaPath,
      body: '', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj', path: scenePath, body: 'unsynced edit', frontmatter: {},
      baseEtag: 'e1', queuedAt: Date.now(), attempts: 0,
    });

    vi.mocked(api.deleteChapter).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.removeChapter('proj', '01_Chapter_01');

    const cacheRows = await db.cache.where('slug').equals('proj').toArray();
    expect(cacheRows.some(c => c.path.startsWith('chapters/01_Chapter_01/'))).toBe(false);
    const pendingRows = await db.pending.where('slug').equals('proj').toArray();
    expect(pendingRows.some(p => p.path.startsWith('chapters/01_Chapter_01/'))).toBe(false);

    const putFileMock = vi.mocked(api.putFile);
    await syncEngine.flush();
    const recreated = putFileMock.mock.calls.some(
      ([, path]) => path.startsWith('chapters/01_Chapter_01/'),
    );
    expect(recreated).toBe(false);
  });

  it('F4: offline create-then-move-cross-chapter lands the body at the real destination with no _offline_ PUT', async () => {
    const api = await import('../api');
    const treeWithChapters = {
      ...emptyTree,
      chapters: [
        chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md']),
        chapter('02_Chapter_02', 2, ['chapters/02_Chapter_02/01.md']),
      ],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapters, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(api.putFile).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});
    await syncEngine.saveFile('proj', scene.path, 'moved body', {}, 'offline');

    await syncEngine.moveScene('proj', {
      srcPath: scene.path,
      dstChapterSlug: '02_Chapter_02',
      srcOrder: [],
      dstOrder: [
        { path: 'chapters/02_Chapter_02/01.md', order: 1 },
        { path: scene.path, order: 2 },
      ],
    });

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newScene).mockReset();
    vi.mocked(api.newScene).mockResolvedValueOnce({ scene: 2, path: 'chapters/02_Chapter_02/02.md' });
    const putFileMock = vi.mocked(api.putFile);
    putFileMock.mockReset();
    putFileMock.mockImplementation(async (_slug, path, payload) => ({
      path, body: payload.body, frontmatter: payload.frontmatter,
      etag: `etag-${path}`, word_count: 1,
    }));
    vi.mocked(api.reorder).mockResolvedValue({ updated: [], count: 0 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
      expect(await db.pending.count()).toBe(0);
    });

    const putPaths = putFileMock.mock.calls.map(([, path]) => path);
    expect(putPaths.some(p => p.includes('_offline_'))).toBe(false);
    expect(putFileMock.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          'proj', 'chapters/02_Chapter_02/02.md',
          expect.objectContaining({ body: 'moved body' }),
        ]),
      ]),
    );

    const cacheRows = await db.cache.where('slug').equals('proj').toArray();
    expect(cacheRows.some(c => c.path.includes('_offline_') || c.key.includes('_offline_'))).toBe(false);
  });

  it('M5b: online cross-chapter move remaps the device-local conflict marker to the new scene path', async () => {
    const api = await import('../api');
    const treeWithChapters = {
      ...emptyTree,
      chapters: [
        chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md']),
        chapter('11_Chapter_11', 11, [
          'chapters/11_Chapter_11/01.md', 'chapters/11_Chapter_11/02.md',
        ]),
      ],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapters, cachedAt: Date.now() });

    const srcPath = 'chapters/01_Chapter_01/01.md';
    const conflictPath = 'chapters/01_Chapter_01/01.conflict.dev1.20260101T000000Z.md';
    await db.conflicts.put({
      key: fileKey('proj', conflictPath),
      slug: 'proj',
      path: conflictPath,
      canonicalPath: srcPath,
      deviceId: 'dev1',
      timestamp: '20260101T000000Z',
      noticedAt: Date.now(),
    });

    vi.mocked(api.moveScene).mockResolvedValueOnce({
      new_path: 'chapters/11_Chapter_11/03.md', scene: 3,
    });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.moveScene('proj', {
      srcPath,
      dstChapterSlug: '11_Chapter_11',
      srcOrder: [],
      dstOrder: [
        { path: 'chapters/11_Chapter_11/01.md', order: 1 },
        { path: 'chapters/11_Chapter_11/02.md', order: 2 },
        { path: srcPath, order: 3 },
      ],
    });

    expect(await db.conflicts.get(fileKey('proj', conflictPath))).toBeUndefined();
    const newConflictPath = 'chapters/11_Chapter_11/03.conflict.dev1.20260101T000000Z.md';
    const moved = await db.conflicts.get(fileKey('proj', newConflictPath));
    expect(moved).toBeDefined();
    expect(moved!.path).toBe(newConflictPath);
    expect(moved!.canonicalPath).toBe('chapters/11_Chapter_11/03.md');
    expect(moved!.deviceId).toBe('dev1');
    expect(moved!.timestamp).toBe('20260101T000000Z');
  });

  it('M5b: offline cross-chapter move, then reconnect + flush, remaps the conflict marker through the temp path to the final scene path', async () => {
    const api = await import('../api');
    const treeWithChapters = {
      ...emptyTree,
      chapters: [
        chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md']),
        chapter('11_Chapter_11', 11, [
          'chapters/11_Chapter_11/01.md', 'chapters/11_Chapter_11/02.md',
        ]),
      ],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapters, cachedAt: Date.now() });

    const srcPath = 'chapters/01_Chapter_01/01.md';
    const conflictPath = 'chapters/01_Chapter_01/01.conflict.dev1.20260101T000000Z.md';
    await db.conflicts.put({
      key: fileKey('proj', conflictPath),
      slug: 'proj',
      path: conflictPath,
      canonicalPath: srcPath,
      deviceId: 'dev1',
      timestamp: '20260101T000000Z',
      noticedAt: Date.now(),
    });

    (navigator as { onLine: boolean }).onLine = false;

    await syncEngine.moveScene('proj', {
      srcPath,
      dstChapterSlug: '11_Chapter_11',
      srcOrder: [],
      dstOrder: [
        { path: 'chapters/11_Chapter_11/01.md', order: 1 },
        { path: 'chapters/11_Chapter_11/02.md', order: 2 },
        { path: srcPath, order: 3 },
      ],
    });

    // Old marker is gone; it now sits at a temp-derived path (unreachable
    // while offline, but not orphaned) keyed to the queued move's tempId.
    expect(await db.conflicts.get(fileKey('proj', conflictPath))).toBeUndefined();
    const ops = await db.structureOps.toArray();
    const moveOp = ops.find(o => o.op === 'move-scene');
    if (moveOp?.op !== 'move-scene') throw new Error('expected a move-scene op');
    const tempScenePath = `chapters/11_Chapter_11/_offline_${moveOp.tempId}.md`;
    const tempConflictPath = `chapters/11_Chapter_11/_offline_${moveOp.tempId}.conflict.dev1.20260101T000000Z.md`;
    const atTemp = await db.conflicts.get(fileKey('proj', tempConflictPath));
    expect(atTemp).toBeDefined();
    expect(atTemp!.canonicalPath).toBe(tempScenePath);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.moveScene).mockResolvedValueOnce({
      new_path: 'chapters/11_Chapter_11/03.md', scene: 3,
    });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(await db.conflicts.get(fileKey('proj', conflictPath))).toBeUndefined();
    expect(await db.conflicts.get(fileKey('proj', tempConflictPath))).toBeUndefined();
    const newConflictPath = 'chapters/11_Chapter_11/03.conflict.dev1.20260101T000000Z.md';
    const moved = await db.conflicts.get(fileKey('proj', newConflictPath));
    expect(moved).toBeDefined();
    expect(moved!.path).toBe(newConflictPath);
    expect(moved!.canonicalPath).toBe('chapters/11_Chapter_11/03.md');
    expect(moved!.key).toBe(fileKey('proj', newConflictPath));
  });

  it('R4: a saveFile interleaved with rekeyLocalPath leaves no cache/pending row under the old path', async () => {
    const oldPath = 'chapters/01_Chapter_01/01.md';
    const newPath = 'chapters/11_Chapter_11/01.md';

    await db.cache.put({
      key: fileKey('proj', oldPath), slug: 'proj', path: oldPath,
      body: 'original', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });

    // Fire both without awaiting in between: saveFile's transaction is opened
    // first, so it must commit before rekeyLocalPath's transaction begins —
    // exercising the same race the single-transaction rekey is meant to survive.
    const savePromise = syncEngine.saveFile('proj', oldPath, 'edited', {}, 'e1');
    const rekeyPromise = syncEngine.rekeyLocalPath('proj', oldPath, newPath);
    await Promise.all([savePromise, rekeyPromise]);

    const oldCache = await db.cache.get(fileKey('proj', oldPath));
    const oldPending = await db.pending.where({ slug: 'proj', path: oldPath }).toArray();
    expect(oldCache).toBeUndefined();
    expect(oldPending).toHaveLength(0);

    const newCache = await db.cache.get(fileKey('proj', newPath));
    const newPending = await db.pending.where({ slug: 'proj', path: newPath }).toArray();
    expect(newCache?.body).toBe('edited');
    expect(newPending).toHaveLength(1);
  });

  it('N4: offline scene delete queues a delete-scene op, patches tree/cache/pending, replays on flush', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [chapter('01_Chapter_01', 1, [
        'chapters/01_Chapter_01/01.md', 'chapters/01_Chapter_01/02.md',
      ])],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    const scenePath = 'chapters/01_Chapter_01/02.md';
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'x', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj', path: scenePath, body: 'x', frontmatter: {},
      baseEtag: 'e1', queuedAt: Date.now(), attempts: 0,
    });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.deleteScene('proj', scenePath);

    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('delete-scene');
    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.chapters[0].scenes.map(s => s.path)).toEqual(['chapters/01_Chapter_01/01.md']);
    expect(await db.cache.get(fileKey('proj', scenePath))).toBeUndefined();
    expect(await db.pending.where({ slug: 'proj', path: scenePath }).count()).toBe(0);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();

    // The cache row's server etag rides along so the replay is conditional.
    expect(api.deleteFile).toHaveBeenCalledWith('proj', scenePath, {
      tolerate404: true, ifMatch: 'e1',
    });
    expect(await db.structureOps.count()).toBe(0);
  });

  it('R9: a delete replay rejected on a stale etag parks the op and leaves the file alone', async () => {
    const api = await import('../api');
    const scenePath = 'chapters/01_Chapter_01/02.md';
    await db.trees.put({
      slug: 'proj',
      tree: { ...emptyTree, chapters: [chapter('01_Chapter_01', 1, [
        'chapters/01_Chapter_01/01.md', scenePath,
      ])] },
      cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'x', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.deleteScene('proj', scenePath);
    (navigator as { onLine: boolean }).onLine = true;

    vi.mocked(api.deleteFile).mockRejectedValueOnce(
      new HttpError(412, 'Precondition Failed', 'etag mismatch (server=e2)'),
    );
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();

    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].stuckAt).toBeDefined();
    expect(ops[0].lastError).toContain('412');
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(1);
  });

  it('R9: our own reorder replay drops the captured etag, so the queued delete still lands', async () => {
    const api = await import('../api');
    const scenePath = 'chapters/01_Chapter_01/02.md';
    const siblingPath = 'chapters/01_Chapter_01/01.md';
    await db.trees.put({
      slug: 'proj',
      tree: { ...emptyTree, chapters: [chapter('01_Chapter_01', 1, [siblingPath, scenePath])] },
      cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'x', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.reorderItems('proj', [
      { path: scenePath, order: 1 },
      { path: siblingPath, order: 2 },
    ]);
    await syncEngine.deleteScene('proj', scenePath);
    (navigator as { onLine: boolean }).onLine = true;

    // The server rewrites both reordered files, so the delete's queue-time etag is
    // stale against our own write — the replay must not send it.
    vi.mocked(api.reorder).mockResolvedValueOnce({
      updated: [scenePath, siblingPath], count: 2,
    });
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', scenePath, {
      tolerate404: true, ifMatch: undefined,
    });
    expect(await db.structureOps.count()).toBe(0);
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(0);
  });

  it('R9: a reorder that leaves the deleted path alone keeps the etag guard', async () => {
    const api = await import('../api');
    const scenePath = 'chapters/01_Chapter_01/02.md';
    const siblingPath = 'chapters/01_Chapter_01/01.md';
    await db.trees.put({
      slug: 'proj',
      tree: { ...emptyTree, chapters: [chapter('01_Chapter_01', 1, [siblingPath, scenePath])] },
      cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'x', frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.reorderItems('proj', [{ path: siblingPath, order: 1 }]);
    await syncEngine.deleteScene('proj', scenePath);
    (navigator as { onLine: boolean }).onLine = true;

    vi.mocked(api.reorder).mockResolvedValueOnce({ updated: [siblingPath], count: 1 });
    // Another device edited the scene meanwhile: the guard still fires and parks the op.
    vi.mocked(api.deleteFile).mockRejectedValueOnce(
      new HttpError(412, 'Precondition Failed', 'etag mismatch (server=e2)'),
    );
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', scenePath, {
      tolerate404: true, ifMatch: 'e1',
    });
    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].stuckAt).toBeDefined();
  });

  it('R9: a delete of an offline-only file replays unconditionally', async () => {
    const api = await import('../api');
    const scenePath = 'chapters/01_Chapter_01/02.md';
    await db.trees.put({
      slug: 'proj',
      tree: { ...emptyTree, chapters: [chapter('01_Chapter_01', 1, [scenePath])] },
      cachedAt: Date.now(),
    });
    await db.cache.put({
      key: fileKey('proj', scenePath), slug: 'proj', path: scenePath,
      body: 'x', frontmatter: {}, serverEtag: OFFLINE_ETAG, cachedAt: Date.now(),
    });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.deleteScene('proj', scenePath);
    (navigator as { onLine: boolean }).onLine = true;

    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', scenePath, {
      tolerate404: true, ifMatch: undefined,
    });
  });

  it('N4: offline category-entry delete queues a delete-category-entry op and replays', async () => {
    const api = await import('../api');
    const treeWithCat = {
      ...emptyTree,
      categories: [{
        name: 'Characters', folder: 'characters', codex: true,
        entries: [{ path: 'characters/asha.md', title: 'Asha', aliases: [], tags: [], order: 1 }],
      }],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithCat, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    await syncEngine.deleteCategoryEntry('proj', 'characters/asha.md');

    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('delete-category-entry');
    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.categories[0].entries).toHaveLength(0);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', 'characters/asha.md', {
      tolerate404: true, ifMatch: undefined,
    });
    expect(await db.structureOps.count()).toBe(0);
  });

  it('N4: deleting an offline-created scene cancels its queued create — flush makes no newScene call', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md'])],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});
    expect(await db.structureOps.count()).toBe(1);

    await syncEngine.deleteScene('proj', scene.path);

    // Create cancelled, no delete op queued (nothing existed server-side).
    expect(await db.structureOps.count()).toBe(0);
    expect(await db.cache.get(fileKey('proj', scene.path))).toBeUndefined();

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newScene).mockReset();
    vi.mocked(api.newScene).mockResolvedValue({ scene: 2, path: 'chapters/01_Chapter_01/02.md' });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();

    expect(api.newScene).not.toHaveBeenCalled();
  });

  it('N4: deleting an offline-created scene while back online but pre-flush cancels the create without a server call', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md'])],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));
    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});
    expect(await db.structureOps.count()).toBe(1);

    // Back online, but the queued create has not flushed yet.
    (navigator as { onLine: boolean }).onLine = true;
    await syncEngine.deleteScene('proj', scene.path);

    expect(api.deleteFile).not.toHaveBeenCalled();
    expect(await db.structureOps.count()).toBe(0);
    expect(await db.cache.get(fileKey('proj', scene.path))).toBeUndefined();
    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.chapters[0].scenes.some((s) => s.path === scene.path)).toBe(false);
  });

  it('N4: replaying a delete whose file is already gone (404-tolerated) clears the op and does not block the queue', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 1, attempts: 0,
    } as StructureOp);
    await db.structureOps.add({
      slug: 'proj', op: 'delete-category-entry', payload: { path: 'characters/gone.md' },
      tempId: 'characters/gone.md', queuedAt: 2, attempts: 0,
    } as StructureOp);

    // The real deleteFile swallows a 404 when tolerate404 is set; the mock resolves in its place.
    vi.mocked(api.deleteFile).mockResolvedValue(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.flush();

    expect(vi.mocked(api.deleteFile)).toHaveBeenCalledTimes(2);
    expect(await db.structureOps.count()).toBe(0);
  });

  it('N3: offline create then cross-chapter move carries the dragged order into the create and queues a sibling reorder', async () => {
    const api = await import('../api');
    const treeWithChapters = {
      ...emptyTree,
      chapters: [
        chapter('01_Chapter_01', 1, ['chapters/01_Chapter_01/01.md']),
        chapter('02_Chapter_02', 2, [
          'chapters/02_Chapter_02/01.md', 'chapters/02_Chapter_02/02.md',
        ]),
      ],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapters, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});
    // Drop between chapter 2's two scenes → dragged order 2, siblings shift to 1 and 3.
    await syncEngine.moveScene('proj', {
      srcPath: scene.path,
      dstChapterSlug: '02_Chapter_02',
      srcOrder: [],
      dstOrder: [
        { path: 'chapters/02_Chapter_02/01.md', order: 1 },
        { path: scene.path, order: 2 },
        { path: 'chapters/02_Chapter_02/02.md', order: 3 },
      ],
    });

    const ops = await db.structureOps.toArray();
    const createOp = ops.find(o => o.op === 'new-scene');
    if (createOp?.op !== 'new-scene') throw new Error('expected a new-scene op');
    expect(createOp.payload).toMatchObject({ chapterSlug: '02_Chapter_02', order: 2 });
    const reorderOp = ops.find(o => o.op === 'reorder');
    if (reorderOp?.op !== 'reorder') throw new Error('expected a reorder op');
    expect(reorderOp.payload.items).toEqual([
      { path: 'chapters/02_Chapter_02/01.md', order: 1 },
      { path: 'chapters/02_Chapter_02/02.md', order: 3 },
    ]);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newScene).mockReset();
    vi.mocked(api.newScene).mockResolvedValueOnce({ scene: 3, path: 'chapters/02_Chapter_02/03.md' });
    const reorderMock = vi.mocked(api.reorder);
    reorderMock.mockResolvedValue({ updated: [], count: 2 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(api.newScene).toHaveBeenCalledWith('proj', '02_Chapter_02', { order: 2 });
    expect(reorderMock).toHaveBeenCalledWith('proj', [
      { path: 'chapters/02_Chapter_02/01.md', order: 1 },
      { path: 'chapters/02_Chapter_02/02.md', order: 3 },
    ]);

    const cacheRows = await db.cache.where('slug').equals('proj').toArray();
    expect(cacheRows.some(c => c.path.includes('_offline_') || c.key.includes('_offline_'))).toBe(false);
  });

  it('T5: a non-network replay failure marks the op stuck and the queue keeps draining past it', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 0,
    } as StructureOp);
    await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 2, attempts: 0,
    } as StructureOp);

    vi.mocked(api.deleteChapter).mockRejectedValueOnce(new Error('409 Conflict: chapter has scenes'));
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', 'chapters/01_Chapter_01/09.md', {
      tolerate404: true, ifMatch: undefined,
    });

    const remaining = await db.structureOps.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].op).toBe('delete-chapter');
    expect(remaining[0].stuckAt).toBeDefined();
    expect(remaining[0].lastError).toContain('409');

    const snap = syncEngine.getSnapshot();
    expect(snap.stuckOpsCount).toBe(1);
    expect(snap.status).toBe('idle');
  });

  it('T5: a network error during replay still breaks the loop, leaving later ops unprocessed and not stuck', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 0,
    } as StructureOp);
    await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 2, attempts: 0,
    } as StructureOp);

    vi.mocked(api.deleteChapter).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await syncEngine.flush();

    expect(api.deleteFile).not.toHaveBeenCalled();
    const remaining = await db.structureOps.orderBy('queuedAt').toArray();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].op).toBe('delete-chapter');
    expect(remaining[0].stuckAt).toBeUndefined();
    expect(remaining[0].attempts).toBe(1);
    expect(remaining[0].lastError).toContain('Failed to fetch');

    const snap = syncEngine.getSnapshot();
    expect(snap.stuckOpsCount).toBe(0);
    expect(snap.status).toBe('syncing');
  });

  it('R3: a 503 during replay is transient — the op keeps its place instead of parking', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 0,
    } as StructureOp);
    await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 2, attempts: 0,
    } as StructureOp);

    vi.mocked(api.deleteChapter).mockRejectedValueOnce(
      new HttpError(503, 'Service Unavailable', 'proxy restarting'),
    );

    await syncEngine.flush();

    expect(api.deleteFile).not.toHaveBeenCalled();
    const remaining = await db.structureOps.orderBy('queuedAt').toArray();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].stuckAt).toBeUndefined();
    expect(remaining[0].attempts).toBe(1);
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(0);
  });

  it('R3: a 404 during replay is permanent — the op parks', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 0,
    } as StructureOp);

    vi.mocked(api.deleteChapter).mockRejectedValueOnce(
      new HttpError(404, 'Not Found', 'no such chapter'),
    );
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.flush();

    const remaining = await db.structureOps.toArray();
    expect(remaining[0].stuckAt).toBeDefined();
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(1);
  });

  it('R10: retryStuck unparks every stuck item for the project, not just one', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 2, lastError: '404', stuckAt: Date.now(),
    } as StructureOp);
    await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 2, attempts: 1, lastError: '404',
      stuckAt: Date.now(),
    } as StructureOp);
    await db.pending.add({
      slug: 'proj', path: 'chapters/01_Chapter_01/01.md', body: 'b', frontmatter: {},
      baseEtag: 'e1', queuedAt: 3, attempts: 1, lastError: '412', stuckAt: Date.now(),
    });
    await syncEngine.refreshCounts();
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(2);
    expect(syncEngine.getSnapshot().stuckPendingCount).toBe(1);

    vi.mocked(api.deleteChapter).mockResolvedValueOnce(undefined);
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.putFile).mockResolvedValueOnce({
      path: 'chapters/01_Chapter_01/01.md', body: 'b', frontmatter: {},
      etag: 'e2', word_count: 1,
    });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await syncEngine.retryStuck('proj');

    expect(await db.structureOps.count()).toBe(0);
    expect(await db.pending.count()).toBe(0);
    const snap = syncEngine.getSnapshot();
    expect(snap.stuckOpsCount).toBe(0);
    expect(snap.stuckPendingCount).toBe(0);
    expect(snap.status).toBe('idle');
  });

  it('T5: clearing stuckAt lets a parked op replay on the next flush, and discarding it removes it outright', async () => {
    const api = await import('../api');
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });

    const stuckId = await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 2, lastError: '409 Conflict', stuckAt: Date.now(),
    } as StructureOp);
    const discardId = await db.structureOps.add({
      slug: 'proj', op: 'delete-scene', payload: { path: 'chapters/01_Chapter_01/09.md' },
      tempId: 'chapters/01_Chapter_01/09.md', queuedAt: 2, attempts: 1, lastError: 'boom', stuckAt: Date.now(),
    } as StructureOp);
    await syncEngine.refreshCounts();
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(2);

    // Retry: clears stuckAt/attempts/lastError, then flush replays it.
    await db.structureOps.update(stuckId, { stuckAt: undefined, attempts: 0, lastError: undefined });
    vi.mocked(api.deleteChapter).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);
    await syncEngine.flush();
    expect(await db.structureOps.get(stuckId)).toBeUndefined();
    expect(api.deleteChapter).toHaveBeenCalledWith('proj', 'ghost');

    // Discard: removed outright, never replayed.
    await db.structureOps.delete(discardId);
    await syncEngine.refreshCounts();
    expect(await db.structureOps.get(discardId)).toBeUndefined();
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(0);
    expect(syncEngine.getSnapshot().status).toBe('idle');
  });

  it('T5: an all-stuck queue never flips status to syncing across a flush', async () => {
    await db.structureOps.add({
      slug: 'proj', op: 'delete-chapter', payload: { chapterSlug: 'ghost' },
      tempId: 'ghost', queuedAt: 1, attempts: 2, lastError: '409 Conflict', stuckAt: Date.now(),
    } as StructureOp);
    await syncEngine.refreshCounts();
    expect(syncEngine.getSnapshot().status).toBe('idle');

    const seenStatuses: string[] = [];
    const unsubscribe = syncEngine.subscribe(snap => seenStatuses.push(snap.status));

    await syncEngine.flush();

    unsubscribe();
    expect(seenStatuses).not.toContain('syncing');
    expect(syncEngine.getSnapshot().status).toBe('idle');
  });
});

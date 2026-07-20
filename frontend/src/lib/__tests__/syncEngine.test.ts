import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, fileKey } from '../db';

// Stub navigator.onLine (globalThis.navigator may not exist in all Node versions)
if (typeof globalThis.navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
}
Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

// Mock the API module before any syncEngine import
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
    reorder: vi.fn(),
    moveScene: vi.fn(),
    isNetworkError: actual.isNetworkError,
  };
});

vi.mock('../words', () => ({
  countWords: (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0),
}));

import { syncEngine } from '../syncEngine';

async function clearAllTables() {
  await db.cache.clear();
  await db.pending.clear();
  await db.conflicts.clear();
  await db.kv.clear();
  await db.trees.clear();
  await db.structureOps.clear();
}

describe('syncEngine flush logic', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('saveFile writes to IDB cache and pending queue', async () => {
    await syncEngine.saveFile(
      'test-project',
      'chapters/01/01.md',
      'Hello world',
      { scene: 1 },
      'etag-from-caller',
    );

    const cached = await db.cache.get(fileKey('test-project', 'chapters/01/01.md'));
    expect(cached).toBeDefined();
    expect(cached!.body).toBe('Hello world');
    expect(cached!.frontmatter).toEqual({ scene: 1 });
    expect(cached!.serverEtag).toBe('etag-from-caller');

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0].slug).toBe('test-project');
    expect(pending[0].path).toBe('chapters/01/01.md');
    expect(pending[0].body).toBe('Hello world');
    expect(pending[0].baseEtag).toBe('etag-from-caller');
  });

  it('cache serverEtag is authoritative over caller etag', async () => {
    // Pre-seed cache with a known serverEtag
    await db.cache.put({
      key: fileKey('proj', 'chapters/01/01.md'),
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'old body',
      frontmatter: {},
      serverEtag: 'server-etag-v2',
      cachedAt: Date.now(),
    });

    // saveFile passes a stale caller etag — cache's serverEtag should win
    await syncEngine.saveFile(
      'proj',
      'chapters/01/01.md',
      'new body',
      { scene: 1 },
      'stale-caller-etag',
    );

    const cached = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(cached!.serverEtag).toBe('server-etag-v2');
    expect(cached!.body).toBe('new body');

    const pending = await db.pending.toArray();
    expect(pending[0].baseEtag).toBe('server-etag-v2');
  });

  it('pending writes are coalesced per (slug, path)', async () => {
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v1', {}, 'e1');
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v2', {}, 'e1');
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v3', {}, 'e1');

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('v3');
  });

  it('different paths get separate pending entries', async () => {
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'scene 1', {}, 'e1');
    await syncEngine.saveFile('proj', 'chapters/01/02.md', 'scene 2', {}, 'e2');

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(2);
  });

  it('flush sends pending writes via API and updates cache from response', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    await db.cache.put({
      key: fileKey('proj', 'chapters/01/01.md'),
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'pending body',
      frontmatter: { scene: 1 },
      serverEtag: 'etag-v1',
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'pending body',
      frontmatter: { scene: 1 },
      baseEtag: 'etag-v1',
      queuedAt: Date.now(),
      attempts: 0,
    });

    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'pending body',
      frontmatter: { scene: 1 },
      etag: 'etag-v2-from-server',
      word_count: 2,
    });

    await syncEngine.flush();

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(0);

    const cached = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(cached!.serverEtag).toBe('etag-v2-from-server');

    expect(putFileMock).toHaveBeenCalledOnce();
    const [slug, path, payload, etag, opts] = putFileMock.mock.calls[0];
    expect(slug).toBe('proj');
    expect(path).toBe('chapters/01/01.md');
    expect(payload.body).toBe('pending body');
    expect(etag).toBe('etag-v1');
    expect(opts?.onConflict).toBe('save-as-conflict');
  });

  it('flush records conflict when server returns conflict', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'conflicting body',
      frontmatter: {},
      baseEtag: 'stale-etag',
      queuedAt: Date.now(),
      attempts: 0,
    });

    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'conflicting body',
      frontmatter: {},
      etag: 'server-current-etag',
      word_count: 2,
      conflict: true,
      conflict_path: 'chapters/01/01.conflict.dev-abc.20250101T000000Z.md',
    });

    await syncEngine.flush();

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].canonicalPath).toBe('chapters/01/01.md');
    expect(conflicts[0].deviceId).toBe('dev-abc');
    expect(conflicts[0].timestamp).toBe('20250101T000000Z');
  });

  it('flush stops on first API error and increments attempt count', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'will fail',
      frontmatter: {},
      baseEtag: 'e1',
      queuedAt: 1,
      attempts: 0,
    });
    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/02.md',
      body: 'should not be attempted',
      frontmatter: {},
      baseEtag: 'e2',
      queuedAt: 2,
      attempts: 0,
    });

    putFileMock.mockRejectedValueOnce(new Error('Network error'));

    await syncEngine.flush();

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(2);
    const first = pending.find(p => p.path === 'chapters/01/01.md')!;
    expect(first.attempts).toBe(1);
    expect(first.lastError).toContain('Network error');
    const second = pending.find(p => p.path === 'chapters/01/02.md')!;
    expect(second.attempts).toBe(0);
  });

  it('flush updates snapshot with lastFlushAt', async () => {
    const api = await import('../api');
    vi.mocked(api.putFile);

    // No pending items — flush should still complete and set lastFlushAt
    await syncEngine.flush();

    const snap = syncEngine.getSnapshot();
    expect(snap.lastFlushAt).toBeTypeOf('number');
  });

  it('flush with empty queues does not refresh cached trees', async () => {
    const api = await import('../api');
    const getProjectMock = vi.mocked(api.getProject);

    await db.trees.put({
      slug: 'proj',
      tree: {
        slug: 'proj', title: 'Proj', author: null, rag_recipe: null,
        default_model: 'x', acts: [], chapters: [], categories: [],
      },
      cachedAt: Date.now(),
    });

    await syncEngine.flush();

    expect(getProjectMock).not.toHaveBeenCalled();
  });

  it('flush that drains one pending write refreshes cached trees', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);
    const getProjectMock = vi.mocked(api.getProject);

    await db.trees.put({
      slug: 'proj',
      tree: {
        slug: 'proj', title: 'Proj', author: null, rag_recipe: null,
        default_model: 'x', acts: [], chapters: [], categories: [],
      },
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'body',
      frontmatter: {},
      baseEtag: 'e1',
      queuedAt: Date.now(),
      attempts: 0,
    });
    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'body',
      frontmatter: {},
      etag: 'e2',
      word_count: 1,
    });
    getProjectMock.mockResolvedValueOnce({
      slug: 'proj', title: 'Proj', author: null, rag_recipe: null,
      default_model: 'x', acts: [], chapters: [], categories: [],
    });

    await syncEngine.flush();

    expect(getProjectMock).toHaveBeenCalledWith('proj');
  });

  it('keepaliveTrees refreshes cached trees independent of flush work', async () => {
    const api = await import('../api');
    const getProjectMock = vi.mocked(api.getProject);

    await db.trees.put({
      slug: 'proj',
      tree: {
        slug: 'proj', title: 'Proj', author: null, rag_recipe: null,
        default_model: 'x', acts: [], chapters: [], categories: [],
      },
      cachedAt: Date.now(),
    });
    getProjectMock.mockResolvedValueOnce({
      slug: 'proj', title: 'Proj Updated', author: null, rag_recipe: null,
      default_model: 'x', acts: [], chapters: [], categories: [],
    });

    await (syncEngine as unknown as { keepaliveTrees(): Promise<void> }).keepaliveTrees();

    expect(getProjectMock).toHaveBeenCalledWith('proj');
    const updated = await db.trees.get('proj');
    expect(updated!.tree.title).toBe('Proj Updated');
  });

  it('keepaliveTrees skips the poll when offline', async () => {
    const api = await import('../api');
    const getProjectMock = vi.mocked(api.getProject);
    (navigator as { onLine: boolean }).onLine = false;

    await db.trees.put({
      slug: 'proj',
      tree: {
        slug: 'proj', title: 'Proj', author: null, rag_recipe: null,
        default_model: 'x', acts: [], chapters: [], categories: [],
      },
      cachedAt: Date.now(),
    });

    await (syncEngine as unknown as { keepaliveTrees(): Promise<void> }).keepaliveTrees();

    expect(getProjectMock).not.toHaveBeenCalled();
  });

  it('snapshot reflects pending count correctly', async () => {
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'body', {}, 'e1');

    const snap = syncEngine.getSnapshot();
    expect(snap.pendingCount).toBe(1);
  });

  it('a PlanBoard-style status write followed by an editor-style save does not produce a conflict', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'scene body',
      frontmatter: { status: 'final' },
      etag: 'etag-after-status-write',
      word_count: 2,
    });

    // saveFile triggers its own fire-and-forget flush; wait for the queue to drain
    // rather than calling flush() again (it no-ops while one is already in flight).
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'scene body', { status: 'final' }, 'etag-v1');
    await vi.waitFor(async () => {
      expect(await db.pending.count()).toBe(0);
    });

    const cached = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(cached!.serverEtag).toBe('etag-after-status-write');

    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'edited body',
      frontmatter: { status: 'final' },
      etag: 'etag-after-editor-write',
      word_count: 2,
    });

    // Editor loaded the file before the status write flushed, so it still holds the old etag.
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'edited body', { status: 'final' }, 'etag-v1');
    await vi.waitFor(async () => {
      expect(await db.pending.count()).toBe(0);
    });

    expect(putFileMock).toHaveBeenLastCalledWith(
      'proj',
      'chapters/01/01.md',
      { body: 'edited body', frontmatter: { status: 'final' } },
      'etag-after-status-write',
      expect.objectContaining({ onConflict: 'save-as-conflict' }),
    );
  });

  it('getFile refresh does not absorb a foreign etag while a write is pending', async () => {
    const api = await import('../api');
    const getFileMock = vi.mocked(api.getFile);
    const putFileMock = vi.mocked(api.putFile);

    // saveFile fires its own background flush; make that attempt fail deterministically
    // so the write stays queued at E1 instead of racing our explicit flush() below.
    putFileMock.mockRejectedValueOnce(new Error('network blip'));

    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'device A body', {}, 'E1');
    await vi.waitFor(async () => {
      const pending = await db.pending.toArray();
      expect(pending).toHaveLength(1);
      expect(pending[0].attempts).toBeGreaterThan(0);
    });

    // Meanwhile device B has already flushed and moved the server to E2.
    getFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'device B body',
      frontmatter: {},
      etag: 'E2',
      word_count: 2,
    });

    await syncEngine.getFile('proj', 'chapters/01/01.md');
    // Background refresh promise resolves on a microtask after getFile returns.
    await vi.waitFor(async () => {
      expect(getFileMock).toHaveBeenCalled();
    });

    const cached = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(cached!.serverEtag).toBe('E1');

    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md',
      body: 'device A body',
      frontmatter: {},
      etag: 'E3',
      word_count: 2,
      conflict: true,
      conflict_path: 'chapters/01/01.conflict.dev-a.20250101T000000Z.md',
    });

    await syncEngine.flush();

    expect(putFileMock).toHaveBeenCalledWith(
      'proj',
      'chapters/01/01.md',
      expect.objectContaining({ body: 'device A body' }),
      'E1',
      expect.objectContaining({ onConflict: 'save-as-conflict' }),
    );

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
  });
});

describe('syncEngine network-error detection', () => {
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

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
    await db.trees.put({ slug: 'proj', tree: emptyTree, cachedAt: Date.now() });
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('offline create with a rejecting TypeError queues a structure op', async () => {
    const api = await import('../api');
    vi.mocked(api.newChapter).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await syncEngine.createChapter('proj', { title: 'Offline Chapter' });

    expect(result.slug).toContain('_offline_');
    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('new-chapter');
  });

  it('an HTTP 409-shaped Error (message containing "fetch") is re-thrown, not queued', async () => {
    const api = await import('../api');
    vi.mocked(api.newChapter).mockRejectedValueOnce(
      new Error('409 Conflict: could not fetch lock'),
    );

    await expect(
      syncEngine.createChapter('proj', { title: 'Conflicted Chapter' }),
    ).rejects.toThrow('409 Conflict');

    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(0);
  });

  it('replays an offline chapter with extra scenes to three distinct server paths', async () => {
    const api = await import('../api');
    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newChapter).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(api.putFile).mockRejectedValue(new TypeError('Failed to fetch'));

    const chapter = await syncEngine.createChapter('proj', { title: 'Offline Chapter' });
    const scene2 = await syncEngine.createScene('proj', chapter.slug, {});
    const scene3 = await syncEngine.createScene('proj', chapter.slug, {});

    await syncEngine.saveFile('proj', chapter.first_scene_path, 'Body one', {}, 'offline');
    await syncEngine.saveFile('proj', scene2.path, 'Body two', {}, 'offline');
    await syncEngine.saveFile('proj', scene3.path, 'Body three', {}, 'offline');

    (navigator as { onLine: boolean }).onLine = true;
    const putFileMock = vi.mocked(api.putFile);
    putFileMock.mockReset();
    putFileMock.mockImplementation(async (_slug, path, payload) => ({
      path,
      body: payload.body,
      frontmatter: payload.frontmatter,
      etag: `etag-${path}`,
      word_count: 1,
    }));
    vi.mocked(api.newChapter).mockReset();
    vi.mocked(api.newChapter).mockResolvedValueOnce({
      slug: '05_Chapter_03',
      path: 'chapters/05_Chapter_03',
      meta_path: 'chapters/05_Chapter_03/chapter.md',
      first_scene_path: 'chapters/05_Chapter_03/01.md',
      kind: 'chapter',
      chapter: 3,
      interlude: null,
      position: 5,
    });
    vi.mocked(api.newScene).mockReset();
    vi.mocked(api.newScene)
      .mockResolvedValueOnce({ scene: 2, path: 'chapters/05_Chapter_03/02.md' })
      .mockResolvedValueOnce({ scene: 3, path: 'chapters/05_Chapter_03/03.md' });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    // saveFile fires a background flush; retry until both queues drain.
    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
      expect(await db.pending.count()).toBe(0);
    });

    expect(putFileMock).toHaveBeenCalledTimes(3);
    const calls = putFileMock.mock.calls.map(([, path, payload]) => ({ path, body: payload.body }));
    expect(new Set(calls.map(c => c.path)).size).toBe(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        { path: 'chapters/05_Chapter_03/01.md', body: 'Body one' },
        { path: 'chapters/05_Chapter_03/02.md', body: 'Body two' },
        { path: 'chapters/05_Chapter_03/03.md', body: 'Body three' },
      ]),
    );

    const cached = await db.cache.where('slug').equals('proj').toArray();
    expect(cached.some(c => c.path.includes('_offline_') || c.key.includes('_offline_'))).toBe(false);
  });

  it('remaps a queued reorder op\'s temp chapter path after reconnect', async () => {
    const api = await import('../api');
    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newChapter).mockRejectedValue(new TypeError('Failed to fetch'));

    const chapter = await syncEngine.createChapter('proj', { title: 'Offline Chapter' });
    await syncEngine.reorderItems('proj', [{ path: chapter.meta_path, order: 5 }]);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newChapter).mockReset();
    vi.mocked(api.newChapter).mockResolvedValueOnce({
      slug: '05_Chapter_03',
      path: 'chapters/05_Chapter_03',
      meta_path: 'chapters/05_Chapter_03/chapter.md',
      first_scene_path: 'chapters/05_Chapter_03/01.md',
      kind: 'chapter',
      chapter: 3,
      interlude: null,
      position: 5,
    });
    const reorderMock = vi.mocked(api.reorder);
    reorderMock.mockResolvedValueOnce({ updated: ['chapters/05_Chapter_03/chapter.md'], count: 1 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(reorderMock).toHaveBeenCalledWith('proj', [
      { path: 'chapters/05_Chapter_03/chapter.md', order: 5 },
    ]);
  });

  it('remaps a queued move-scene op targeting an offline chapter after reconnect', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [{
        path: 'chapters/01_Chapter_01',
        meta_path: 'chapters/01_Chapter_01/chapter.md',
        slug: '01_Chapter_01',
        kind: 'chapter' as const,
        title: 'Real Chapter',
        summary: null,
        chapter: 1,
        interlude: null,
        order: 1,
        pov: null,
        status: null,
        words_target: null,
        act: null,
        word_count: 0,
        scenes: [
          {
            path: 'chapters/01_Chapter_01/01.md', title: null, summary: null,
            scene: 1, order: 1, pov: null, status: null, words_target: null, word_count: 0,
          },
        ],
      }],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newChapter).mockRejectedValue(new TypeError('Failed to fetch'));

    const chapter = await syncEngine.createChapter('proj', { title: 'Offline Chapter' });

    await syncEngine.moveScene('proj', {
      srcPath: 'chapters/01_Chapter_01/01.md',
      dstChapterSlug: chapter.slug,
      srcOrder: [],
      dstOrder: [
        { path: chapter.first_scene_path, order: 1 },
        { path: 'chapters/01_Chapter_01/01.md', order: 2 },
      ],
    });

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newChapter).mockReset();
    vi.mocked(api.newChapter).mockResolvedValueOnce({
      slug: '05_Chapter_03',
      path: 'chapters/05_Chapter_03',
      meta_path: 'chapters/05_Chapter_03/chapter.md',
      first_scene_path: 'chapters/05_Chapter_03/01.md',
      kind: 'chapter',
      chapter: 3,
      interlude: null,
      position: 5,
    });
    const moveSceneMock = vi.mocked(api.moveScene);
    moveSceneMock.mockResolvedValueOnce({ new_path: 'chapters/05_Chapter_03/02.md', scene: 2 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(moveSceneMock).toHaveBeenCalledWith('proj', {
      src_path: 'chapters/01_Chapter_01/01.md',
      dst_chapter_slug: '05_Chapter_03',
      src_order: [],
      dst_order: [
        { path: 'chapters/05_Chapter_03/01.md', order: 1 },
        { path: 'chapters/01_Chapter_01/01.md', order: 2 },
      ],
    });

    const cached = await db.cache.where('slug').equals('proj').toArray();
    expect(cached.some(c => c.path.includes('_offline_') || c.key.includes('_offline_'))).toBe(false);
  });

  it('remaps a queued reorder op\'s temp scene path after new-scene flush', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [{
        path: 'chapters/01_Chapter_01',
        meta_path: 'chapters/01_Chapter_01/chapter.md',
        slug: '01_Chapter_01',
        kind: 'chapter' as const,
        title: 'Real Chapter',
        summary: null,
        chapter: 1,
        interlude: null,
        order: 1,
        pov: null,
        status: null,
        words_target: null,
        act: null,
        word_count: 0,
        scenes: [
          {
            path: 'chapters/01_Chapter_01/01.md', title: null, summary: null,
            scene: 1, order: 1, pov: null, status: null, words_target: null, word_count: 0,
          },
        ],
      }],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});

    await syncEngine.reorderItems('proj', [
      { path: 'chapters/01_Chapter_01/01.md', order: 2 },
      { path: scene.path, order: 1 },
    ]);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newScene).mockReset();
    vi.mocked(api.newScene).mockResolvedValueOnce({ scene: 2, path: 'chapters/01_Chapter_01/02.md' });
    const reorderMock = vi.mocked(api.reorder);
    reorderMock.mockResolvedValueOnce({ updated: [], count: 2 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(reorderMock).toHaveBeenCalledWith('proj', [
      { path: 'chapters/01_Chapter_01/01.md', order: 2 },
      { path: 'chapters/01_Chapter_01/02.md', order: 1 },
    ]);
  });

  it('queues a move-scene op when moving an offline chapter\'s auto first scene', async () => {
    const api = await import('../api');
    const treeWithChapter = {
      ...emptyTree,
      chapters: [{
        path: 'chapters/01_Chapter_01',
        meta_path: 'chapters/01_Chapter_01/chapter.md',
        slug: '01_Chapter_01',
        kind: 'chapter' as const,
        title: 'Real Chapter',
        summary: null,
        chapter: 1,
        interlude: null,
        order: 1,
        pov: null,
        status: null,
        words_target: null,
        act: null,
        word_count: 0,
        scenes: [
          {
            path: 'chapters/01_Chapter_01/01.md', title: null, summary: null,
            scene: 1, order: 1, pov: null, status: null, words_target: null, word_count: 0,
          },
        ],
      }],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapter, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newChapter).mockRejectedValue(new TypeError('Failed to fetch'));

    const chapter = await syncEngine.createChapter('proj', { title: 'Offline Chapter' });

    await syncEngine.moveScene('proj', {
      srcPath: chapter.first_scene_path,
      dstChapterSlug: '01_Chapter_01',
      srcOrder: [],
      dstOrder: [
        { path: 'chapters/01_Chapter_01/01.md', order: 1 },
        { path: chapter.first_scene_path, order: 2 },
      ],
    });

    const opsBeforeFlush = await db.structureOps.toArray();
    expect(opsBeforeFlush.some(o => o.op === 'move-scene')).toBe(true);

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newChapter).mockReset();
    vi.mocked(api.newChapter).mockResolvedValueOnce({
      slug: '05_Chapter_03',
      path: 'chapters/05_Chapter_03',
      meta_path: 'chapters/05_Chapter_03/chapter.md',
      first_scene_path: 'chapters/05_Chapter_03/01.md',
      kind: 'chapter',
      chapter: 3,
      interlude: null,
      position: 5,
    });
    const moveSceneMock = vi.mocked(api.moveScene);
    moveSceneMock.mockResolvedValueOnce({ new_path: 'chapters/01_Chapter_01/02.md', scene: 2 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    expect(moveSceneMock).toHaveBeenCalledWith('proj', {
      src_path: 'chapters/05_Chapter_03/01.md',
      dst_chapter_slug: '01_Chapter_01',
      src_order: [],
      dst_order: [
        { path: 'chapters/01_Chapter_01/01.md', order: 1 },
        { path: 'chapters/05_Chapter_03/01.md', order: 2 },
      ],
    });

    const cached = await db.cache.where('slug').equals('proj').toArray();
    expect(cached.some(c => c.path.includes('_offline_') || c.key.includes('_offline_'))).toBe(false);
  });
});

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
      body: 'canonical server body',
      frontmatter: { title: 'canonical' },
      etag: 'server-current-etag',
      word_count: 3,
      conflict: true,
      conflict_path: 'chapters/01/01.conflict.dev-abc.20250101T000000Z.md',
    });

    await syncEngine.flush();

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].canonicalPath).toBe('chapters/01/01.md');
    expect(conflicts[0].deviceId).toBe('dev-abc');
    expect(conflicts[0].timestamp).toBe('20250101T000000Z');

    // Cache should hold the canonical body, not the submitted body
    const cached = await db.cache.get('proj::chapters/01/01.md');
    expect(cached?.body).toBe('canonical server body');
    expect(cached?.serverEtag).toBe('server-current-etag');
  });

  it('saveFile skips pending write when file has active conflict', async () => {
    await db.conflicts.put({
      key: 'proj::chapters/01/01.conflict.dev-x.20250101T000000Z.md',
      slug: 'proj',
      path: 'chapters/01/01.conflict.dev-x.20250101T000000Z.md',
      canonicalPath: 'chapters/01/01.md',
      deviceId: 'dev-x',
      timestamp: '20250101T000000Z',
      noticedAt: Date.now(),
    });

    const result = await syncEngine.saveFile('proj', 'chapters/01/01.md', 'new edit', {}, 'some-etag');

    expect(result).toBe('blocked');
    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(0);
    const cached = await db.cache.get('proj::chapters/01/01.md');
    expect(cached).toBeUndefined();
  });

  it('flush stops on the first transient error and increments attempt count', async () => {
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

    putFileMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await syncEngine.flush();

    const pending = await db.pending.toArray();
    expect(pending).toHaveLength(2);
    const first = pending.find(p => p.path === 'chapters/01/01.md')!;
    expect(first.attempts).toBe(1);
    expect(first.lastError).toContain('Failed to fetch');
    expect(first.stuckAt).toBeUndefined();
    const second = pending.find(p => p.path === 'chapters/01/02.md')!;
    expect(second.attempts).toBe(0);
    expect(syncEngine.getSnapshot().stuckPendingCount).toBe(0);
  });

  it('a 5xx PUT is transient: the write stays queued rather than parked', async () => {
    const api = await import('../api');
    vi.mocked(api.putFile).mockRejectedValueOnce(
      new HttpError(503, 'Service Unavailable', 'upstream down'),
    );

    await db.pending.add({
      slug: 'proj', path: 'chapters/01/01.md', body: 'b', frontmatter: {},
      baseEtag: 'e1', queuedAt: 1, attempts: 0,
    });

    await syncEngine.flush();

    const row = (await db.pending.toArray())[0];
    expect(row.stuckAt).toBeUndefined();
    expect(row.attempts).toBe(1);
  });

  it('a permanent PUT failure parks the write, later writes still flush, status settles', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    await db.pending.add({
      slug: 'proj', path: 'chapters/01/01.md', body: 'doomed', frontmatter: {},
      baseEtag: 'e1', queuedAt: 1, attempts: 0,
    });
    await db.pending.add({
      slug: 'proj', path: 'chapters/01/02.md', body: 'fine', frontmatter: {},
      baseEtag: 'e2', queuedAt: 2, attempts: 0,
    });

    putFileMock.mockRejectedValueOnce(new HttpError(412, 'Precondition Failed', 'gone'));
    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/02.md', body: 'fine', frontmatter: {}, etag: 'e3', word_count: 1,
    });

    await syncEngine.flush();

    const rows = await db.pending.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('chapters/01/01.md');
    expect(rows[0].stuckAt).toBeDefined();
    expect(rows[0].lastError).toContain('412');

    const snap = syncEngine.getSnapshot();
    expect(snap.stuckPendingCount).toBe(1);
    expect(snap.status).toBe('idle');

    // Retry-all unparks the write and re-attempts it; a fixed server accepts it.
    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md', body: 'doomed', frontmatter: {}, etag: 'e4', word_count: 1,
    });
    await syncEngine.retryStuck('proj');

    expect(await db.pending.count()).toBe(0);
    expect(syncEngine.getSnapshot().stuckPendingCount).toBe(0);
    expect(syncEngine.getSnapshot().status).toBe('idle');
  });

  it('a save landing mid-PUT is not parked by that PUT failing permanently', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    let rejectPut!: (e: unknown) => void;
    putFileMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectPut = reject; }) as never,
    );

    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'first body', {}, 'E1');
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(1));

    // Fresh keystrokes land while the doomed PUT is still in flight.
    putFileMock.mockResolvedValueOnce({
      path: 'chapters/01/01.md', body: 'fresh keystrokes', frontmatter: {},
      etag: 'E2', word_count: 2,
    });
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'fresh keystrokes', {}, 'E1');

    rejectPut(new HttpError(422, 'Unprocessable', 'bad request'));
    await vi.waitFor(async () => expect(await db.pending.count()).toBe(0));

    // The newer body was attempted rather than parked behind the failed one.
    expect(putFileMock.mock.calls[1][2].body).toBe('fresh keystrokes');
    expect(syncEngine.getSnapshot().stuckPendingCount).toBe(0);
  });

  it('re-saving a parked write unparks it', async () => {
    const api = await import('../api');
    vi.mocked(api.putFile).mockRejectedValueOnce(
      new HttpError(422, 'Unprocessable', 'bad path'),
    );

    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v1', {}, 'E1');
    await vi.waitFor(async () => {
      expect((await db.pending.toArray())[0].stuckAt).toBeDefined();
    });

    vi.mocked(api.putFile).mockResolvedValueOnce({
      path: 'chapters/01/01.md', body: 'v2', frontmatter: {}, etag: 'E2', word_count: 1,
    });
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v2', {}, 'E1');
    await syncEngine.flush();

    expect(await db.pending.count()).toBe(0);
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

  it('R6: a 404 from getFile while online does not flip the status to offline', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockRejectedValueOnce(
      new HttpError(404, 'Not Found', 'File not found'),
    );

    await expect(syncEngine.getFile('proj', 'chapters/01/99.md')).rejects.toThrow();

    const snap = syncEngine.getSnapshot();
    expect(snap.status).not.toBe('offline');
    expect(snap.lastError).toContain('404');
  });

  it('R6: a network failure from getFile does flip the status to offline', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(syncEngine.getFile('proj', 'chapters/01/99.md')).rejects.toThrow();

    expect(syncEngine.getSnapshot().status).toBe('offline');
  });

  it('getFile refresh does not absorb a foreign etag while a write is pending', async () => {
    const api = await import('../api');
    const getFileMock = vi.mocked(api.getFile);
    const putFileMock = vi.mocked(api.putFile);

    // saveFile fires its own background flush; make that attempt fail deterministically
    // so the write stays queued at E1 instead of racing our explicit flush() below.
    putFileMock.mockRejectedValueOnce(new TypeError('network blip'));

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

  it('getFile background refresh does not resurrect a row deleted mid-flight', async () => {
    const api = await import('../api');
    const getFileMock = vi.mocked(api.getFile);

    await db.cache.put({
      key: fileKey('proj', 'chapters/01/01.md'),
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'v1',
      frontmatter: {},
      serverEtag: 'E1',
      cachedAt: Date.now(),
    });

    let resolveFetch!: (v: Awaited<ReturnType<typeof api.getFile>>) => void;
    getFileMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve; }) as never,
    );

    await syncEngine.getFile('proj', 'chapters/01/01.md');

    // The row is deleted (e.g. the scene was removed) while the background GET is still in flight.
    await db.cache.delete(fileKey('proj', 'chapters/01/01.md'));

    resolveFetch({
      path: 'chapters/01/01.md',
      body: 'stale server body',
      frontmatter: {},
      etag: 'E1',
      word_count: 2,
    });
    // getFileMock was already called before resolveFetch, so a waitFor on that
    // condition resolves on its first (synchronous) check without waiting at all -
    // the background .then chain (pending check -> cache re-read -> guarded put)
    // hasn't necessarily run yet. Flush real ticks so it settles before asserting.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const cached = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(cached).toBeUndefined();
  });

  it('flush does not clobber a pending row refreshed mid-PUT (F1 race)', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    await db.cache.put({
      key: fileKey('proj', 'chapters/01/01.md'),
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'v1',
      frontmatter: {},
      serverEtag: 'E1',
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'v1',
      frontmatter: {},
      baseEtag: 'E1',
      queuedAt: 1,
      attempts: 0,
    });

    // Stateful server model: the mock emulates the backend's If-Match check. A PUT whose
    // baseEtag doesn't match the etag the server currently holds is rejected as a conflict
    // (exactly what happens if the retry still carries the pre-write etag). Resolution timing
    // stays under test control via the `releases` gate so a save can land mid-PUT.
    let serverEtag = 'E1';
    let nextEtagNum = 2;
    const releases: Array<() => void> = [];
    putFileMock.mockImplementation(
      (_slug, path, payload, baseEtag) =>
        new Promise((resolve) => {
          releases.push(() => {
            if (baseEtag !== serverEtag) {
              resolve({
                path,
                body: payload.body,
                frontmatter: payload.frontmatter,
                etag: serverEtag,
                word_count: 1,
                conflict: true,
                conflict_path: 'chapters/01/01.conflict.dev-a.20250101T000000Z.md',
              });
              return;
            }
            serverEtag = `E${nextEtagNum++}`;
            resolve({
              path,
              body: payload.body,
              frontmatter: payload.frontmatter,
              etag: serverEtag,
              word_count: 1,
            });
          });
        }) as never,
    );

    const flushPromise = syncEngine.flush();
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(1));

    // A newer save lands while the first PUT is still in flight.
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'v2', {}, 'E1');

    // First PUT resolves: baseEtag E1 matched, server advances to E2, returns the v1 body.
    releases[0]();

    // The loop must re-queue the newer row instead of deleting it → a second PUT fires.
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(2));

    // Newer body still queued; cache stamped with the fresh server etag (E2) but keeps v2.
    const midPending = await db.pending.toArray();
    expect(midPending).toHaveLength(1);
    expect(midPending[0].body).toBe('v2');
    expect(midPending[0].baseEtag).toBe('E2');
    const midCache = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(midCache!.serverEtag).toBe('E2');
    expect(midCache!.body).toBe('v2');

    // Second PUT carries the newer body AND the refreshed etag, so the server accepts it
    // rather than rejecting the stale If-Match into a spurious conflict.
    const [, , payload2, baseEtag2] = putFileMock.mock.calls[1];
    expect(payload2.body).toBe('v2');
    expect(baseEtag2).toBe('E2');

    // Follow-up delivery drains the queue and stamps the fresh server etag.
    releases[1]();
    await flushPromise;

    expect(await db.pending.count()).toBe(0);
    const finalCache = await db.cache.get(fileKey('proj', 'chapters/01/01.md'));
    expect(finalCache!.serverEtag).toBe('E3');
    expect(finalCache!.body).toBe('v2');

    // The whole point: a clean second delivery, no conflict file recorded.
    expect(await db.conflicts.count()).toBe(0);
  });

  it('flush does not resurrect the old path when a rekey moves a pending row mid-PUT', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);
    const oldPath = 'chapters/01_Chapter_01/02.md';
    const newPath = 'chapters/02_Chapter_02/01.md';

    await db.cache.put({
      key: fileKey('proj', oldPath),
      slug: 'proj',
      path: oldPath,
      body: 'v1',
      frontmatter: {},
      serverEtag: 'E1',
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path: oldPath,
      body: 'v1',
      frontmatter: {},
      baseEtag: 'E1',
      queuedAt: 1,
      attempts: 0,
    });

    const releases: Array<() => void> = [];
    putFileMock.mockImplementation(
      (_slug, path, payload) =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve({
              path,
              body: payload.body,
              frontmatter: payload.frontmatter,
              etag: 'E2',
              word_count: 1,
            }),
          );
        }) as never,
    );

    const flushPromise = syncEngine.flush();
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(1));
    expect(putFileMock.mock.calls[0][1]).toBe(oldPath);

    // An online moveScene lands while the PUT to the old path is still in flight.
    await syncEngine.rekeyLocalPath('proj', oldPath, newPath);

    // The in-flight PUT recreated the file at the old path server-side (the save-as-conflict
    // missing-file carve-out), so it resolves cleanly — the row must survive anyway.
    releases[0]();
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(2));

    const midPending = await db.pending.toArray();
    expect(midPending).toHaveLength(1);
    expect(midPending[0].path).toBe(newPath);
    expect(midPending[0].body).toBe('v1');
    expect(await db.cache.get(fileKey('proj', oldPath))).toBeUndefined();

    // The retry goes to the remapped path, and only that delivery drains the queue.
    expect(putFileMock.mock.calls[1][1]).toBe(newPath);
    releases[1]();
    await flushPromise;

    expect(await db.pending.count()).toBe(0);
    expect(await db.cache.get(fileKey('proj', oldPath))).toBeUndefined();
    const finalCache = await db.cache.get(fileKey('proj', newPath));
    expect(finalCache!.body).toBe('v1');
    expect(finalCache!.serverEtag).toBe('E2');
  });

  it('an explicit flush() awaited after saveFile joins the in-flight run instead of resolving early (F6 race)', async () => {
    const api = await import('../api');
    const putFileMock = vi.mocked(api.putFile);

    let resolvePut!: (r: unknown) => void;
    putFileMock.mockImplementationOnce(
      () => new Promise((r) => { resolvePut = r as (v: unknown) => void; }) as never,
    );

    // saveFile's own fire-and-forget flush() already has this PUT in flight by the time
    // saveFile resolves — so this.flushing is true before the explicit flush() call below.
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'body', {}, 'E1');
    await vi.waitFor(() => expect(putFileMock).toHaveBeenCalledTimes(1));

    let flushResolved = false;
    const flushPromise = syncEngine.flush().then(() => { flushResolved = true; });

    // Let a few microtask turns pass — flush() must still be joined on the pending PUT.
    await Promise.resolve();
    await Promise.resolve();
    expect(flushResolved).toBe(false);
    expect(await db.pending.count()).toBe(1);

    resolvePut({ path: 'chapters/01/01.md', body: 'body', frontmatter: {}, etag: 'E2', word_count: 1 });
    await flushPromise;

    expect(flushResolved).toBe(true);
    expect(await db.pending.count()).toBe(0);
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

  it('R8: offline createChapter with no title defaults to the server-style "Chapter {n}" title', async () => {
    const api = await import('../api');
    vi.mocked(api.newChapter).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await syncEngine.createChapter('proj', {});

    const cached = await db.cache.get(fileKey('proj', result.meta_path));
    expect(cached?.frontmatter.title).toBe('Chapter 1');
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

  it('offline create-then-move to the front of a chapter lands at the dragged position, not the create-order', async () => {
    const api = await import('../api');
    const treeWithChapters = {
      ...emptyTree,
      chapters: [
        {
          path: 'chapters/01_Chapter_01',
          meta_path: 'chapters/01_Chapter_01/chapter.md',
          slug: '01_Chapter_01',
          kind: 'chapter' as const,
          title: 'Chapter 1',
          summary: null,
          chapter: 1,
          interlude: null,
          order: 1,
          act: null,
          word_count: 0,
          scenes: [
            {
              path: 'chapters/01_Chapter_01/01.md', title: null, summary: null,
              scene: 1, order: 1, pov: null, status: null, words_target: null, word_count: 0,
            },
          ],
        },
        {
          path: 'chapters/02_Chapter_02',
          meta_path: 'chapters/02_Chapter_02/chapter.md',
          slug: '02_Chapter_02',
          kind: 'chapter' as const,
          title: 'Chapter 2',
          summary: null,
          chapter: 2,
          interlude: null,
          order: 2,
          act: null,
          word_count: 0,
          scenes: [
            {
              path: 'chapters/02_Chapter_02/01.md', title: null, summary: null,
              scene: 1, order: 1, pov: null, status: null, words_target: null, word_count: 0,
            },
          ],
        },
      ],
    };
    await db.trees.put({ slug: 'proj', tree: treeWithChapters, cachedAt: Date.now() });

    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});

    // Drag the still-offline scene to the front of chapter 2, ahead of its existing scene.
    await syncEngine.moveScene('proj', {
      srcPath: scene.path,
      dstChapterSlug: '02_Chapter_02',
      srcOrder: [],
      dstOrder: [
        { path: scene.path, order: 1 },
        { path: 'chapters/02_Chapter_02/01.md', order: 2 },
      ],
    });

    (navigator as { onLine: boolean }).onLine = true;
    vi.mocked(api.newScene).mockReset();
    // The create appends at the end of chapter 2 (its only pre-existing scene is 01.md).
    vi.mocked(api.newScene).mockResolvedValueOnce({ scene: 2, path: 'chapters/02_Chapter_02/02.md' });
    const reorderMock = vi.mocked(api.reorder);
    reorderMock.mockResolvedValueOnce({ updated: [], count: 2 });
    vi.mocked(api.getProject).mockResolvedValue(emptyTree);

    await vi.waitFor(async () => {
      await syncEngine.flush();
      expect(await db.structureOps.count()).toBe(0);
    });

    // The create itself carries the dragged order; the queued reorder covers the real sibling.
    expect(vi.mocked(api.newScene)).toHaveBeenCalledWith('proj', '02_Chapter_02', { order: 1 });
    expect(reorderMock).toHaveBeenCalledWith('proj', [
      { path: 'chapters/02_Chapter_02/01.md', order: 2 },
    ]);
  });
});

describe('syncEngine deleteScene / deleteCategoryEntry', () => {
  const baseTree = {
    slug: 'proj',
    title: 'Test Project',
    author: null,
    rag_recipe: null,
    default_model: 'x',
    acts: [],
    chapters: [
      {
        path: 'chapters/01_Chapter_01',
        meta_path: 'chapters/01_Chapter_01/chapter.md',
        slug: '01_Chapter_01',
        kind: 'chapter' as const,
        title: 'Chapter 1',
        summary: null,
        chapter: 1,
        interlude: null,
        order: 1,
        act: null,
        scenes: [
          {
            path: 'chapters/01_Chapter_01/01.md',
            title: 'Scene 1',
            summary: null,
            scene: 1,
            order: 1,
            pov: null,
            status: null,
            words_target: null,
            word_count: 10,
          },
          {
            path: 'chapters/01_Chapter_01/02.md',
            title: 'Scene 2',
            summary: null,
            scene: 2,
            order: 2,
            pov: null,
            status: null,
            words_target: null,
            word_count: 5,
          },
        ],
        word_count: 15,
      },
    ],
    categories: [
      {
        name: 'Characters',
        folder: 'characters',
        codex: true,
        entries: [
          { path: 'characters/asha.md', title: 'Asha', aliases: [], tags: [], order: 1 },
        ],
      },
    ],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
    await db.trees.put({ slug: 'proj', tree: baseTree, cachedAt: Date.now() });
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('deleteScene calls the API, updates the cached tree, cleans IDB, and refreshes from the server', async () => {
    const api = await import('../api');
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValueOnce({
      ...baseTree,
      chapters: [{ ...baseTree.chapters[0], scenes: [baseTree.chapters[0].scenes[1]] }],
    });

    await db.cache.put({
      key: fileKey('proj', 'chapters/01_Chapter_01/01.md'),
      slug: 'proj',
      path: 'chapters/01_Chapter_01/01.md',
      body: 'text',
      frontmatter: {},
      serverEtag: 'e1',
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path: 'chapters/01_Chapter_01/01.md',
      body: 'text',
      frontmatter: {},
      baseEtag: 'e1',
      queuedAt: Date.now(),
      attempts: 0,
    });

    await syncEngine.deleteScene('proj', 'chapters/01_Chapter_01/01.md');

    expect(api.deleteFile).toHaveBeenCalledWith('proj', 'chapters/01_Chapter_01/01.md');

    const cached = await db.cache.get(fileKey('proj', 'chapters/01_Chapter_01/01.md'));
    expect(cached).toBeUndefined();

    const pending = await db.pending
      .where({ slug: 'proj', path: 'chapters/01_Chapter_01/01.md' })
      .toArray();
    expect(pending).toHaveLength(0);

    expect(api.getProject).toHaveBeenCalledWith('proj');

    const finalTree = await syncEngine.getCachedTree('proj');
    expect(finalTree!.chapters[0].scenes.map(s => s.path)).toEqual([
      'chapters/01_Chapter_01/02.md',
    ]);
  });

  it('deleteScene throws and leaves the cached tree untouched when the API call fails', async () => {
    const api = await import('../api');
    vi.mocked(api.deleteFile).mockRejectedValueOnce(new Error('500 Internal Server Error'));

    await expect(
      syncEngine.deleteScene('proj', 'chapters/01_Chapter_01/01.md'),
    ).rejects.toThrow('500 Internal Server Error');

    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.chapters[0].scenes).toHaveLength(2);
  });

  it('deleteScene queues an offline delete-scene op and removes the scene locally when unreachable', async () => {
    const api = await import('../api');
    vi.mocked(api.deleteFile).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await syncEngine.deleteScene('proj', 'chapters/01_Chapter_01/01.md');

    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.chapters[0].scenes.map(s => s.path)).toEqual(['chapters/01_Chapter_01/02.md']);

    const ops = await db.structureOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('delete-scene');
    expect((ops[0].payload as { path: string }).path).toBe('chapters/01_Chapter_01/01.md');

    vi.mocked(api.deleteFile).mockReset();
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);

    await syncEngine.flush();

    expect(api.deleteFile).toHaveBeenCalledWith('proj', 'chapters/01_Chapter_01/01.md', { tolerate404: true });
    expect(await db.structureOps.count()).toBe(0);
  });

  it('deleteScene of a not-yet-flushed offline scene purges the queued create instead of queueing a delete', async () => {
    const api = await import('../api');
    (navigator as { onLine: boolean }).onLine = false;
    vi.mocked(api.newScene).mockRejectedValue(new TypeError('Failed to fetch'));

    const scene = await syncEngine.createScene('proj', '01_Chapter_01', {});
    expect(await db.structureOps.count()).toBe(1);

    await syncEngine.deleteScene('proj', scene.path);

    expect(await db.structureOps.count()).toBe(0);

    const tree = await syncEngine.getCachedTree('proj');
    expect(tree!.chapters[0].scenes.map(s => s.path)).toEqual([
      'chapters/01_Chapter_01/01.md',
      'chapters/01_Chapter_01/02.md',
    ]);

    (navigator as { onLine: boolean }).onLine = true;
    await syncEngine.flush();

    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('deleteCategoryEntry calls the API, updates the cached tree, and cleans IDB', async () => {
    const api = await import('../api');
    vi.mocked(api.deleteFile).mockResolvedValueOnce(undefined);
    vi.mocked(api.getProject).mockResolvedValueOnce({
      ...baseTree,
      categories: [{ ...baseTree.categories[0], entries: [] }],
    });

    await db.cache.put({
      key: fileKey('proj', 'characters/asha.md'),
      slug: 'proj',
      path: 'characters/asha.md',
      body: 'text',
      frontmatter: {},
      serverEtag: 'e1',
      cachedAt: Date.now(),
    });

    await syncEngine.deleteCategoryEntry('proj', 'characters/asha.md');

    expect(api.deleteFile).toHaveBeenCalledWith('proj', 'characters/asha.md');

    const cached = await db.cache.get(fileKey('proj', 'characters/asha.md'));
    expect(cached).toBeUndefined();

    const finalTree = await syncEngine.getCachedTree('proj');
    expect(finalTree!.categories[0].entries).toHaveLength(0);
  });
});

describe('syncEngine prefetchProject (F1)', () => {
  // Single file (chapter.md, no scenes/categories) so a fetch's resolution can be
  // gated deterministically without juggling per-path resolvers across a batch.
  const tree = {
    slug: 'proj',
    title: 'Proj',
    author: null,
    rag_recipe: null,
    default_model: 'x',
    acts: [],
    chapters: [{
      path: 'chapters/01_Chapter_01',
      meta_path: 'chapters/01_Chapter_01/chapter.md',
      slug: '01_Chapter_01',
      kind: 'chapter' as const,
      title: 'Chapter 1',
      summary: null,
      chapter: 1,
      interlude: null,
      order: 1,
      act: null,
      word_count: 0,
      scenes: [],
    }],
    categories: [],
  };
  const path = 'chapters/01_Chapter_01/chapter.md';

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
    await db.trees.put({ slug: 'proj', tree, cachedAt: Date.now() });
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('prefetch waits for the network fetch to settle and lands the fresh body before resolving', async () => {
    const api = await import('../api');
    vi.mocked(api.getProject).mockResolvedValue(tree);

    let resolveFetch!: (v: Awaited<ReturnType<typeof api.getFile>>) => void;
    vi.mocked(api.getFile).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }) as never,
    );

    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'stale body',
      frontmatter: {},
      serverEtag: 'stale-etag',
      cachedAt: Date.now(),
    });

    let resolved = false;
    const prefetchPromise = syncEngine.prefetchProject('proj').then(() => { resolved = true; });

    await vi.waitFor(() => expect(api.getFile).toHaveBeenCalled());
    // The fetch is still pending — prefetch must not have reported done yet.
    expect(resolved).toBe(false);
    const stillStale = await db.cache.get(fileKey('proj', path));
    expect(stillStale!.body).toBe('stale body');

    resolveFetch({ path, body: 'fresh body', frontmatter: {}, etag: 'fresh-etag', word_count: 2 });
    await prefetchPromise;

    expect(resolved).toBe(true);
    const cached = await db.cache.get(fileKey('proj', path));
    expect(cached!.body).toBe('fresh body');
    expect(cached!.serverEtag).toBe('fresh-etag');
  });

  it('prefetch does not clobber a cache row that has a pending local edit', async () => {
    const api = await import('../api');
    vi.mocked(api.getProject).mockResolvedValue(tree);
    vi.mocked(api.getFile).mockResolvedValue({
      path, body: 'fresh from server', frontmatter: {}, etag: 'fresh-etag', word_count: 3,
    });

    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'local edit',
      frontmatter: {},
      serverEtag: 'local-etag',
      cachedAt: Date.now(),
    });
    await db.pending.add({
      slug: 'proj',
      path,
      body: 'local edit',
      frontmatter: {},
      baseEtag: 'local-etag',
      queuedAt: Date.now(),
      attempts: 0,
    });

    await syncEngine.prefetchProject('proj');

    const cached = await db.cache.get(fileKey('proj', path));
    expect(cached!.body).toBe('local edit');
    expect(cached!.serverEtag).toBe('local-etag');
  });

  it('prefetch does not clobber a cache row whose etag advanced while the GET was in flight', async () => {
    const api = await import('../api');
    vi.mocked(api.getProject).mockResolvedValue(tree);

    let resolveFetch!: (v: Awaited<ReturnType<typeof api.getFile>>) => void;
    vi.mocked(api.getFile).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }) as never,
    );

    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'snapshot body',
      frontmatter: {},
      serverEtag: 'snapshot-etag',
      cachedAt: Date.now(),
    });

    const prefetchPromise = syncEngine.prefetchProject('proj');
    await vi.waitFor(() => expect(api.getFile).toHaveBeenCalled());

    // Something else (e.g. an editor save flush, or getFile's own background refresh)
    // advances the cache row's etag while our prefetch GET is still in flight.
    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'newer body',
      frontmatter: {},
      serverEtag: 'newer-etag',
      cachedAt: Date.now(),
    });

    // The stale prefetch response finally lands.
    resolveFetch({ path, body: 'stale prefetch body', frontmatter: {}, etag: 'snapshot-etag', word_count: 3 });
    await prefetchPromise;

    const cached = await db.cache.get(fileKey('proj', path));
    expect(cached!.body).toBe('newer body');
    expect(cached!.serverEtag).toBe('newer-etag');
  });

  it('prefetch does not resurrect a cache row deleted while the GET was in flight', async () => {
    const api = await import('../api');
    vi.mocked(api.getProject).mockResolvedValue(tree);

    let resolveFetch!: (v: Awaited<ReturnType<typeof api.getFile>>) => void;
    vi.mocked(api.getFile).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }) as never,
    );

    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'snapshot body',
      frontmatter: {},
      serverEtag: 'snapshot-etag',
      cachedAt: Date.now(),
    });

    const prefetchPromise = syncEngine.prefetchProject('proj');
    await vi.waitFor(() => expect(api.getFile).toHaveBeenCalled());

    // The scene is deleted while the prefetch GET is still in flight.
    await db.cache.delete(fileKey('proj', path));

    resolveFetch({ path, body: 'stale prefetch body', frontmatter: {}, etag: 'snapshot-etag', word_count: 3 });
    await prefetchPromise;

    const cached = await db.cache.get(fileKey('proj', path));
    expect(cached).toBeUndefined();
  });

  it('prefetch does not clobber a cache row created while an uncached path was still in flight', async () => {
    const api = await import('../api');
    vi.mocked(api.getProject).mockResolvedValue(tree);

    let resolveFetch!: (v: Awaited<ReturnType<typeof api.getFile>>) => void;
    vi.mocked(api.getFile).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }) as never,
    );

    // No cache row exists at snapshot time — prefetchProject sees hadRow === false.
    expect(await db.cache.get(fileKey('proj', path))).toBeUndefined();

    const prefetchPromise = syncEngine.prefetchProject('proj');
    await vi.waitFor(() => expect(api.getFile).toHaveBeenCalled());

    // The user opens the uncached scene while prefetch's GET is still in flight,
    // which lands a fresh row via the normal getFile() path.
    await db.cache.put({
      key: fileKey('proj', path),
      slug: 'proj',
      path,
      body: 'live-opened body',
      frontmatter: {},
      serverEtag: 'live-etag',
      cachedAt: Date.now(),
    });

    // The slow prefetch response finally lands.
    resolveFetch({ path, body: 'stale prefetch body', frontmatter: {}, etag: 'snapshot-etag', word_count: 3 });
    await prefetchPromise;

    const cached = await db.cache.get(fileKey('proj', path));
    expect(cached!.body).toBe('live-opened body');
    expect(cached!.serverEtag).toBe('live-etag');
  });
});

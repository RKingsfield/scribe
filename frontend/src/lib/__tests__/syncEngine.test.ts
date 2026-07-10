import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, fileKey } from '../db';

// Stub navigator.onLine (globalThis.navigator may not exist in all Node versions)
if (typeof globalThis.navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
}
Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

// Mock the API module before any syncEngine import
vi.mock('../api', () => ({
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
}));

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

  it('snapshot reflects pending count correctly', async () => {
    await syncEngine.saveFile('proj', 'chapters/01/01.md', 'body', {}, 'e1');

    const snap = syncEngine.getSnapshot();
    expect(snap.pendingCount).toBe(1);
  });
});

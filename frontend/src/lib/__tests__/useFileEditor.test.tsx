import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Stub navigator.onLine before importing the sync engine.
if (typeof globalThis.navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
}
Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

// Mock only the external HTTP boundary; the real syncEngine runs against fake-indexeddb.
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

import { useFileEditor } from '../useFileEditor';
import { syncEngine, SAVE_DEBOUNCE_MS } from '../syncEngine';
import { db } from '../db';

const CONFLICT_KEY = 'proj::chapters/01/01.conflict.dev-x.20250101T000000Z.md';

async function recordConflict() {
  await db.conflicts.put({
    key: CONFLICT_KEY,
    slug: 'proj',
    path: 'chapters/01/01.conflict.dev-x.20250101T000000Z.md',
    canonicalPath: 'chapters/01/01.md',
    deviceId: 'dev-x',
    timestamp: '20250101T000000Z',
    noticedAt: Date.now(),
  });
}

async function clearAllTables() {
  await db.cache.clear();
  await db.pending.clear();
  await db.conflicts.clear();
  await db.kv.clear();
  await db.trees.clear();
  await db.structureOps.clear();
}

describe('useFileEditor cleanup (F2 data loss)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('flushes a debounced edit to IDB when the path changes before the timer fires', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));
    // Keep the flush from draining the queue so we can observe the edit in db.pending.
    vi.mocked(api.putFile).mockRejectedValue(new Error('network blip'));

    const { result, rerender } = renderHook(
      ({ path }) => useFileEditor({ slug: 'proj', path }),
      { initialProps: { path: 'chapters/01/01.md' } },
    );

    await waitFor(() => expect(result.current.file).not.toBeNull());

    // Type — schedules an 800 ms debounced save. Do NOT wait it out.
    act(() => {
      result.current.onBodyChange('edited body of scene one');
    });

    // Switch to another file within the debounce window; cleanup must flush the edit.
    rerender({ path: 'chapters/01/02.md' });

    await waitFor(async () => {
      const rows = await db.pending
        .where({ slug: 'proj', path: 'chapters/01/01.md' })
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('edited body of scene one');
    });

    // The edit also reached the local cache (source-of-truth mirror).
    const cached = await db.cache.get('proj::chapters/01/01.md');
    expect(cached!.body).toBe('edited body of scene one');
  });
});

describe('useFileEditor stale async completions (B1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    await clearAllTables();
  });

  const mockFiles = async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));
    vi.mocked(api.putFile).mockRejectedValue(new Error('network blip'));
    return api;
  };

  it('does not let the outgoing file’s save clobber the newly loaded file', async () => {
    await mockFiles();

    const { result, rerender } = renderHook(
      ({ path }) => useFileEditor({ slug: 'proj', path }),
      { initialProps: { path: 'chapters/01/01.md' } },
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());

    // Type, then switch inside the debounce window: teardown flushes the save
    // for 01.md while 02.md is loading.
    act(() => result.current.onBodyChange('edited body of scene one'));
    rerender({ path: 'chapters/01/02.md' });

    await waitFor(() =>
      expect(result.current.file?.path).toBe('chapters/01/02.md'),
    );

    // The outgoing save's queue write still lands — only its state updates are dropped.
    await waitFor(async () => {
      const rows = await db.pending
        .where({ slug: 'proj', path: 'chapters/01/01.md' })
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('edited body of scene one');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.file?.path).toBe('chapters/01/02.md');
    expect(result.current.file?.etag).toBe('etag-chapters/01/02.md');
    expect(result.current.body).toBe('body of chapters/01/02.md');
    expect(result.current.saveState).toBe('clean');
  });

  it('does not mark the newly loaded file blocked when the outgoing save hits a conflict', async () => {
    await mockFiles();
    await recordConflict();

    const { result, rerender } = renderHook(
      ({ path }) => useFileEditor({ slug: 'proj', path }),
      { initialProps: { path: 'chapters/01/01.md' } },
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());

    act(() => result.current.onBodyChange('edited body of scene one'));
    rerender({ path: 'chapters/01/02.md' });

    await waitFor(() =>
      expect(result.current.file?.path).toBe('chapters/01/02.md'),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // A late 'blocked' here would advertise 02.md as holding unsaved changes,
    // lifting 01.md's buffer into a merge for the wrong file.
    expect(result.current.saveState).toBe('clean');
  });

  it('clears a stale error once a save succeeds', async () => {
    await mockFiles();

    const { result } = renderHook(() =>
      useFileEditor({ slug: 'proj', path: 'chapters/01/01.md' }),
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());

    // Close the local store so the save's transaction genuinely fails.
    db.close();
    act(() => result.current.onBodyChange('first attempt'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.saveState).toBe('error');
    expect(result.current.error).not.toBeNull();

    await db.open();
    act(() => result.current.onBodyChange('second attempt'));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.saveState).toBe('saved');
    expect(result.current.error).toBeNull();
  });

  it('clears a stale error once a load succeeds', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));

    const { result, rerender } = renderHook(
      ({ path }) => useFileEditor({ slug: 'proj', path }),
      { initialProps: { path: 'chapters/01/01.md' } },
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());

    rerender({ path: 'chapters/01/02.md' });
    await waitFor(() => expect(result.current.file).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});

describe('useFileEditor conflict window (always-reload contract)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    await clearAllTables();
  });

  it('blocks the save during a conflict, then reloads the canonical on resolve — the buffer was a merge input', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));
    vi.mocked(api.putFile).mockImplementation(async (_slug, path, payload) => ({
      path,
      body: payload.body,
      frontmatter: payload.frontmatter,
      etag: 'etag-after-save',
      word_count: payload.body.split(/\s+/).filter(Boolean).length,
      conflict: false,
    }));

    const { result } = renderHook(() =>
      useFileEditor({ slug: 'proj', path: 'chapters/01/01.md' }),
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());

    // A conflict lands for this file (e.g. a background flush hit 409).
    await recordConflict();

    // Type during the conflict window, then force the debounced save to run now.
    act(() => result.current.onBodyChange('keystrokes during conflict'));
    await act(async () => {
      await result.current.save();
    });

    // The write was blocked, not "saved" — nothing queued, UI shows the blocked badge.
    expect(result.current.saveState).toBe('blocked');
    expect(await db.pending.toArray()).toHaveLength(0);

    // The three-way modal consumed the buffer and wrote the resolved canonical to cache.
    await db.cache.put({
      key: 'proj::chapters/01/01.md',
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'resolved canonical body',
      frontmatter: {},
      serverEtag: 'etag-resolved',
      cachedAt: Date.now(),
    });

    // Resolve the conflict; the editor unconditionally reloads the canonical —
    // the dirty buffer is discarded, not replayed over the resolution.
    await act(async () => {
      await syncEngine.dismissConflict(CONFLICT_KEY);
    });
    await waitFor(() =>
      expect(result.current.body).toBe('resolved canonical body'),
    );
    expect(result.current.body).not.toBe('keystrokes during conflict');
  });

  it('clears a pending debounce timer on resolve so it cannot clobber the resolved canonical', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));
    // Keep any queued write in db.pending so a stale-timer save is observable.
    vi.mocked(api.putFile).mockRejectedValue(new Error('network blip'));

    const { result } = renderHook(() =>
      useFileEditor({ slug: 'proj', path: 'chapters/01/01.md' }),
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());

    await recordConflict();

    // Type during the conflict window — schedules an 800 ms debounced save.
    // Do NOT flush it manually; the timer is still pending when we resolve.
    act(() => result.current.onBodyChange('keystrokes during conflict'));
    expect(result.current.saveState).toBe('dirty');

    // The modal wrote the resolved canonical to cache.
    await db.cache.put({
      key: 'proj::chapters/01/01.md',
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'resolved canonical body',
      frontmatter: {},
      serverEtag: 'etag-resolved',
      cachedAt: Date.now(),
    });

    // Resolve: the handler must clear the pending timer and reload the canonical.
    await act(async () => {
      await syncEngine.dismissConflict(CONFLICT_KEY);
    });
    await waitFor(() =>
      expect(result.current.body).toBe('resolved canonical body'),
    );

    // Let the original debounce window fully elapse. A surviving timer would
    // now fire save() — with the conflict marker gone it would NOT be blocked,
    // queueing a write that overwrites the just-resolved canonical.
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 150));

    const queued = await db.pending
      .where({ slug: 'proj', path: 'chapters/01/01.md' })
      .toArray();
    expect(queued).toHaveLength(0);
    expect(result.current.saveState).toBe('clean');
  });

  it('reloads the canonical on resolve when the buffer is clean', async () => {
    const api = await import('../api');
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => ({
      path,
      body: `body of ${path}`,
      frontmatter: {},
      etag: `etag-${path}`,
      word_count: 3,
    }));

    const { result } = renderHook(() =>
      useFileEditor({ slug: 'proj', path: 'chapters/01/01.md' }),
    );
    await waitFor(() => expect(result.current.file).not.toBeNull());
    expect(result.current.saveState).toBe('clean');

    await recordConflict();
    // The merge (via ConflictsBanner) wrote the resolved canonical to cache.
    await db.cache.put({
      key: 'proj::chapters/01/01.md',
      slug: 'proj',
      path: 'chapters/01/01.md',
      body: 'merged canonical body',
      frontmatter: {},
      serverEtag: 'etag-merged',
      cachedAt: Date.now(),
    });

    await act(async () => {
      await syncEngine.dismissConflict(CONFLICT_KEY);
    });

    // Clean buffer → the canonical is reloaded into the editor.
    await waitFor(() => expect(result.current.body).toBe('merged canonical body'));
    expect(result.current.saveState).toBe('clean');
  });
});

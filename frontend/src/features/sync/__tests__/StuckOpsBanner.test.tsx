import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StuckOpsBanner } from '../StuckOpsBanner';
import { db, type StructureOp } from '../../../lib/db';

if (typeof globalThis.navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
}
Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    getFile: vi.fn(),
    putFile: vi.fn(),
    getProject: vi.fn(),
    deleteChapter: vi.fn(),
    deleteFile: vi.fn(),
  };
});

import * as api from '../../../lib/api';
import { syncEngine } from '../../../lib/syncEngine';

async function clearAllTables() {
  await db.cache.clear();
  await db.pending.clear();
  await db.conflicts.clear();
  await db.trees.clear();
  await db.structureOps.clear();
}

describe('StuckOpsBanner', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    (navigator as { onLine: boolean }).onLine = true;
  });

  afterEach(async () => {
    cleanup();
    await clearAllTables();
  });

  it('renders nothing when there are no stuck ops', async () => {
    const { container } = render(<StuckOpsBanner slug="demo" />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('lists a stuck op with its kind, target, and last error', async () => {
    await db.structureOps.add({
      slug: 'demo', op: 'delete-chapter', payload: { chapterSlug: '02_Chapter_02' },
      tempId: '02_Chapter_02', queuedAt: 1, attempts: 2, lastError: '409 Conflict: not empty',
      stuckAt: Date.now(),
    } as StructureOp);

    render(<StuckOpsBanner slug="demo" />);

    await screen.findByText(/1 stuck operation/);
    expect(screen.getByText('delete-chapter')).toBeTruthy();
    expect(screen.getByText('02_Chapter_02')).toBeTruthy();
    expect(screen.getByText('409 Conflict: not empty')).toBeTruthy();
  });

  it('lists a stuck pending write as a file write against its path', async () => {
    await db.pending.add({
      slug: 'demo', path: 'chapters/01_Chapter_01/01.md', body: 'queued text',
      frontmatter: {}, baseEtag: 'e1', queuedAt: 1, attempts: 1,
      lastError: '412 Precondition Failed', stuckAt: Date.now(),
    });

    render(<StuckOpsBanner slug="demo" />);

    await screen.findByText(/1 stuck operation/);
    expect(screen.getByText('file write')).toBeTruthy();
    expect(screen.getByText('chapters/01_Chapter_01/01.md')).toBeTruthy();
    expect(screen.getByText('412 Precondition Failed')).toBeTruthy();
  });

  it('Discard on a stuck pending write names the path, warns, and drops only the queued write', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const path = 'chapters/01_Chapter_01/01.md';
    const writeId = await db.pending.add({
      slug: 'demo', path, body: 'queued text', frontmatter: {},
      baseEtag: 'e1', queuedAt: 1, attempts: 1, lastError: '412', stuckAt: Date.now(),
    });
    await db.cache.put({
      key: `demo::${path}`, slug: 'demo', path, body: 'queued text',
      frontmatter: {}, serverEtag: 'e1', cachedAt: Date.now(),
    });

    render(<StuckOpsBanner slug="demo" />);
    await screen.findByText(/1 stuck operation/);

    fireEvent.click(screen.getByText('Discard'));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining(path));
    await waitFor(async () => expect(await db.pending.get(writeId)).toBeUndefined());
    expect(await db.cache.get(`demo::${path}`)).toBeDefined();
    expect(syncEngine.getSnapshot().stuckPendingCount).toBe(0);
    confirmSpy.mockRestore();
  });

  it('Retry all unparks every stuck item, replaying ops and writes together', async () => {
    const stuckId = await db.structureOps.add({
      slug: 'demo', op: 'delete-chapter', payload: { chapterSlug: '02_Chapter_02' },
      tempId: '02_Chapter_02', queuedAt: 1, attempts: 2, lastError: '409 Conflict',
      stuckAt: Date.now(),
    } as StructureOp);
    const writeId = await db.pending.add({
      slug: 'demo', path: 'chapters/01_Chapter_01/01.md', body: 'queued text',
      frontmatter: {}, baseEtag: 'e1', queuedAt: 2, attempts: 1, lastError: '412',
      stuckAt: Date.now(),
    });
    await db.trees.put({
      slug: 'demo',
      tree: {
        slug: 'demo', title: 'Demo', author: null, rag_recipe: null, default_model: 'x',
        acts: [], chapters: [], categories: [],
      },
      cachedAt: Date.now(),
    });
    vi.mocked(api.deleteChapter).mockResolvedValueOnce(undefined);
    vi.mocked(api.putFile).mockResolvedValueOnce({
      path: 'chapters/01_Chapter_01/01.md', body: 'queued text', frontmatter: {},
      etag: 'e2', word_count: 2,
    });
    vi.mocked(api.getProject).mockResolvedValue({
      slug: 'demo', title: 'Demo', author: null, rag_recipe: null, default_model: 'x',
      acts: [], chapters: [], categories: [],
    });

    render(<StuckOpsBanner slug="demo" />);
    await screen.findByText(/2 stuck operations/);

    fireEvent.click(screen.getByText('Retry all'));

    await waitFor(() => expect(api.deleteChapter).toHaveBeenCalledWith('demo', '02_Chapter_02'));
    await waitFor(async () => expect(await db.structureOps.get(stuckId)).toBeUndefined());
    await waitFor(async () => expect(await db.pending.get(writeId)).toBeUndefined());
    await waitFor(() => expect(screen.queryByText(/stuck operation/)).toBeNull());
  });

  it('Discard asks for confirmation naming the target, then deletes the op on confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const stuckId = await db.structureOps.add({
      slug: 'demo', op: 'delete-chapter', payload: { chapterSlug: '02_Chapter_02' },
      tempId: '02_Chapter_02', queuedAt: 1, attempts: 2, lastError: '409 Conflict',
      stuckAt: Date.now(),
    } as StructureOp);

    render(<StuckOpsBanner slug="demo" />);
    await screen.findByText(/1 stuck operation/);

    fireEvent.click(screen.getByText('Discard'));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('02_Chapter_02'));
    await waitFor(async () => expect(await db.structureOps.get(stuckId)).toBeUndefined());
    expect(syncEngine.getSnapshot().stuckOpsCount).toBe(0);
    confirmSpy.mockRestore();
  });

  it('Discard does nothing when the confirmation is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const stuckId = await db.structureOps.add({
      slug: 'demo', op: 'new-scene', payload: { chapterSlug: '02_Chapter_02' },
      tempId: 'temp-1', queuedAt: 1, attempts: 1, lastError: 'boom',
      stuckAt: Date.now(),
    } as StructureOp);

    render(<StuckOpsBanner slug="demo" />);
    await screen.findByText(/1 stuck operation/);

    fireEvent.click(screen.getByText('Discard'));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('orphaned'));
    expect(await db.structureOps.get(stuckId)).toBeDefined();
    confirmSpy.mockRestore();
  });
});

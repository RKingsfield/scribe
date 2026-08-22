import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictsBanner } from '../ConflictsBanner';
import { db } from '../../../lib/db';
import { syncEngine } from '../../../lib/syncEngine';
import type { GetEditorBuffer } from '../../../lib/useFileEditor';
import type { ServerConflictEntry, FileGet, FilePutResult } from '../../../lib/api';

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    listServerConflicts: vi.fn(),
    discardServerConflict: vi.fn(),
    getFile: vi.fn(),
    putFile: vi.fn(),
  };
});

import * as api from '../../../lib/api';

// jsdom doesn't implement scrollIntoView; the modal calls it on zone navigation.
Element.prototype.scrollIntoView = vi.fn();

const conflict: ServerConflictEntry = {
  path: 'chapters/01_Chapter_01/01.conflict.dev-b.20250101T000000Z.md',
  canonical_path: 'chapters/01_Chapter_01/01.md',
  device_id: 'dev-b',
  timestamp: '20250101T000000Z',
  size: 100,
  mtime_ns: 0,
};

const canonicalFile: FileGet = {
  path: 'chapters/01_Chapter_01/01.md',
  body: 'The door creaked open slowly.',
  frontmatter: { status: 'draft' },
  etag: 'canonical-etag',
  word_count: 5,
};

const conflictFile: FileGet = {
  path: conflict.path,
  body: 'The door creaked open quietly.',
  frontmatter: { status: 'final' },
  etag: 'conflict-etag',
  word_count: 5,
};

async function clearAllTables() {
  await db.cache.clear();
  await db.conflicts.clear();
}

describe('ConflictsBanner', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) =>
      path === canonicalFile.path ? canonicalFile : conflictFile,
    );
  });

  afterEach(async () => {
    cleanup();
    await clearAllTables();
  });

  it('renders nothing while there are no conflicts', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([]);
    const { container } = render(<ConflictsBanner slug="demo" />);
    await waitFor(() => expect(api.listServerConflicts).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('shows the conflict count and singular/plural wording', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);
    await screen.findByText(/1 conflict —/);
  });

  it('opens the resolve modal, loads both file versions, and shows the diff nav', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);

    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));

    await waitFor(() => {
      expect(api.getFile).toHaveBeenCalledWith('demo', canonicalFile.path);
      expect(api.getFile).toHaveBeenCalledWith('demo', conflict.path);
    });
    await screen.findByText('1 difference');
    expect(screen.getByText('—')).toBeTruthy(); // no zone selected yet
  });

  it('zone navigation cycles the "N / M" position forward and back', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    fireEvent.click(screen.getByTitle('Next difference'));
    await screen.findByText('1 / 1');

    fireEvent.click(screen.getByTitle('Previous difference'));
    await screen.findByText('1 / 1');
  });

  it('cherry-picking a zone marks it picked and applying the merge sends the assembled body', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    vi.mocked(api.putFile).mockResolvedValue({
      ...canonicalFile,
      body: 'The door creaked open quietly.',
    } as FilePutResult);

    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    // The conflict (right-hand) word for this change zone is "quietly.";
    // clicking it picks the conflict's wording over the server's "slowly.".
    const conflictWord = await screen.findByText('quietly.');
    expect(conflictWord.className).not.toContain('zone-picked');
    fireEvent.click(conflictWord);
    expect(conflictWord.className).toContain('zone-picked');

    fireEvent.click(screen.getByText('Apply merge'));

    await waitFor(() => expect(api.putFile).toHaveBeenCalled());
    const [slug, path, payload, etag] = vi.mocked(api.putFile).mock.calls[0];
    expect(slug).toBe('demo');
    expect(path).toBe(canonicalFile.path);
    expect(payload.body).toBe('The door creaked open quietly.');
    expect(etag).toBe('canonical-etag');
    await waitFor(() =>
      expect(api.discardServerConflict).toHaveBeenCalledWith('demo', conflict.path),
    );
  });

  it('"Keep server" discards the conflict without writing a merged file', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    fireEvent.click(screen.getByText('Keep server'));

    await waitFor(() =>
      expect(api.discardServerConflict).toHaveBeenCalledWith('demo', conflict.path),
    );
    expect(api.putFile).not.toHaveBeenCalled();
  });

  it('drops the local conflict marker from IndexedDB when a conflict is resolved', async () => {
    await db.conflicts.put({
      key: `demo::${conflict.path}`,
      slug: 'demo',
      path: conflict.path,
      canonicalPath: conflict.canonical_path,
      deviceId: conflict.device_id,
      timestamp: conflict.timestamp,
      noticedAt: Date.now(),
    });

    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    fireEvent.click(screen.getByText('Keep server'));

    await waitFor(async () => {
      expect(await db.conflicts.get(`demo::${conflict.path}`)).toBeUndefined();
    });
  });

  // The lookup contract: return the buffer only when asked for the given path,
  // and only when that editor holds unsaved changes. It knows nothing about
  // which path is "active" — a conflict on any mounted scene lifts its buffer.
  const editorLookupFor = (canonicalPath: string): GetEditorBuffer => (path) =>
    path === canonicalPath
      ? {
          body: 'The door creaked open swiftly.',
          frontmatter: { status: 'revision' },
        }
      : null;

  it('renders the three-column mode with the Editor column when the lookup returns a buffer for the conflict path', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(
      <ConflictsBanner
        slug="demo"
        getEditorBuffer={editorLookupFor(conflict.canonical_path)}
      />,
    );
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    // Third column + warning + whole-doc button for the editor buffer.
    await screen.findByText('Editor (unsaved)');
    await screen.findByText(/shown as the Editor column/);
    expect(screen.getByText('Keep my edits')).toBeTruthy();
    // The editor's word for the change zone is shown for cherry-picking.
    expect(screen.getByText('swiftly.')).toBeTruthy();
  });

  it('cherry-picking the editor column lands the editor text in the merged body', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    vi.mocked(api.putFile).mockResolvedValue({
      ...canonicalFile,
      body: 'The door creaked open swiftly.',
    } as FilePutResult);
    render(
      <ConflictsBanner
        slug="demo"
        getEditorBuffer={editorLookupFor(conflict.canonical_path)}
      />,
    );
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    const editorWord = await screen.findByText('swiftly.');
    expect(editorWord.className).not.toContain('zone-picked');
    fireEvent.click(editorWord);
    expect(editorWord.className).toContain('zone-picked');

    fireEvent.click(screen.getByText('Apply merge'));
    await waitFor(() => expect(api.putFile).toHaveBeenCalled());
    const [, path, payload] = vi.mocked(api.putFile).mock.calls[0];
    expect(path).toBe(canonicalFile.path);
    expect(payload.body).toBe('The door creaked open swiftly.');
  });

  it('"Keep my edits" writes the lifted buffer snapshot without confirming', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    vi.mocked(api.putFile).mockResolvedValue({
      ...canonicalFile,
      body: 'The door creaked open swiftly.',
    } as FilePutResult);
    render(
      <ConflictsBanner
        slug="demo"
        getEditorBuffer={editorLookupFor(conflict.canonical_path)}
      />,
    );
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    fireEvent.click(screen.getByText('Keep my edits'));
    await waitFor(() => expect(api.putFile).toHaveBeenCalled());
    const [, , payload] = vi.mocked(api.putFile).mock.calls[0];
    expect(payload.body).toBe('The door creaked open swiftly.');
    expect(payload.frontmatter).toMatchObject({ status: 'revision' });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('confirms before "Keep server" and "Use conflict" discard the buffer, but not for "Apply merge"', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    vi.mocked(api.putFile).mockResolvedValue({ ...canonicalFile } as FilePutResult);
    render(
      <ConflictsBanner
        slug="demo"
        getEditorBuffer={editorLookupFor(conflict.canonical_path)}
      />,
    );
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    // "Use conflict" discards the buffer → confirm gates it (declined here).
    fireEvent.click(screen.getByText('Use conflict'));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(api.putFile).not.toHaveBeenCalled();

    // "Keep server" also gates on confirm (declined).
    fireEvent.click(screen.getByText('Keep server'));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(api.discardServerConflict).not.toHaveBeenCalled();

    // "Apply merge" is the explicit choice → never confirms, and resolves.
    fireEvent.click(screen.getByText('Apply merge'));
    await waitFor(() => expect(api.putFile).toHaveBeenCalled());
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });

  it('renders unchanged two-column mode when the buffer is a different path', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(
      <ConflictsBanner
        slug="demo"
        getEditorBuffer={editorLookupFor('chapters/02_Chapter_02/01.md')}
      />,
    );
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    expect(screen.queryByText('Editor (unsaved)')).toBeNull();
    expect(screen.queryByText('Keep my edits')).toBeNull();
    expect(screen.queryByText(/shown as the Editor column/)).toBeNull();

    fireEvent.click(screen.getByText('Keep server'));
    await waitFor(() =>
      expect(api.discardServerConflict).toHaveBeenCalledWith('demo', conflict.path),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('lifts the buffer for the conflict path even when the lookup is driven by a different active editor', async () => {
    // The lookup does not consult which path is "active" — it answers purely by
    // path. A conflict on scene A resolves with A's unsaved buffer even though
    // the user has clicked into scene B (whose editor is the "active" one).
    const lookup: GetEditorBuffer = (path) =>
      path === conflict.canonical_path
        ? { body: 'The door creaked open swiftly.', frontmatter: { status: 'revision' } }
        : null;
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" getEditorBuffer={lookup} />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');

    await screen.findByText('Editor (unsaved)');
    expect(screen.getByText('swiftly.')).toBeTruthy();
    expect(screen.getByText('Keep my edits')).toBeTruthy();
  });

  const second: ServerConflictEntry = {
    path: 'chapters/02_Chapter_02/01.conflict.dev-c.20250202T000000Z.md',
    canonical_path: 'chapters/02_Chapter_02/01.md',
    device_id: 'dev-c',
    timestamp: '20250202T000000Z',
    size: 100,
    mtime_ns: 0,
  };

  const twoConflictFiles: Record<string, FileGet> = {
    [conflict.canonical_path]: {
      path: conflict.canonical_path,
      body: 'The alpha door creaked.',
      frontmatter: { status: 'draft' },
      etag: 'alpha-etag',
      word_count: 4,
    },
    [conflict.path]: {
      path: conflict.path,
      body: 'The alpha door slammed.',
      frontmatter: { status: 'final' },
      etag: 'alpha-conflict-etag',
      word_count: 4,
    },
    [second.canonical_path]: {
      path: second.canonical_path,
      body: 'The bravo door creaked.',
      frontmatter: { status: 'draft' },
      etag: 'bravo-etag',
      word_count: 4,
    },
    [second.path]: {
      path: second.path,
      body: 'The bravo door slammed.',
      frontmatter: { status: 'final' },
      etag: 'bravo-conflict-etag',
      word_count: 4,
    },
  };

  it('ignores a stale activation fetch that resolves after switching conflicts', async () => {
    const files = twoConflictFiles;
    // Hold the first activation's fetches open so they land after the switch.
    const held: (() => void)[] = [];
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => {
      const file = files[path];
      if (path.startsWith('chapters/01_')) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      return file;
    });
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict, second]);
    vi.mocked(api.putFile).mockResolvedValue({
      ...files[second.canonical_path],
    } as FilePutResult);

    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));

    // Activate the first conflict; its fetches stay pending.
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await waitFor(() => expect(held).toHaveLength(2));

    // Go back and activate the second, which resolves immediately.
    fireEvent.click(screen.getByText('back'));
    fireEvent.click(await screen.findByText(second.canonical_path));
    await waitFor(() => expect(screen.getAllByText(/bravo/).length).toBe(2));

    // The first activation now lands. It must not repaint the modal.
    await act(async () => {
      held.forEach((release) => release());
      await Promise.resolve();
    });

    expect(screen.queryByText(/alpha/)).toBeNull();
    expect(screen.getAllByText(/bravo/).length).toBe(2);

    // And the etag used to resolve belongs to the second conflict.
    fireEvent.click(screen.getByText('Use conflict'));
    await waitFor(() => expect(api.putFile).toHaveBeenCalled());
    const [, path, payload, etag] = vi.mocked(api.putFile).mock.calls[0];
    expect(path).toBe(second.canonical_path);
    expect(payload.body).toBe('The bravo door slammed.');
    expect(etag).toBe('bravo-etag');
  });

  it('does not carry the previous conflict’s etag and body into a failed activation', async () => {
    vi.mocked(api.getFile).mockImplementation(async (_slug, path) => {
      if (path.startsWith('chapters/02_')) throw new Error('offline');
      return twoConflictFiles[path];
    });
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict, second]);

    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));

    // Load the first conflict fully, then switch to one whose fetch fails.
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await waitFor(() => expect(screen.getAllByText(/alpha/).length).toBe(2));
    fireEvent.click(screen.getByText('back'));
    fireEvent.click(await screen.findByText(second.canonical_path));
    await screen.findByText(/offline/);

    // Nothing of the first conflict survives, and with no canonical etag a
    // resolve would PUT unconditionally — so the write actions stay disabled.
    expect(screen.queryByText(/alpha/)).toBeNull();
    expect(screen.queryByText('Frontmatter differences')).toBeNull();
    expect(screen.getByText('Use conflict').hasAttribute('disabled')).toBe(true);
    expect(api.putFile).not.toHaveBeenCalled();

    // Keep server needs no etag, but it permanently deletes the conflict file — it must
    // not be the one action left enabled on content the user never got to see.
    expect(screen.getByText('Keep server').hasAttribute('disabled')).toBe(true);
    expect(api.discardServerConflict).not.toHaveBeenCalled();
  });

  it('drops back to the conflict list when a path remap touches the active conflict', async () => {
    vi.mocked(api.listServerConflicts).mockResolvedValue([conflict]);
    render(<ConflictsBanner slug="demo" />);
    fireEvent.click(await screen.findByText('Resolve'));
    fireEvent.click(await screen.findByText(conflict.canonical_path));
    await screen.findByText('1 difference');
    expect(screen.getByText('Keep server')).toBeTruthy();

    // A queued move-scene replays mid-modal, rekeying the conflict's canonical
    // path. The modal must abandon the now-stale activation and refresh.
    await act(async () => {
      await syncEngine.rekeyLocalPath(
        'demo',
        conflict.canonical_path,
        'chapters/09_Chapter_09/01.md',
      );
    });

    await waitFor(() => expect(screen.queryByText('Keep server')).toBeNull());
    expect(screen.queryByText('1 difference')).toBeNull();
    // Back to the list: the conflict entry with its device meta is shown again.
    await screen.findByText(/from dev-b/);
  });
});

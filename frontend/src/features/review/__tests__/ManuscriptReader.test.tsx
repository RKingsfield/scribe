import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManuscriptReader } from '../ManuscriptReader';
import type { Manuscript, ReviewComment } from '../../../lib/api';

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    getManuscript: vi.fn(),
    getComments: vi.fn(),
    resolveComment: vi.fn(),
    addComment: vi.fn(),
    addSessionComment: vi.fn(),
    getSessionManuscript: vi.fn(),
    getSessionComments: vi.fn(),
    resolveSessionComment: vi.fn(),
  };
});

import * as api from '../../../lib/api';

// Both scenes carry the identical sentence, so a comment's anchor only
// disambiguates correctly if matching is scoped to the comment's own scene (R5).
const manuscript: Manuscript = {
  title: 'Test Novel',
  author: 'Author',
  chapters: [
    {
      slug: '01_Chapter_01',
      title: 'Chapter One',
      number: 1,
      kind: 'chapter',
      scenes: [
        { path: 'chapters/01_Chapter_01/01.md', title: 'Scene One', html: '<p>The door creaked open slowly.</p>' },
        { path: 'chapters/01_Chapter_01/02.md', title: 'Scene Two', html: '<p>The door creaked open slowly.</p>' },
      ],
    },
  ],
};

const comment: ReviewComment = {
  id: 'c1',
  session: 's1',
  scene: 'chapters/01_Chapter_01/02.md',
  anchor: { prefix: 'The ', exact: 'door creaked', suffix: ' open' },
  author: 'Reviewer',
  text: 'Nice imagery',
  created: new Date().toISOString(),
  resolved: false,
};

describe('ManuscriptReader highlight lifecycle', () => {
  beforeEach(() => {
    vi.mocked(api.getManuscript).mockResolvedValue(manuscript);
    vi.mocked(api.getComments).mockResolvedValue([comment]);
    vi.mocked(api.resolveComment).mockResolvedValue({ ...comment, resolved: true });
  });

  it('highlights the comment anchor in its scene, then clears the mark on resolve', async () => {
    const { container } = render(
      <ManuscriptReader token="tok" isAuthor reviewerName="Reviewer" />,
    );

    await waitFor(() => {
      expect(container.querySelector('mark.review-highlight')).toBeTruthy();
    });
    const mark = container.querySelector('mark.review-highlight')!;
    expect(mark.closest('[data-scene]')?.getAttribute('data-scene')).toBe(comment.scene);

    fireEvent.click(screen.getByText('Resolve'));

    await waitFor(() => {
      expect(container.querySelector('mark.review-highlight')).toBeFalsy();
    });
  });
});

describe('ManuscriptReader owner-scoped comment posting', () => {
  beforeEach(() => {
    vi.mocked(api.getSessionManuscript).mockResolvedValue(manuscript);
    vi.mocked(api.getSessionComments).mockResolvedValue([]);
    vi.mocked(api.addSessionComment).mockResolvedValue({ ...comment, id: 'c2', text: 'owner note' });
  });

  it('posts via the owner endpoint, not the public token endpoint, when ownerSession is set', async () => {
    const { container } = render(
      <ManuscriptReader
        token="tok"
        isAuthor
        reviewerName="Author"
        ownerSession={{ slug: 'example-novel', sessionId: 's1' }}
      />,
    );

    await waitFor(() => expect(api.getSessionManuscript).toHaveBeenCalled());

    const sceneEl = container.querySelector('[data-scene="chapters/01_Chapter_01/01.md"] p')!;
    const range = document.createRange();
    range.selectNodeContents(sceneEl);
    // jsdom's Range has no layout engine; ManuscriptReader positions the composer off it.
    range.getBoundingClientRect = () => ({ bottom: 0, left: 0, top: 0, right: 0, width: 0, height: 0 }) as DOMRect;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(container.querySelector('.review-manuscript')!);

    const textarea = await screen.findByPlaceholderText('Add a comment…');
    fireEvent.change(textarea, { target: { value: 'owner note' } });
    fireEvent.click(screen.getByText('Comment'));

    await waitFor(() => {
      expect(api.addSessionComment).toHaveBeenCalledWith(
        'example-novel', 's1', expect.objectContaining({ text: 'owner note' }), 'Author',
      );
    });
    expect(api.addComment).not.toHaveBeenCalled();
  });
});

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChapterFlow } from '../ChapterFlow';
import type { GetEditorBuffer } from '../../../lib/useFileEditor';
import { chapter } from './fixtures';

describe('ChapterFlow', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ChapterFlow
        slug="demo"
        chapter={chapter}
        activePath={chapter.scenes[0].path}
        onActivePath={() => {}}
        onSelect={() => {}}
        onTreeChanged={() => {}}
        codex={[]}
        onSaveStateChange={() => {}}
        onBufferLookup={() => {}}
        onLiveWordCount={() => {}}
        onRequestRewrite={() => {}}
        models={[]}
        helperModel={undefined}
        setHelperModel={() => {}}
      />,
    );
    expect(container.querySelector('.chapter-flow')).toBeTruthy();
  });

  it('exposes a per-scene buffer lookup that gates on unsaved changes', () => {
    let lookup: GetEditorBuffer | null = null;
    render(
      <ChapterFlow
        slug="demo"
        chapter={chapter}
        activePath={chapter.scenes[0].path}
        onActivePath={() => {}}
        onSelect={() => {}}
        onTreeChanged={() => {}}
        codex={[]}
        onSaveStateChange={() => {}}
        onBufferLookup={(fn) => {
          lookup = fn;
        }}
        onLiveWordCount={() => {}}
        onRequestRewrite={() => {}}
        models={[]}
        helperModel={undefined}
        setHelperModel={() => {}}
      />,
    );
    expect(typeof lookup).toBe('function');
    // A freshly mounted, clean scene must not surface a buffer, and an unknown
    // path returns null — the lookup only lifts editors holding unsaved changes.
    expect(lookup!(chapter.scenes[0].path)).toBeNull();
    expect(lookup!('chapters/99_Chapter_99/01.md')).toBeNull();
  });
});

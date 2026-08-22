import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Sidebar } from '../Sidebar';
import type { ProjectTree } from '../../../lib/api';

const tree: ProjectTree = {
  slug: 'demo',
  title: 'Demo Novel',
  author: 'Author',
  rag_recipe: null,
  default_model: 'gpt',
  acts: [],
  chapters: [
    {
      path: 'chapters/01_Chapter_01',
      meta_path: 'chapters/01_Chapter_01/chapter.md',
      slug: '01_Chapter_01',
      kind: 'chapter',
      title: 'Beginnings',
      summary: null,
      chapter: 1,
      interlude: null,
      order: 1,
      act: null,
      scenes: [],
      word_count: 0,
    },
  ],
  categories: [],
};

describe('Sidebar', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Sidebar
        tree={tree}
        slug="demo"
        activePath={null}
        onSelect={() => {}}
        onTreeChanged={() => {}}
      />,
    );
    expect(container.querySelector('.sidebar')).toBeTruthy();
  });
});

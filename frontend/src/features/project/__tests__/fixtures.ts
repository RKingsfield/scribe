import type { ChapterEntry, ProjectTree } from '../../../lib/api';

export const chapter: ChapterEntry = {
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
  scenes: [
    {
      path: 'chapters/01_Chapter_01/01.md',
      title: 'Scene One',
      summary: null,
      scene: 1,
      order: 1,
      pov: null,
      status: 'draft',
      words_target: null,
      word_count: 100,
    },
  ],
  word_count: 100,
};

export const tree: ProjectTree = {
  slug: 'demo',
  title: 'Demo Novel',
  author: 'Author',
  rag_recipe: null,
  default_model: 'gpt',
  acts: [],
  chapters: [chapter],
  categories: [],
};

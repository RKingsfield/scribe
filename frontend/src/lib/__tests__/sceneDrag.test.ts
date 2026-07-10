import { describe, it, expect } from 'vitest';
import type { ProjectTree, SceneEntry } from '../api';
import { resolveSceneMove, parseSceneZoneId, isSceneZone } from '../sceneDrag';

function makeScene(overrides: Partial<SceneEntry> = {}): SceneEntry {
  return {
    path: 'chapters/01_Chapter_01/01.md',
    title: null,
    summary: null,
    scene: 1,
    order: 1,
    pov: null,
    status: null,
    words_target: null,
    word_count: 0,
    ...overrides,
  };
}

function makeTestTree(): ProjectTree {
  return {
    slug: 'test',
    title: 'Test',
    author: null,
    rag_recipe: null,
    default_model: 'test-model',
    acts: [{ name: 'Act 1' }],
    chapters: [
      {
        path: 'chapters/01_Chapter_01',
        meta_path: 'chapters/01_Chapter_01/chapter.md',
        slug: '01_Chapter_01',
        kind: 'chapter',
        title: 'Chapter One',
        summary: null,
        chapter: 1,
        interlude: null,
        order: 1,
        pov: null,
        status: null,
        words_target: null,
        act: 'Act 1',
        scenes: [
          makeScene({ path: 'chapters/01_Chapter_01/01.md', order: 1, scene: 1 }),
          makeScene({ path: 'chapters/01_Chapter_01/02.md', order: 2, scene: 2 }),
          makeScene({ path: 'chapters/01_Chapter_01/03.md', order: 3, scene: 3 }),
        ],
        word_count: 0,
      },
      {
        path: 'chapters/02_Chapter_02',
        meta_path: 'chapters/02_Chapter_02/chapter.md',
        slug: '02_Chapter_02',
        kind: 'chapter',
        title: 'Chapter Two',
        summary: null,
        chapter: 2,
        interlude: null,
        order: 2,
        pov: null,
        status: null,
        words_target: null,
        act: 'Act 1',
        scenes: [
          makeScene({ path: 'chapters/02_Chapter_02/01.md', order: 1, scene: 1 }),
          makeScene({ path: 'chapters/02_Chapter_02/02.md', order: 2, scene: 2 }),
        ],
        word_count: 0,
      },
    ],
    categories: [],
  };
}

describe('parseSceneZoneId', () => {
  it('extracts chapter slug from scene-zone id', () => {
    expect(parseSceneZoneId('scene-zone:01_Chapter_01')).toBe('01_Chapter_01');
  });

  it('returns null for non-zone ids', () => {
    expect(parseSceneZoneId('chapters/01_Chapter_01/01.md')).toBeNull();
  });
});

describe('isSceneZone', () => {
  it('returns true for scene-zone ids', () => {
    expect(isSceneZone('scene-zone:02_Chapter_02')).toBe(true);
  });

  it('returns false for scene paths', () => {
    expect(isSceneZone('chapters/01_Chapter_01/01.md')).toBe(false);
  });
});

describe('resolveSceneMove', () => {
  it('returns SameChapterMove for same-chapter scene drop', () => {
    const tree = makeTestTree();
    const result = resolveSceneMove(
      tree,
      'chapters/01_Chapter_01/03.md',
      'chapters/01_Chapter_01/01.md',
    );

    expect(result).not.toBeNull();
    const r = result!;
    expect(r.kind).toBe('same-chapter');
    if (r.kind !== 'same-chapter') return;
    expect(r.chapterSlug).toBe('01_Chapter_01');
    expect(r.reorderedScenes).toHaveLength(3);
    expect(r.reorderedScenes[0].path).toBe('chapters/01_Chapter_01/03.md');
    expect(r.reorderedScenes[0].order).toBe(1);
    expect(r.reorderedScenes[1].path).toBe('chapters/01_Chapter_01/01.md');
    expect(r.reorderedScenes[1].order).toBe(2);
    expect(r.reorderedScenes[2].path).toBe('chapters/01_Chapter_01/02.md');
    expect(r.reorderedScenes[2].order).toBe(3);
  });

  it('returns SameChapterMove with append for same-chapter scene-zone drop', () => {
    const tree = makeTestTree();
    const result = resolveSceneMove(
      tree,
      'chapters/01_Chapter_01/01.md',
      'scene-zone:01_Chapter_01',
    );

    expect(result).not.toBeNull();
    const r = result!;
    expect(r.kind).toBe('same-chapter');
    if (r.kind !== 'same-chapter') return;
    const paths = r.reorderedScenes.map(s => s.path);
    expect(paths[0]).toBe('chapters/01_Chapter_01/02.md');
    expect(paths[1]).toBe('chapters/01_Chapter_01/03.md');
    expect(paths[2]).toBe('chapters/01_Chapter_01/01.md');
  });

  it('returns CrossChapterMove for cross-chapter scene drop', () => {
    const tree = makeTestTree();
    const result = resolveSceneMove(
      tree,
      'chapters/01_Chapter_01/02.md',
      'chapters/02_Chapter_02/01.md',
    );

    expect(result).not.toBeNull();
    const r = result!;
    expect(r.kind).toBe('cross-chapter');
    if (r.kind !== 'cross-chapter') return;
    expect(r.srcPath).toBe('chapters/01_Chapter_01/02.md');
    expect(r.dstChapterSlug).toBe('02_Chapter_02');
    expect(r.srcOrder).toEqual([
      { path: 'chapters/01_Chapter_01/01.md', order: 1 },
      { path: 'chapters/01_Chapter_01/03.md', order: 2 },
    ]);
    expect(r.dstOrder).toEqual([
      { path: 'chapters/01_Chapter_01/02.md', order: 1 },
      { path: 'chapters/02_Chapter_02/01.md', order: 2 },
      { path: 'chapters/02_Chapter_02/02.md', order: 3 },
    ]);
  });

  it('returns CrossChapterMove with append for scene-zone drop', () => {
    const tree = makeTestTree();
    const result = resolveSceneMove(
      tree,
      'chapters/01_Chapter_01/01.md',
      'scene-zone:02_Chapter_02',
    );

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('cross-chapter');
    if (result === null || result.kind !== 'cross-chapter') return;
    expect(result.dstChapterSlug).toBe('02_Chapter_02');
    expect(result.dstOrder).toEqual([
      { path: 'chapters/02_Chapter_02/01.md', order: 1 },
      { path: 'chapters/02_Chapter_02/02.md', order: 2 },
      { path: 'chapters/01_Chapter_01/01.md', order: 3 },
    ]);
  });

  it('returns null for unknown active scene path', () => {
    const tree = makeTestTree();
    expect(resolveSceneMove(tree, 'nonexistent.md', 'chapters/01_Chapter_01/01.md')).toBeNull();
  });

  it('returns null for unknown over id', () => {
    const tree = makeTestTree();
    expect(resolveSceneMove(tree, 'chapters/01_Chapter_01/01.md', 'nonexistent.md')).toBeNull();
  });

  it('returns null for scene-zone with unknown chapter slug', () => {
    const tree = makeTestTree();
    expect(resolveSceneMove(tree, 'chapters/01_Chapter_01/01.md', 'scene-zone:nonexistent')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import type { ChapterEntry, ProjectTree } from '../api';
import {
  actZoneId,
  groupChaptersByAct,
  resolveChapterReorder,
} from '../chapterDrag';

function makeChapter(overrides: Partial<ChapterEntry> = {}): ChapterEntry {
  const slug = overrides.slug ?? '01_Chapter_01';
  return {
    path: `chapters/${slug}`,
    meta_path: `chapters/${slug}/chapter.md`,
    slug,
    kind: 'chapter',
    title: null,
    summary: null,
    chapter: 1,
    interlude: null,
    order: 1,
    pov: null,
    status: null,
    words_target: null,
    act: null,
    scenes: [],
    word_count: 0,
    ...overrides,
  };
}

function makeTestTree(): ProjectTree {
  const ch1 = makeChapter({ slug: '01_Chapter_01', chapter: 1, act: 'Act 1' });
  const ch2 = makeChapter({ slug: '02_Chapter_02', chapter: 2, act: 'Act 1' });
  const ch3 = makeChapter({ slug: '03_Chapter_03', chapter: 3, act: 'Act 3' });
  const ch4 = makeChapter({ slug: '04_Chapter_04', chapter: 4, act: null });
  return {
    slug: 'test',
    title: 'Test',
    author: null,
    rag_recipe: null,
    default_model: 'test-model',
    acts: [{ name: 'Act 1' }, { name: 'Act 2' }, { name: 'Act 3' }],
    chapters: [ch1, ch2, ch3, ch4],
    categories: [],
  };
}

describe('groupChaptersByAct', () => {
  it('groups chapters into their acts in act order', () => {
    const tree = makeTestTree();
    const groups = groupChaptersByAct(tree, tree.chapters);
    expect(groups.map((g) => g.act?.name ?? null)).toEqual([
      'Act 1',
      'Act 2',
      'Act 3',
      null,
    ]);
    expect(groups[0].chapters.map((c) => c.slug)).toEqual([
      '01_Chapter_01',
      '02_Chapter_02',
    ]);
    expect(groups[1].chapters).toEqual([]);
    expect(groups[2].chapters.map((c) => c.slug)).toEqual(['03_Chapter_03']);
    expect(groups[3].chapters.map((c) => c.slug)).toEqual(['04_Chapter_04']);
  });

  it('omits the trailing unassigned group when empty by default', () => {
    const tree = makeTestTree();
    const chaptersWithoutUnassigned = tree.chapters.filter((c) => c.act);
    const groups = groupChaptersByAct(tree, chaptersWithoutUnassigned);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.act !== null)).toBe(true);
  });

  it('always appends the unassigned group when alwaysIncludeUnassigned is set', () => {
    const tree = makeTestTree();
    const chaptersWithoutUnassigned = tree.chapters.filter((c) => c.act);
    const groups = groupChaptersByAct(tree, chaptersWithoutUnassigned, {
      alwaysIncludeUnassigned: true,
    });
    expect(groups).toHaveLength(4);
    expect(groups[3]).toEqual({ act: null, chapters: [] });
  });

  it('returns a single ungrouped bucket when the project has no acts', () => {
    const tree = makeTestTree();
    tree.acts = [];
    const groups = groupChaptersByAct(tree, tree.chapters);
    expect(groups).toEqual([{ act: null, chapters: tree.chapters }]);
  });
});

describe('resolveChapterReorder', () => {
  const actZonePrefix = 'act-zone:';

  it('reorders within the same act when dropped on a card', () => {
    const tree = makeTestTree();
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/01_Chapter_01',
      'chapters/02_Chapter_02',
      { actZonePrefix },
    );
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.chapters.map((c) => c.slug)).toEqual([
      '02_Chapter_02',
      '01_Chapter_01',
      '03_Chapter_03',
      '04_Chapter_04',
    ]);
    expect(r.payload.every((p) => p.act === undefined)).toBe(true);
  });

  it('moves to a different act and stamps the act on the moved chapter when dropped on a card', () => {
    const tree = makeTestTree();
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/04_Chapter_04',
      'chapters/03_Chapter_03',
      { actZonePrefix },
    );
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.chapters.map((c) => c.slug)).toEqual([
      '01_Chapter_01',
      '02_Chapter_02',
      '04_Chapter_04',
      '03_Chapter_03',
    ]);
    const moved = r.payload.find((p) => p.path.includes('04_Chapter_04'));
    expect(moved?.act).toBe('Act 3');
    const unmoved = r.payload.find((p) => p.path.includes('03_Chapter_03'));
    expect(unmoved?.act).toBeUndefined();
  });

  it('drops into an empty act zone: inserts at the act position', () => {
    const tree = makeTestTree();
    const overId = actZoneId(actZonePrefix, 'Act 2');
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/03_Chapter_03',
      overId,
      { actZonePrefix, groupOpts: { alwaysIncludeUnassigned: true } },
    );
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.chapters.map((c) => c.slug)).toEqual([
      '01_Chapter_01',
      '02_Chapter_02',
      '03_Chapter_03',
      '04_Chapter_04',
    ]);
    const moved = r.payload.find((p) => p.path.includes('03_Chapter_03'));
    expect(moved?.act).toBe('Act 2');
  });

  it('drops into an empty act zone: cursor decrements past the source when it precedes the target', () => {
    const tree = makeTestTree();
    const overId = actZoneId(actZonePrefix, 'Act 2');
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/01_Chapter_01',
      overId,
      { actZonePrefix, groupOpts: { alwaysIncludeUnassigned: true } },
    );
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.chapters.map((c) => c.slug)).toEqual([
      '02_Chapter_02',
      '01_Chapter_01',
      '03_Chapter_03',
      '04_Chapter_04',
    ]);
    const moved = r.payload.find((p) => p.path.includes('01_Chapter_01'));
    expect(moved?.act).toBe('Act 2');
  });

  it('returns null for an unknown active chapter path', () => {
    const tree = makeTestTree();
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/nonexistent',
      'chapters/01_Chapter_01',
      { actZonePrefix },
    );
    expect(result).toBeNull();
  });

  it('returns null when dropped on itself', () => {
    const tree = makeTestTree();
    const result = resolveChapterReorder(
      tree,
      tree.chapters,
      'chapters/01_Chapter_01',
      'chapters/01_Chapter_01',
      { actZonePrefix },
    );
    expect(result).toBeNull();
  });
});

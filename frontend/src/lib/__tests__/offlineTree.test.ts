import { describe, it, expect } from 'vitest';
import type { ProjectTree, ChapterEntry, SceneEntry } from '../api';
import {
  addChapterToTree,
  addSceneToTree,
  addCategoryEntryToTree,
  removeChapterFromTree,
  applyReorderToTree,
  remapTempPaths,
  isOfflinePath,
  moveSceneInTree,
} from '../offlineTree';

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

function makeTree(): ProjectTree {
  const chapter: ChapterEntry = {
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
    scenes: [makeScene()],
    word_count: 0,
  };

  return {
    slug: 'the-example-novel',
    title: 'The Example Novel',
    author: 'Author',
    rag_recipe: null,
    default_model: 'claude-3-7-sonnet',
    acts: [{ name: 'Act 1' }],
    chapters: [chapter],
    categories: [
      {
        name: 'Characters',
        folder: 'characters',
        codex: true,
        entries: [
          {
            path: 'characters/asha.md',
            title: 'Asha',
            aliases: [],
            tags: [],
            order: null,
          },
        ],
      },
    ],
  };
}

describe('addChapterToTree', () => {
  it('adds a chapter with temp slug and correct order', () => {
    const tree = makeTree();
    const { tree: t, metaPath, scenePath } = addChapterToTree(tree, {
      tempId: 'abc123',
      kind: 'chapter',
      act: 'Act 1',
    });

    expect(t.chapters).toHaveLength(2);
    const added = t.chapters[1];
    expect(added.slug).toBe('_offline_abc123');
    expect(added.order).toBe(2); // max(1) + 1
    expect(added.chapter).toBe(2); // max chapter ordinal (1) + 1
    expect(added.interlude).toBeNull();
    expect(added.kind).toBe('chapter');
    expect(added.act).toBe('Act 1');
    expect(metaPath).toBe('chapters/_offline_abc123/chapter.md');
    expect(scenePath).toContain('chapters/_offline_abc123/');
    expect(t.chapters[0]).toEqual(tree.chapters[0]); // original unchanged
  });

  it('assigns interlude ordinal for interlude kind', () => {
    const tree = makeTree();
    const { tree: t } = addChapterToTree(tree, {
      tempId: 'int1',
      kind: 'interlude',
      act: 'Act 1',
    });

    const added = t.chapters[1];
    expect(added.kind).toBe('interlude');
    expect(added.chapter).toBeNull();
    expect(added.interlude).toBe(1); // first interlude
  });

  it('assigns correct interlude ordinal when interludes already exist', () => {
    const base = makeTree();
    // Add an existing interlude first
    const existingInterlude: ChapterEntry = {
      path: 'chapters/02_Interlude_01',
      meta_path: 'chapters/02_Interlude_01/chapter.md',
      slug: '02_Interlude_01',
      kind: 'interlude',
      title: null,
      summary: null,
      chapter: null,
      interlude: 1,
      order: 2,
      pov: null,
      status: null,
      words_target: null,
      act: 'Act 1',
      scenes: [],
      word_count: 0,
    };
    const tree = { ...base, chapters: [...base.chapters, existingInterlude] };
    const { tree: t } = addChapterToTree(tree, {
      tempId: 'int2',
      kind: 'interlude',
      act: 'Act 1',
    });

    const added = t.chapters.find(c => c.slug === '_offline_int2')!;
    expect(added.interlude).toBe(2);
    expect(added.order).toBe(3);
  });
});

describe('addSceneToTree', () => {
  it('appends scene to target chapter with correct order and scene number', () => {
    const tree = makeTree();
    const { tree: t, scenePath } = addSceneToTree(tree, '01_Chapter_01', 'sc999');

    const chapter = t.chapters[0];
    expect(chapter.scenes).toHaveLength(2);
    const added = chapter.scenes[1];
    expect(added.order).toBe(2);
    expect(added.scene).toBe(2);
    expect(added.path).toBe('chapters/01_Chapter_01/_offline_sc999.md');
    expect(scenePath).toBe('chapters/01_Chapter_01/_offline_sc999.md');
  });

  it('throws if chapter slug not found', () => {
    const tree = makeTree();
    expect(() => addSceneToTree(tree, 'nonexistent', 'x')).toThrow();
  });
});

describe('addCategoryEntryToTree', () => {
  it('appends entry to target category folder', () => {
    const tree = makeTree();
    const { tree: t, entryPath } = addCategoryEntryToTree(tree, 'characters', {
      tempId: 'ref1',
      title: 'Tarn',
    });

    const cat = t.categories[0];
    expect(cat.entries).toHaveLength(2);
    const added = cat.entries[1];
    expect(added.path).toBe('characters/_offline_ref1.md');
    expect(added.title).toBe('Tarn');
    expect(entryPath).toBe('characters/_offline_ref1.md');
  });

  it('throws if category folder not found', () => {
    const tree = makeTree();
    expect(() => addCategoryEntryToTree(tree, 'locations', { tempId: 'x', title: 'Y' })).toThrow();
  });
});

describe('removeChapterFromTree', () => {
  it('removes chapter by slug', () => {
    const tree = makeTree();
    const t = removeChapterFromTree(tree, '01_Chapter_01');
    expect(t.chapters).toHaveLength(0);
  });

  it('is a no-op for unknown slug', () => {
    const tree = makeTree();
    const t = removeChapterFromTree(tree, 'nope');
    expect(t.chapters).toHaveLength(1);
  });
});

describe('applyReorderToTree', () => {
  it('updates chapter order via meta_path match', () => {
    const tree = makeTree();
    const t = applyReorderToTree(tree, [
      { path: 'chapters/01_Chapter_01/chapter.md', order: 5 },
    ]);
    expect(t.chapters[0].order).toBe(5);
  });

  it('updates chapter act when provided', () => {
    const tree = makeTree();
    const t = applyReorderToTree(tree, [
      { path: 'chapters/01_Chapter_01/chapter.md', order: 1, act: 'Act 2' },
    ]);
    expect(t.chapters[0].act).toBe('Act 2');
  });

  it('updates scene order via scene path match', () => {
    const tree = makeTree();
    const t = applyReorderToTree(tree, [
      { path: 'chapters/01_Chapter_01/01.md', order: 7 },
    ]);
    expect(t.chapters[0].scenes[0].order).toBe(7);
  });
});

describe('remapTempPaths', () => {
  it('replaces temp slug and paths with real ones', () => {
    const base = makeTree();
    const { tree: withOffline } = addChapterToTree(base, {
      tempId: 'tmp1',
      kind: 'chapter',
      act: 'Act 1',
    });

    const t = remapTempPaths(withOffline, '_offline_tmp1', {
      slug: '03_Chapter_02',
      path: 'chapters/03_Chapter_02',
      meta_path: 'chapters/03_Chapter_02/chapter.md',
      first_scene_path: 'chapters/03_Chapter_02/01.md',
    });

    const remapped = t.chapters.find(c => c.slug === '03_Chapter_02');
    expect(remapped).toBeDefined();
    expect(remapped!.path).toBe('chapters/03_Chapter_02');
    expect(remapped!.meta_path).toBe('chapters/03_Chapter_02/chapter.md');
    expect(remapped!.scenes[0].path).toBe('chapters/03_Chapter_02/01.md');

    // Old temp slug gone
    expect(t.chapters.find(c => c.slug === '_offline_tmp1')).toBeUndefined();
  });
});

describe('isOfflinePath', () => {
  it('returns true for paths containing _offline_', () => {
    expect(isOfflinePath('chapters/_offline_abc/chapter.md')).toBe(true);
    expect(isOfflinePath('chapters/_offline_abc/01.md')).toBe(true);
  });

  it('returns false for normal paths', () => {
    expect(isOfflinePath('chapters/01_Chapter_01/01.md')).toBe(false);
    expect(isOfflinePath('characters/asha.md')).toBe(false);
  });
});

function makeTwoChapterTree(): ProjectTree {
  return {
    slug: 'the-example-novel',
    title: 'The Example Novel',
    author: 'Author',
    rag_recipe: null,
    default_model: 'claude-3-7-sonnet',
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
          makeScene({ path: 'chapters/01_Chapter_01/01.md', title: 'Opening', pov: 'Asha', status: 'draft', word_count: 500, order: 1, scene: 1 }),
          makeScene({ path: 'chapters/01_Chapter_01/02.md', title: 'Midpoint', order: 2, scene: 2 }),
        ],
        word_count: 500,
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
        ],
        word_count: 0,
      },
    ],
    categories: [],
  };
}

describe('moveSceneInTree', () => {
  it('moves a scene between chapters carrying forward all fields', () => {
    const tree = makeTwoChapterTree();
    const srcPath = 'chapters/01_Chapter_01/01.md';
    const srcOrder = [{ path: 'chapters/01_Chapter_01/02.md', order: 1 }];
    const dstOrder = [
      { path: 'chapters/02_Chapter_02/01.md', order: 1 },
      { path: srcPath, order: 2 },
    ];

    const { tree: result, tempScenePath } = moveSceneInTree(
      tree, srcPath, '02_Chapter_02', srcOrder, dstOrder, 'tmp1',
    );

    expect(tempScenePath).toBe('chapters/02_Chapter_02/_offline_tmp1.md');

    const ch1 = result.chapters[0];
    expect(ch1.scenes).toHaveLength(1);
    expect(ch1.scenes[0].path).toBe('chapters/01_Chapter_01/02.md');
    expect(ch1.scenes[0].order).toBe(1);

    const ch2 = result.chapters[1];
    expect(ch2.scenes).toHaveLength(2);
    expect(ch2.scenes[0].path).toBe('chapters/02_Chapter_02/01.md');
    expect(ch2.scenes[0].order).toBe(1);

    const moved = ch2.scenes[1];
    expect(moved.path).toBe(tempScenePath);
    expect(moved.order).toBe(2);
    expect(moved.title).toBe('Opening');
    expect(moved.pov).toBe('Asha');
    expect(moved.status).toBe('draft');
    expect(moved.word_count).toBe(500);
  });

  it('handles source chapter becoming empty', () => {
    const tree = makeTwoChapterTree();
    const singleSceneTree: ProjectTree = {
      ...tree,
      chapters: [
        { ...tree.chapters[0], scenes: [tree.chapters[0].scenes[0]] },
        tree.chapters[1],
      ],
    };
    const srcPath = 'chapters/01_Chapter_01/01.md';
    const dstOrder = [
      { path: 'chapters/02_Chapter_02/01.md', order: 1 },
      { path: srcPath, order: 2 },
    ];

    const { tree: result } = moveSceneInTree(
      singleSceneTree, srcPath, '02_Chapter_02', [], dstOrder, 'tmp2',
    );

    expect(result.chapters[0].scenes).toHaveLength(0);
    expect(result.chapters[0].slug).toBe('01_Chapter_01');
    expect(result.chapters[1].scenes).toHaveLength(2);
  });

  it('applies ordering correctly to both chapters', () => {
    const tree = makeTwoChapterTree();
    const srcPath = 'chapters/01_Chapter_01/02.md';
    const srcOrder = [{ path: 'chapters/01_Chapter_01/01.md', order: 1 }];
    const dstOrder = [
      { path: srcPath, order: 1 },
      { path: 'chapters/02_Chapter_02/01.md', order: 2 },
    ];

    const { tree: result } = moveSceneInTree(
      tree, srcPath, '02_Chapter_02', srcOrder, dstOrder, 'tmp3',
    );

    const ch1 = result.chapters[0];
    expect(ch1.scenes[0].order).toBe(1);

    const ch2 = result.chapters[1];
    const movedScene = ch2.scenes.find(s => s.path.includes('_offline_tmp3'));
    const existingScene = ch2.scenes.find(s => s.path === 'chapters/02_Chapter_02/01.md');
    expect(movedScene!.order).toBe(1);
    expect(existingScene!.order).toBe(2);
  });

  it('throws when source scene not found', () => {
    const tree = makeTwoChapterTree();
    expect(() =>
      moveSceneInTree(tree, 'nonexistent.md', '02_Chapter_02', [], [], 'x'),
    ).toThrow('Scene not found');
  });

  it('throws when destination chapter not found', () => {
    const tree = makeTwoChapterTree();
    expect(() =>
      moveSceneInTree(tree, 'chapters/01_Chapter_01/01.md', 'nonexistent', [], [], 'x'),
    ).toThrow('Chapter not found');
  });

  it('throws when source and destination chapter are the same', () => {
    const tree = makeTwoChapterTree();
    expect(() =>
      moveSceneInTree(tree, 'chapters/01_Chapter_01/01.md', '01_Chapter_01', [], [], 'x'),
    ).toThrow('Cannot move scene within same chapter');
  });
});

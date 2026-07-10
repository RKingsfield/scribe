import type { ProjectTree, ChapterEntry, SceneEntry, ReferenceEntry } from './api';

export interface AddChapterOpts {
  tempId: string;
  kind: 'chapter' | 'interlude';
  act?: string;
  title?: string;
}

export interface AddChapterResult {
  tree: ProjectTree;
  metaPath: string;
  scenePath: string;
}

// Mirrors backend slug logic in storage/helpers.py — keep in sync or offline creates will mismatch until reconnect remap.
export function addChapterToTree(
  tree: ProjectTree,
  opts: AddChapterOpts,
): AddChapterResult {
  const tempSlug = `_offline_${opts.tempId}`;
  const maxOrder = tree.chapters.reduce((m, c) => Math.max(m, c.order ?? 0), 0);
  const order = maxOrder + 1;

  let ordinal: number | null;
  if (opts.kind === 'chapter') {
    const maxChapter = tree.chapters
      .filter(c => c.kind === 'chapter')
      .reduce((m, c) => Math.max(m, c.chapter ?? 0), 0);
    ordinal = maxChapter + 1;
  } else {
    const maxInterlude = tree.chapters
      .filter(c => c.kind === 'interlude')
      .reduce((m, c) => Math.max(m, c.interlude ?? 0), 0);
    ordinal = maxInterlude + 1;
  }

  const sceneId = crypto.randomUUID().slice(0, 8);
  const scenePath = `chapters/${tempSlug}/${sceneId}.md`;

  const scene: SceneEntry = {
    path: scenePath,
    title: null,
    summary: null,
    scene: 1,
    order: 1,
    pov: null,
    status: null,
    words_target: null,
    word_count: 0,
  };

  const chapter: ChapterEntry = {
    path: `chapters/${tempSlug}`,
    meta_path: `chapters/${tempSlug}/chapter.md`,
    slug: tempSlug,
    kind: opts.kind,
    title: opts.title ?? null,
    summary: null,
    chapter: opts.kind === 'chapter' ? ordinal : null,
    interlude: opts.kind === 'interlude' ? ordinal : null,
    order,
    pov: null,
    status: null,
    words_target: null,
    act: opts.act ?? null,
    scenes: [scene],
    word_count: 0,
  };

  return {
    tree: { ...tree, chapters: [...tree.chapters, chapter] },
    metaPath: `chapters/${tempSlug}/chapter.md`,
    scenePath,
  };
}

export interface AddSceneResult {
  tree: ProjectTree;
  scenePath: string;
}

export function addSceneToTree(
  tree: ProjectTree,
  chapterSlug: string,
  tempId: string,
): AddSceneResult {
  const idx = tree.chapters.findIndex(c => c.slug === chapterSlug);
  if (idx === -1) throw new Error(`Chapter not found: ${chapterSlug}`);

  const chapter = tree.chapters[idx];
  const maxOrder = chapter.scenes.reduce((m, s) => Math.max(m, s.order ?? 0), 0);
  const maxScene = chapter.scenes.reduce((m, s) => Math.max(m, s.scene ?? 0), 0);
  const scenePath = `chapters/${chapterSlug}/_offline_${tempId}.md`;

  const scene: SceneEntry = {
    path: scenePath,
    title: null,
    summary: null,
    scene: maxScene + 1,
    order: maxOrder + 1,
    pov: null,
    status: null,
    words_target: null,
    word_count: 0,
  };

  const updated: ChapterEntry = { ...chapter, scenes: [...chapter.scenes, scene] };
  const chapters = [...tree.chapters];
  chapters[idx] = updated;

  return { tree: { ...tree, chapters }, scenePath };
}

export interface AddCategoryEntryOpts {
  tempId: string;
  title: string;
}

export interface AddCategoryEntryResult {
  tree: ProjectTree;
  entryPath: string;
}

export function addCategoryEntryToTree(
  tree: ProjectTree,
  folder: string,
  opts: AddCategoryEntryOpts,
): AddCategoryEntryResult {
  const idx = tree.categories.findIndex(c => c.folder === folder);
  if (idx === -1) throw new Error(`Category not found: ${folder}`);

  const entryPath = `${folder}/_offline_${opts.tempId}.md`;
  const entry: ReferenceEntry = {
    path: entryPath,
    title: opts.title,
    aliases: [],
    tags: [],
    order: null,
  };

  const cat = tree.categories[idx];
  const updated = { ...cat, entries: [...cat.entries, entry] };
  const categories = [...tree.categories];
  categories[idx] = updated;

  return { tree: { ...tree, categories }, entryPath };
}

export function removeChapterFromTree(tree: ProjectTree, chapterSlug: string): ProjectTree {
  return { ...tree, chapters: tree.chapters.filter(c => c.slug !== chapterSlug) };
}

export interface ReorderItem {
  path: string;
  order: number;
  act?: string | null;
}

export function applyReorderToTree(tree: ProjectTree, items: ReorderItem[]): ProjectTree {
  const byPath = new Map(items.map(i => [i.path, i]));

  const chapters = tree.chapters.map(ch => {
    const chapterUpdate = byPath.get(ch.meta_path);
    const updatedScenes = ch.scenes.map(s => {
      const sceneUpdate = byPath.get(s.path);
      if (!sceneUpdate) return s;
      return { ...s, order: sceneUpdate.order };
    });

    if (!chapterUpdate) return { ...ch, scenes: updatedScenes };
    return {
      ...ch,
      scenes: updatedScenes,
      order: chapterUpdate.order,
      ...(chapterUpdate.act !== undefined ? { act: chapterUpdate.act ?? null } : {}),
    };
  });

  return { ...tree, chapters };
}

export interface MoveSceneResult {
  tree: ProjectTree;
  tempScenePath: string;
}

export function moveSceneInTree(
  tree: ProjectTree,
  srcPath: string,
  dstChapterSlug: string,
  srcOrder: { path: string; order: number }[],
  dstOrder: { path: string; order: number }[],
  tempId: string,
): MoveSceneResult {
  let srcChapterIdx = -1;
  let srcSceneIdx = -1;
  for (let ci = 0; ci < tree.chapters.length; ci++) {
    const si = tree.chapters[ci].scenes.findIndex(s => s.path === srcPath);
    if (si !== -1) {
      srcChapterIdx = ci;
      srcSceneIdx = si;
      break;
    }
  }
  if (srcChapterIdx === -1) throw new Error(`Scene not found: ${srcPath}`);

  const dstChapterIdx = tree.chapters.findIndex(c => c.slug === dstChapterSlug);
  if (dstChapterIdx === -1) throw new Error(`Chapter not found: ${dstChapterSlug}`);
  if (srcChapterIdx === dstChapterIdx) throw new Error('Cannot move scene within same chapter');

  const movedScene = { ...tree.chapters[srcChapterIdx].scenes[srcSceneIdx] };
  const tempScenePath = `chapters/${dstChapterSlug}/_offline_${tempId}.md`;

  const srcOrderMap = new Map(srcOrder.map(i => [i.path, i.order]));
  const srcScenes = tree.chapters[srcChapterIdx].scenes
    .filter((_, i) => i !== srcSceneIdx)
    .map(s => {
      const newOrder = srcOrderMap.get(s.path);
      return newOrder !== undefined ? { ...s, order: newOrder } : s;
    });

  const dstOrderMap = new Map(dstOrder.map(i => [i.path, i.order]));
  const dstScenes = [...tree.chapters[dstChapterIdx].scenes, movedScene]
    .map(s => {
      const newOrder = dstOrderMap.get(s.path);
      return newOrder !== undefined ? { ...s, order: newOrder } : s;
    })
    .map(s => s.path === srcPath ? { ...s, path: tempScenePath } : s);

  const chapters = tree.chapters.map((ch, i) => {
    if (i === srcChapterIdx) return { ...ch, scenes: srcScenes };
    if (i === dstChapterIdx) return { ...ch, scenes: dstScenes };
    return ch;
  });

  return { tree: { ...tree, chapters }, tempScenePath };
}

export interface RemapTarget {
  slug: string;
  path: string;
  meta_path: string;
  first_scene_path: string;
}

export function remapTempPaths(
  tree: ProjectTree,
  tempSlug: string,
  target: RemapTarget,
): ProjectTree {
  const chapters = tree.chapters.map(ch => {
    if (ch.slug !== tempSlug) return ch;

    const tempChapterDir = ch.path;
    const scenes = ch.scenes.map((s, i) => {
      if (i === 0) return { ...s, path: target.first_scene_path };
      // Replace the temp chapter dir prefix for any additional scenes
      const newPath = s.path.replace(tempChapterDir, target.path);
      return { ...s, path: newPath };
    });

    return {
      ...ch,
      slug: target.slug,
      path: target.path,
      meta_path: target.meta_path,
      scenes,
    };
  });

  return { ...tree, chapters };
}

export function isOfflinePath(path: string): boolean {
  return path.includes('_offline_');
}

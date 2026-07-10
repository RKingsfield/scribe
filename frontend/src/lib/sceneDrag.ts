import type { ProjectTree, ChapterEntry, SceneEntry } from './api';

export interface SameChapterMove {
  kind: 'same-chapter';
  chapterSlug: string;
  reorderedScenes: { path: string; order: number }[];
}

export interface CrossChapterMove {
  kind: 'cross-chapter';
  srcPath: string;
  dstChapterSlug: string;
  srcOrder: { path: string; order: number }[];
  dstOrder: { path: string; order: number }[];
}

const SCENE_ZONE_PREFIX = 'scene-zone:';

export function isSceneZone(id: string): boolean {
  return id.startsWith(SCENE_ZONE_PREFIX);
}

export function parseSceneZoneId(id: string): string | null {
  if (!id.startsWith(SCENE_ZONE_PREFIX)) return null;
  return id.slice(SCENE_ZONE_PREFIX.length);
}

export function resolveSceneMove(
  tree: ProjectTree,
  activeScenePath: string,
  overId: string,
): SameChapterMove | CrossChapterMove | null {
  let srcChapter: ChapterEntry | undefined;
  let srcScene: SceneEntry | undefined;
  for (const ch of tree.chapters) {
    const s = ch.scenes.find(sc => sc.path === activeScenePath);
    if (s) {
      srcChapter = ch;
      srcScene = s;
      break;
    }
  }
  if (!srcChapter || !srcScene) return null;

  let dstChapter: ChapterEntry | undefined;
  let overIdx: number;

  const zoneSlug = parseSceneZoneId(overId);
  if (zoneSlug !== null) {
    dstChapter = tree.chapters.find(c => c.slug === zoneSlug);
    if (!dstChapter) return null;
    overIdx = -1;
  } else {
    for (const ch of tree.chapters) {
      const si = ch.scenes.findIndex(s => s.path === overId);
      if (si !== -1) {
        dstChapter = ch;
        overIdx = si;
        break;
      }
    }
    if (!dstChapter) return null;
  }

  if (srcChapter.slug === dstChapter.slug) {
    const scenes = [...srcChapter.scenes];
    const srcIdx = scenes.findIndex(s => s.path === activeScenePath);

    let targetIdx: number;
    if (zoneSlug !== null) {
      targetIdx = scenes.length - 1;
    } else {
      targetIdx = overIdx!;
    }

    const [moved] = scenes.splice(srcIdx, 1);
    scenes.splice(targetIdx < 0 ? scenes.length + targetIdx : targetIdx, 0, moved);

    return {
      kind: 'same-chapter',
      chapterSlug: srcChapter.slug,
      reorderedScenes: scenes.map((s, i) => ({ path: s.path, order: i + 1 })),
    };
  }

  const remainingSrc = srcChapter.scenes.filter(s => s.path !== activeScenePath);
  const srcOrder = remainingSrc.map((s, i) => ({ path: s.path, order: i + 1 }));

  const dstScenes = [...dstChapter.scenes];
  if (zoneSlug !== null) {
    dstScenes.push(srcScene);
  } else {
    dstScenes.splice(overIdx!, 0, srcScene);
  }
  const dstOrder = dstScenes.map((s, i) => ({ path: s.path, order: i + 1 }));

  return {
    kind: 'cross-chapter',
    srcPath: activeScenePath,
    dstChapterSlug: dstChapter.slug,
    srcOrder,
    dstOrder,
  };
}

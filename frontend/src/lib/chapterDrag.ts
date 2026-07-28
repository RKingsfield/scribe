import type { Act, ChapterEntry, ProjectTree } from './api';
import { arrayMove } from '@dnd-kit/sortable';

export interface ActGroup {
  act: Act | null;
  chapters: ChapterEntry[];
}

export interface GroupChaptersOptions {
  alwaysIncludeUnassigned?: boolean;
}

export function groupChaptersByAct(
  tree: ProjectTree,
  chapters: ChapterEntry[],
  opts: GroupChaptersOptions = {},
): ActGroup[] {
  const groups: ActGroup[] = tree.acts.map((a) => ({ act: a, chapters: [] }));
  const unassigned: ChapterEntry[] = [];

  for (const c of chapters) {
    if (c.act) {
      const idx = tree.acts.findIndex((a) => a.name === c.act);
      if (idx !== -1) {
        groups[idx].chapters.push(c);
        continue;
      }
    }
    unassigned.push(c);
  }

  if (tree.acts.length === 0) return [{ act: null, chapters }];
  if (opts.alwaysIncludeUnassigned || unassigned.length > 0) {
    groups.push({ act: null, chapters: unassigned });
  }
  return groups;
}

export const SIDEBAR_ACT_ZONE_PREFIX = 'act-zone:';
export const OUTLINE_ACT_ZONE_PREFIX = 'outline-act-zone:';

export function actZoneId(prefix: string, actName: string | null): string {
  return `${prefix}${actName ?? '__unassigned'}`;
}

function actNameFromZone(prefix: string, id: string): string | null {
  const name = id.slice(prefix.length);
  return name === '__unassigned' ? null : name;
}

export interface ChapterReorderResult {
  chapters: ChapterEntry[];
  payload: { path: string; order: number; act?: string | null }[];
}

export interface ResolveChapterReorderOptions {
  actZonePrefix: string;
  groupOpts?: GroupChaptersOptions;
}

export function resolveChapterReorder(
  tree: ProjectTree,
  chapters: ChapterEntry[],
  activeId: string,
  overId: string,
  opts: ResolveChapterReorderOptions,
): ChapterReorderResult | null {
  const sourceChapter = chapters.find((c) => c.path === activeId);
  if (!sourceChapter) return null;

  const groups = groupChaptersByAct(tree, chapters, opts.groupOpts);
  const findActFor = (ch: ChapterEntry): string | null =>
    groups.find((g) => g.chapters.some((c) => c.path === ch.path))?.act?.name ?? null;
  const sourceAct = findActFor(sourceChapter);

  let next: ChapterEntry[];
  let targetAct: string | null;

  if (overId.startsWith(opts.actZonePrefix)) {
    targetAct = actNameFromZone(opts.actZonePrefix, overId);
    const remaining = chapters.filter((c) => c.path !== sourceChapter.path);
    const targetGroupIdx = groups.findIndex((g) => (g.act?.name ?? null) === targetAct);
    let insertAt = remaining.length;
    if (targetGroupIdx !== -1) {
      const targetGroup = groups[targetGroupIdx];
      if (targetGroup.chapters.length > 0) {
        const last = targetGroup.chapters[targetGroup.chapters.length - 1];
        insertAt = remaining.findIndex((c) => c.path === last.path) + 1;
      } else {
        let cursor = 0;
        for (let i = 0; i < targetGroupIdx; i++) cursor += groups[i].chapters.length;
        const oldIndex = chapters.findIndex((c) => c.path === sourceChapter.path);
        if (oldIndex >= 0 && oldIndex < cursor) cursor -= 1;
        insertAt = cursor;
      }
    }
    next = [...remaining];
    next.splice(insertAt, 0, sourceChapter);
  } else {
    const targetChapter = chapters.find((c) => c.path === overId);
    if (!targetChapter || sourceChapter.path === targetChapter.path) return null;
    targetAct = findActFor(targetChapter);
    const oldIndex = chapters.findIndex((c) => c.path === sourceChapter.path);
    const newIndex = chapters.findIndex((c) => c.path === targetChapter.path);
    next = arrayMove(chapters, oldIndex, newIndex);
  }

  const actChanged = sourceAct !== targetAct;
  const payload = next.map((c, i) => {
    const item: { path: string; order: number; act?: string | null } = {
      path: c.meta_path,
      order: i + 1,
    };
    if (actChanged && c.path === sourceChapter.path) {
      item.act = targetAct ?? '';
    }
    return item;
  });

  return { chapters: next, payload };
}

export type SceneStatus = 'draft' | 'revision' | 'final';

export function statusClass(s: string | null | undefined): SceneStatus {
  if (s === 'revision') return 'revision';
  if (s === 'final') return 'final';
  return 'draft';
}

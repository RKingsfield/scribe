export type EntryKind = 'chapter' | 'scene' | 'reference';

export function detectKind(path: string): EntryKind {
  if (path.startsWith('chapters/')) {
    return path.endsWith('/chapter.md') ? 'chapter' : 'scene';
  }
  return 'reference';
}

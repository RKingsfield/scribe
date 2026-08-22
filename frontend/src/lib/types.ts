export interface SceneFrontmatter {
  title?: string;
  summary?: string;
  pov?: string;
  status?: string;
  order?: number;
  words_target?: number;
  scene?: number;
  [key: string]: unknown;
}

export interface ChapterFrontmatter {
  title?: string;
  summary?: string;
  kind?: 'chapter' | 'interlude';
  chapter?: number;
  interlude?: number;
  order?: number;
  act?: string;
  [key: string]: unknown;
}

export interface ReferenceFrontmatter {
  title?: string;
  aliases?: string[];
  tags?: string[];
  order?: number;
  [key: string]: unknown;
}

export interface NewChapterPayload {
  kind?: 'chapter' | 'interlude';
  act?: string;
  title?: string;
  chapter?: number;
  slug?: string;
}

export interface NewScenePayload {
  chapterSlug: string;
  title?: string;
  order?: number;
}

export interface NewCategoryEntryPayload {
  folder: string;
  title: string;
  slug?: string;
}

export interface DeleteChapterPayload {
  chapterSlug: string;
}

// baseEtag is the server etag the local copy was last known to match; replay sends it
// as If-Match so a delete queued offline can't destroy another device's newer edit.
export interface DeleteScenePayload {
  path: string;
  baseEtag?: string;
}

export interface DeleteCategoryEntryPayload {
  path: string;
  baseEtag?: string;
}

export interface ReorderPayload {
  items: { path: string; order: number; act?: string | null }[];
}

export interface MoveScenePayload {
  srcPath: string;
  dstChapterSlug: string;
  srcOrder: { path: string; order: number }[];
  dstOrder: { path: string; order: number }[];
}

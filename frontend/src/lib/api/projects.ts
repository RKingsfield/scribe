import {
  jsonOrThrow,
  assertOk,
  type Act,
  type Category,
  type ProjectTree,
  type ProjectListItem,
  type FileGet,
  type FilePutResult,
  type ServerConflictEntry,
} from './common';

export async function listProjects(signal?: AbortSignal): Promise<ProjectListItem[]> {
  return jsonOrThrow(await fetch('/api/projects', { signal }));
}

export async function getProject(slug: string): Promise<ProjectTree> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}`));
}

export interface ProjectConfig {
  title: string;
  author: string | null;
  slug: string;
  rag_recipe: string | null;
  default_model: string;
  acts: Act[];
  categories: Category[] | null;
}

export async function updateProject(
  slug: string,
  payload: Partial<{ title: string; author: string; rag_recipe: string; default_model: string; acts: Act[]; categories: Category[] }>,
): Promise<ProjectConfig> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function initProject(
  slug: string,
  payload: { title: string; author?: string },
): Promise<ProjectConfig> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function getFile(slug: string, path: string): Promise<FileGet> {
  return jsonOrThrow(
    await fetch(
      `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function putFile(
  slug: string,
  path: string,
  payload: { body: string; frontmatter: Record<string, unknown> },
  ifMatch?: string,
  opts?: { onConflict?: 'save-as-conflict'; deviceId?: string },
): Promise<FilePutResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch) headers['If-Match'] = ifMatch;
  if (opts?.onConflict) headers['X-On-Conflict'] = opts.onConflict;
  if (opts?.deviceId) headers['X-Device-Id'] = opts.deviceId;
  return jsonOrThrow(
    await fetch(
      `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      },
    ),
  );
}

export async function listServerConflicts(slug: string): Promise<ServerConflictEntry[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/conflicts`);
  const data = await jsonOrThrow<{ conflicts: ServerConflictEntry[] }>(r);
  return data.conflicts;
}

export async function discardServerConflict(slug: string, path: string): Promise<void> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/conflicts?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
  await assertOk(r);
}

export async function deleteFile(
  slug: string,
  path: string,
  opts?: { tolerate404?: boolean; ifMatch?: string },
): Promise<void> {
  const headers: Record<string, string> = {};
  if (opts?.ifMatch) headers['If-Match'] = opts.ifMatch;
  const r = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE', headers },
  );
  // Idempotent replay: an already-deleted file is success, not a blocked queue.
  if (opts?.tolerate404 && r.status === 404) return;
  await assertOk(r);
}

export async function newChapter(
  slug: string,
  payload: {
    chapter?: number;
    title?: string;
    slug?: string;
    act?: string;
    kind?: 'chapter' | 'interlude';
  },
): Promise<{
  slug: string;
  path: string;
  meta_path: string;
  first_scene_path: string;
  kind: 'chapter' | 'interlude';
  chapter: number | null;
  interlude: number | null;
  position: number;
}> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/chapter/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function deleteChapter(slug: string, chapterSlug: string): Promise<void> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(chapterSlug)}`,
    { method: 'DELETE' },
  );
  await assertOk(r);
}

export async function newScene(
  slug: string,
  chapterSlug: string,
  payload: { title?: string; order?: number },
): Promise<{ scene: number; path: string }> {
  return jsonOrThrow(
    await fetch(
      `/api/projects/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(chapterSlug)}/scene/new`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ),
  );
}

export async function newCategoryEntry(
  slug: string,
  folder: string,
  payload: { title: string; slug?: string },
): Promise<{ path: string; title: string }> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/category/${encodeURIComponent(folder)}/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function moveScene(
  slug: string,
  payload: {
    src_path: string;
    dst_chapter_slug: string;
    src_order: { path: string; order: number }[];
    dst_order: { path: string; order: number }[];
  },
): Promise<{ new_path: string; scene: number }> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/scene/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function reorder(
  slug: string,
  items: { path: string; order: number; act?: string | null }[],
): Promise<{ updated: string[]; count: number }> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
  );
}

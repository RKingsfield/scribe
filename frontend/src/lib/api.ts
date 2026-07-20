export interface ProjectListItem {
  slug: string;
  title: string;
}

export interface Act {
  name: string;
}

export interface SceneEntry {
  path: string;
  title: string | null;
  summary: string | null;
  scene: number | null;
  order: number | null;
  pov: string | null;
  status: string | null;
  words_target: number | null;
  word_count: number;
}

export interface ChapterEntry {
  path: string;       // directory, e.g. "chapters/17_Chapter_16"
  meta_path: string;  // ".../chapter.md"
  slug: string;
  kind: 'chapter' | 'interlude';
  title: string | null;
  summary: string | null;
  chapter: number | null;     // ordinal among chapters
  interlude: number | null;   // ordinal among interludes
  order: number | null;
  pov: string | null;
  status: string | null;
  words_target: number | null;
  act: string | null;
  scenes: SceneEntry[];
  word_count: number;
}

export interface ReferenceEntry {
  path: string;
  title: string | null;
  aliases: string[];
  tags: string[];
  order: number | null;
}

export interface Category {
  name: string;
  folder: string;
  codex: boolean;
}

export interface CategoryData {
  name: string;
  folder: string;
  codex: boolean;
  entries: ReferenceEntry[];
}

export interface ProjectTree {
  slug: string;
  title: string;
  author: string | null;
  rag_recipe: string | null;
  default_model: string;
  acts: Act[];
  chapters: ChapterEntry[];
  categories: CategoryData[];
}

export interface FileGet {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  etag: string;
  word_count: number;
}

export interface FilePutResult extends FileGet {
  conflict?: boolean;
  conflict_path?: string | null;
}

export interface ServerConflictEntry {
  path: string;
  canonical_path: string;
  device_id: string;
  timestamp: string;
  size: number;
  mtime_ns: number;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${txt}`);
  }
  return r.json() as Promise<T>;
}

// jsonOrThrow's server-error path always throws a plain Error; a genuine
// fetch failure (offline, DNS, CORS, Safari's "Load failed") throws TypeError.
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectListItem[]> {
  return jsonOrThrow(await fetch('/api/projects', { signal }));
}

export async function getProject(slug: string): Promise<ProjectTree> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}`));
}

export async function updateProject(
  slug: string,
  payload: Partial<{ title: string; author: string; rag_recipe: string; default_model: string; acts: Act[]; categories: Category[] }>,
): Promise<unknown> {
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
): Promise<unknown> {
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
  if (!r.ok && r.status !== 204) throw new Error(`${r.status} ${r.statusText}`);
}

export async function summarizeFile(
  slug: string,
  path: string,
  model?: string,
): Promise<{ summary: string }> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/chat/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, model }),
    }),
  );
}

export async function deleteFile(slug: string, path: string): Promise<void> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 204) {
    throw new Error(`${r.status} ${r.statusText}`);
  }
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
  if (!r.ok && r.status !== 204) {
    throw new Error(`${r.status} ${r.statusText}`);
  }
}

export async function newScene(
  slug: string,
  chapterSlug: string,
  payload: { title?: string },
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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type ChatScope =
  | { kind: 'everything' }
  | { kind: 'act'; act: number }
  | { kind: 'chapter'; chapter: string }
  | { kind: 'scene'; path: string }
  | { kind: 'codex' };

export interface ChatRequestPayload {
  messages: ChatMessage[];
  scope: ChatScope;
  include_codex: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface ScopePreview {
  label: string;
  section_count: number;
  char_count: number;
  estimated_tokens: number;
  codex_included: boolean;
}

export interface ModelEntry {
  id: string;
  owned_by: string | null;
  tags: string[];
}

export async function listModels(): Promise<ModelEntry[]> {
  return jsonOrThrow(await fetch('/api/models'));
}

export async function previewScope(
  slug: string,
  payload: ChatRequestPayload,
): Promise<ScopePreview> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/chat/scope/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export interface RewriteRequestPayload {
  selection: string;
  instruction: string;
  before_context?: string;
  after_context?: string;
  include_codex?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function streamRewrite(
  slug: string,
  payload: RewriteRequestPayload,
  signal: AbortSignal,
): Promise<Response> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/chat/rewrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${txt}`);
  }
  return r;
}

export async function streamChat(
  slug: string,
  payload: ChatRequestPayload,
  signal: AbortSignal,
): Promise<Response> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${txt}`);
  }
  return r;
}

export interface QdrantStatus {
  exists: boolean;
  points_count?: number | null;
  vectors_count?: number | null;
  indexed_vectors_count?: number | null;
  status?: string | null;
  error?: string | null;
}

export interface RagState {
  slug: string;
  collection: string;
  recipe_path: string;
  recipe_exists: boolean;
  recipe_yaml: string | null;
  ingest_command: string;
  qdrant_url: string;
  qdrant: QdrantStatus;
}

export async function getRagState(slug: string): Promise<RagState> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/rag`),
  );
}

export async function writeRagRecipe(
  slug: string,
): Promise<{ recipe_path: string; recipe_yaml: string; written: boolean }> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/rag/recipe`, {
      method: 'PUT',
    }),
  );
}

export async function deleteRagCollection(slug: string): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/rag/collection`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 204) throw new Error(`${r.status} ${r.statusText}`);
}

export interface RagHit {
  score: number;
  payload: Record<string, unknown>;
}

export interface RagQueryResponse {
  hits: RagHit[];
  embed_dim: number | null;
  queried_at: string;
}

export async function queryRag(
  slug: string,
  payload: { text: string; limit?: number },
): Promise<RagQueryResponse> {
  return jsonOrThrow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}/rag/query`, {
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

// --- Review ---

export interface ReviewSession {
  id: string;
  name: string;
  token: string;
  chapters: string[];
  created: string;
  active: boolean;
}

export interface TextAnchor {
  prefix: string;
  exact: string;
  suffix: string;
}

export interface ReviewComment {
  id: string;
  session: string;
  scene: string;
  anchor: TextAnchor;
  author: string;
  text: string;
  created: string;
  resolved: boolean;
}

export interface ManuscriptScene {
  path: string;
  title: string;
  html: string;
}

export interface ManuscriptChapter {
  slug: string;
  title: string;
  number: number | null;
  kind: string;
  scenes: ManuscriptScene[];
}

export interface Manuscript {
  title: string;
  author: string;
  chapters: ManuscriptChapter[];
}

export async function listSessions(slug: string): Promise<ReviewSession[]> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions`));
}

export async function createSession(slug: string, payload: { name: string; chapters: string[] }): Promise<ReviewSession> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export async function updateSession(slug: string, id: string, payload: { name?: string; active?: boolean; chapters?: string[] }): Promise<ReviewSession> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export async function deleteReviewSession(slug: string, id: string): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Delete session failed: ${r.status}`);
}

export async function getManuscript(token: string): Promise<Manuscript> {
  return jsonOrThrow(await fetch(`/api/review/${encodeURIComponent(token)}/manuscript`));
}

export async function getComments(token: string): Promise<ReviewComment[]> {
  return jsonOrThrow(await fetch(`/api/review/${encodeURIComponent(token)}/comments`));
}

export async function addComment(token: string, payload: { scene: string; anchor: TextAnchor; text: string }, author: string): Promise<ReviewComment> {
  return jsonOrThrow(await fetch(`/api/review/${encodeURIComponent(token)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Reviewer-Name': author },
    body: JSON.stringify(payload),
  }));
}

export async function resolveComment(token: string, commentId: string, resolved: boolean): Promise<ReviewComment> {
  return jsonOrThrow(await fetch(`/api/review/${encodeURIComponent(token)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  }));
}

export function exportReviewUrl(token: string, format: 'epub' | 'md' = 'epub'): string {
  return `/api/review/${encodeURIComponent(token)}/export?format=${format}`;
}

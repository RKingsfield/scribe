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

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, body: string) {
    super(`${status} ${statusText}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_FLOOR = 500;

async function httpError(r: Response): Promise<HttpError> {
  const txt = await r.text().catch(() => '');
  return new HttpError(r.status, r.statusText, txt);
}

export async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw await httpError(r);
  return r.json() as Promise<T>;
}

export async function assertOk(r: Response): Promise<void> {
  if (!r.ok) throw await httpError(r);
}

// Retry-in-place vs park: a genuine fetch failure (offline, DNS, CORS, Safari's
// "Load failed") throws TypeError, and a 5xx/429 is the server or its proxy being
// briefly unable — both clear on their own. Every other status is the request
// itself being wrong, which no amount of replay fixes.
export function isTransientError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof HttpError) {
    return e.status >= SERVER_ERROR_FLOOR || e.status === TOO_MANY_REQUESTS;
  }
  return false;
}

export interface ModelEntry {
  id: string;
  owned_by: string | null;
  tags: string[];
}

let cachedModels: ModelEntry[] | null = null;

export async function listModels(): Promise<ModelEntry[]> {
  if (cachedModels) return cachedModels;
  const models = await jsonOrThrow<ModelEntry[]>(await fetch('/api/models'));
  cachedModels = models;
  return models;
}

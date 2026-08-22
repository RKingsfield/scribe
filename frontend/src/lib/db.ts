import Dexie, { Table } from 'dexie';
import type { ChatScope, ProjectTree } from './api';
import type {
  NewChapterPayload,
  NewScenePayload,
  NewCategoryEntryPayload,
  DeleteChapterPayload,
  DeleteScenePayload,
  DeleteCategoryEntryPayload,
  ReorderPayload,
  MoveScenePayload,
} from './types';

interface CachedFile {
  // composite key "<slug>::<path>"
  key: string;
  slug: string;
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  serverEtag: string;
  cachedAt: number;
}

// Placeholder etag on cache rows for files created offline — never a real server etag.
export const OFFLINE_ETAG = 'offline';

export interface PendingWrite {
  id?: number;
  slug: string;
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  baseEtag: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
  // Set when a flush attempt fails permanently — parked so the rest of the
  // queue can keep draining instead of head-of-line blocking.
  stuckAt?: number;
}

interface ConflictMarker {
  // composite key "<slug>::<conflictPath>"
  key: string;
  slug: string;
  path: string;            // the conflict file
  canonicalPath: string;
  deviceId: string;
  timestamp: string;
  noticedAt: number;
}

interface KV {
  key: string;
  value: string;
}

interface CachedTree {
  slug: string;
  tree: ProjectTree;
  cachedAt: number;
}

interface StructureOpBase {
  id?: number;
  slug: string;
  tempId: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
  // Set when a replay attempt fails permanently — parked so the rest of the
  // queue can keep draining instead of head-of-line blocking.
  stuckAt?: number;
}

export type StructureOp = StructureOpBase & (
  | { op: 'new-chapter'; payload: NewChapterPayload }
  | { op: 'new-scene'; payload: NewScenePayload }
  | { op: 'new-category-entry'; payload: NewCategoryEntryPayload }
  | { op: 'delete-chapter'; payload: DeleteChapterPayload }
  | { op: 'delete-scene'; payload: DeleteScenePayload }
  | { op: 'delete-category-entry'; payload: DeleteCategoryEntryPayload }
  | { op: 'reorder'; payload: ReorderPayload }
  | { op: 'move-scene'; payload: MoveScenePayload }
);

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export interface ChatThread {
  id: string;
  slug: string;
  title: string;
  scope: ChatScope;
  includeCodex: boolean;
  model?: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

class ScribeDB extends Dexie {
  cache!: Table<CachedFile, string>;
  pending!: Table<PendingWrite, number>;
  conflicts!: Table<ConflictMarker, string>;
  kv!: Table<KV, string>;
  chats!: Table<ChatThread, string>;
  trees!: Table<CachedTree, string>;
  structureOps!: Table<StructureOp, number>;

  constructor() {
    super('scribe');
    this.version(1).stores({
      cache: 'key, slug, path',
      pending: '++id, [slug+path], queuedAt',
      conflicts: 'key, slug, canonicalPath',
      kv: 'key',
    });
    this.version(2).stores({
      cache: 'key, slug, path',
      pending: '++id, [slug+path], queuedAt',
      conflicts: 'key, slug, canonicalPath',
      kv: 'key',
      chats: 'id, slug, updatedAt',
    });
    this.version(3).stores({
      cache: 'key, slug, path',
      pending: '++id, [slug+path], queuedAt',
      conflicts: 'key, slug, canonicalPath',
      kv: 'key',
      chats: 'id, slug, updatedAt',
      trees: 'slug',
      structureOps: '++id, slug, queuedAt',
    });
  }
}

export const db = new ScribeDB();

let wasOpen = false;
db.on('ready', () => { wasOpen = true; });
db.on('close', () => {
  if (wasOpen) db.open().catch(() => {});
});

export async function ensureOpen(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

export async function getDeviceId(): Promise<string> {
  const existing = await db.kv.get('deviceId');
  if (existing) return existing.value;
  const fresh = `dev-${cryptoRandomId()}`;
  await db.kv.put({ key: 'deviceId', value: fresh });
  return fresh;
}

export function cryptoRandomId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fileKey(slug: string, path: string): string {
  return `${slug}::${path}`;
}

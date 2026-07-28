import Dexie, { Table } from 'dexie';
import type { ChatScope, ProjectTree } from './api';

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

interface PendingWrite {
  id?: number;
  slug: string;
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  baseEtag: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface ConflictMarker {
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

interface StructureOp {
  id?: number;
  slug: string;
  op: 'new-chapter' | 'new-scene' | 'new-category-entry' | 'delete-chapter' | 'reorder' | 'move-scene';
  payload: Record<string, unknown>;
  tempId: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

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

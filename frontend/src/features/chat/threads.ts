import { db, ChatThread, ChatTurn } from '../../lib/db';
import { ChatScope } from '../../lib/api';

export function scopeToKey(scope: ChatScope): string {
  switch (scope.kind) {
    case 'everything': return 'everything';
    case 'codex': return 'codex';
    case 'act': return `act:${scope.act}`;
    case 'chapter': return `chapter:${scope.chapter}`;
    case 'scene': return `scene:${scope.path}`;
  }
}

export async function listThreads(slug: string): Promise<ChatThread[]> {
  const all = await db.chats.where('slug').equals(slug).toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getThread(id: string): Promise<ChatThread | undefined> {
  return db.chats.get(id);
}

export async function createThread(
  slug: string,
  scope: ChatScope,
  includeCodex: boolean,
  model: string | undefined,
): Promise<ChatThread> {
  const now = Date.now();
  const id = `t_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const thread: ChatThread = {
    id,
    slug,
    title: 'Untitled chat',
    scope,
    includeCodex,
    model,
    turns: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.chats.put(thread);
  return thread;
}

export async function appendTurn(id: string, turn: ChatTurn): Promise<ChatThread | undefined> {
  const t = await db.chats.get(id);
  if (!t) return undefined;
  t.turns.push(turn);
  t.updatedAt = Date.now();
  if (t.title === 'Untitled chat' && turn.role === 'user') {
    t.title = turn.content.slice(0, 60).split('\n')[0] || 'Untitled chat';
  }
  await db.chats.put(t);
  return t;
}

export async function updateLastTurn(
  id: string,
  patch: Partial<ChatTurn>,
): Promise<ChatThread | undefined> {
  const t = await db.chats.get(id);
  if (!t || t.turns.length === 0) return undefined;
  const last = t.turns[t.turns.length - 1];
  t.turns[t.turns.length - 1] = { ...last, ...patch };
  t.updatedAt = Date.now();
  await db.chats.put(t);
  return t;
}

export async function updateThreadMeta(
  id: string,
  patch: Partial<Pick<ChatThread, 'scope' | 'includeCodex' | 'model' | 'title'>>,
): Promise<ChatThread | undefined> {
  const t = await db.chats.get(id);
  if (!t) return undefined;
  Object.assign(t, patch);
  t.updatedAt = Date.now();
  await db.chats.put(t);
  return t;
}

export async function deleteThread(id: string): Promise<void> {
  await db.chats.delete(id);
}

import { jsonOrThrow, assertOk } from './common';

interface ChatMessage {
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
  await assertOk(r);
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
  await assertOk(r);
  return r;
}

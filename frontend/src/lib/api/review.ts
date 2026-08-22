import { jsonOrThrow, assertOk } from './common';

export interface ReviewSession {
  id: string;
  name: string;
  token: string;
  chapters: string[];
  created: string;
  expires: string | null;
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

interface ManuscriptScene {
  path: string;
  title: string;
  html: string;
}

interface ManuscriptChapter {
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

export async function createSession(slug: string, payload: { name: string; chapters: string[]; expires?: string }): Promise<ReviewSession> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export async function updateSession(slug: string, id: string, payload: { name?: string; active?: boolean; chapters?: string[]; expires?: string }): Promise<ReviewSession> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export async function deleteReviewSession(slug: string, id: string): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await assertOk(r);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, author }),
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

// Owner-scoped: works regardless of session active/expired state.
export function exportSessionUrl(slug: string, sessionId: string, format: 'epub' | 'md' = 'epub'): string {
  return `/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`;
}

// Owner-scoped: reads a session's manuscript/comments regardless of active state.
export async function getSessionManuscript(slug: string, sessionId: string): Promise<Manuscript> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(sessionId)}/manuscript`));
}

export async function getSessionComments(slug: string, sessionId: string): Promise<ReviewComment[]> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(sessionId)}/comments`));
}

export async function addSessionComment(
  slug: string,
  sessionId: string,
  payload: { scene: string; anchor: TextAnchor; text: string },
  author: string,
): Promise<ReviewComment> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(sessionId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, author }),
  }));
}

export async function resolveSessionComment(slug: string, sessionId: string, commentId: string, resolved: boolean): Promise<ReviewComment> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}/review/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  }));
}

export interface ExportOptions {
  includeSummaries: boolean;
  includeSceneBeats: boolean;
  titlePage: boolean;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

export async function exportProject(
  slug: string,
  format: 'md' | 'docx' | 'html' | 'epub',
  options: ExportOptions,
): Promise<ExportResult> {
  const params = new URLSearchParams({
    format,
    include_summaries: String(options.includeSummaries),
    include_scene_beats: String(options.includeSceneBeats),
    title_page: String(options.titlePage),
  });
  const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/export?${params.toString()}`);
  await assertOk(r);
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? `${slug}.${format}`;
  return { blob, filename };
}

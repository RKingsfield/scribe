import { jsonOrThrow, assertOk } from './common';

interface QdrantStatus {
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
  await assertOk(r);
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

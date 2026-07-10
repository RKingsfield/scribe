"""Per-novel RAG routes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from fastapi.responses import Response

from .. import config
from ..rag.recipe import build_recipe, collection_name, serialize_recipe
from ..storage.fs import write_text_atomic
from ..storage.project import load_project
from ..storage import paths

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects/{slug}/rag", tags=["rag"])


class QdrantStatus(BaseModel):
    exists: bool
    points_count: int | None = None
    vectors_count: int | None = None
    indexed_vectors_count: int | None = None
    status: str | None = None
    error: str | None = None


class RagState(BaseModel):
    slug: str
    collection: str
    recipe_path: str
    recipe_exists: bool
    recipe_yaml: str | None = None
    ingest_command: str
    qdrant_url: str
    qdrant: QdrantStatus


def _recipe_path(slug: str) -> Path:
    return config.RAG_RECIPES_DIR / "scribe" / f"{slug}.yml"


async def _qdrant_status(coll: str) -> QdrantStatus:
    url = f"{config.QDRANT_URL.rstrip('/')}/collections/{coll}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
            if r.status_code == 404:
                return QdrantStatus(exists=False)
            r.raise_for_status()
            data = r.json().get("result", {})
            return QdrantStatus(
                exists=True,
                points_count=data.get("points_count"),
                vectors_count=data.get("vectors_count"),
                indexed_vectors_count=data.get("indexed_vectors_count"),
                status=data.get("status"),
            )
    except httpx.HTTPError as e:
        log.warning("qdrant status failed: %s", e)
        return QdrantStatus(exists=False, error=str(e))


@router.get("", response_model=RagState)
async def get_state(slug: str) -> RagState:
    paths.project_root(slug)  # validate
    rp = _recipe_path(slug)
    recipe_yaml = rp.read_text(encoding="utf-8") if rp.is_file() else None
    coll = collection_name(slug)
    qstatus = await _qdrant_status(coll)
    # Emit a host-side, copy-pastable command. Either the resolved recipe
    # name (if `LLM_RAG_RECIPES` is set to the host recipes dir) or the
    # host absolute path otherwise.
    host_recipe_path = f"{config.RAG_HOST_RECIPES_DIR.rstrip('/')}/scribe/{slug}.yml"
    cmd = f"llm-rag ingest scribe/{slug}  # or: llm-rag ingest {host_recipe_path}"
    return RagState(
        slug=slug,
        collection=coll,
        recipe_path=str(rp),
        recipe_exists=rp.is_file(),
        recipe_yaml=recipe_yaml,
        ingest_command=cmd,
        qdrant_url=config.QDRANT_URL,
        qdrant=qstatus,
    )


class WriteRecipeResponse(BaseModel):
    recipe_path: str
    recipe_yaml: str
    written: bool


@router.put("/recipe", response_model=WriteRecipeResponse)
def put_recipe(slug: str) -> WriteRecipeResponse:
    project_root = paths.project_root(slug)
    project = load_project(project_root)
    recipe = build_recipe(
        slug=slug,
        title=project.title,
        project_path=project_root,
        host_writing_root=config.RAG_HOST_WRITING_ROOT,
        qdrant_url=config.QDRANT_URL,
    )
    yaml_text = serialize_recipe(recipe)
    rp = _recipe_path(slug)
    try:
        rp.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(
            500,
            f"Cannot create recipes directory {rp.parent}: {e}. "
            f"Check RAG_RECIPES_DIR and the bind-mount on the scribe container.",
        )
    write_text_atomic(rp, yaml_text)
    return WriteRecipeResponse(
        recipe_path=str(rp),
        recipe_yaml=yaml_text,
        written=True,
    )


@router.delete("/collection", status_code=204)
async def delete_collection(slug: str) -> Response:
    paths.project_root(slug)
    coll = collection_name(slug)
    url = f"{config.QDRANT_URL.rstrip('/')}/collections/{coll}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.delete(url)
            if r.status_code not in (200, 404):
                r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"qdrant delete failed: {e}")
    return Response(status_code=204)


class RagQuery(BaseModel):
    text: str
    limit: int = config.RAG_DEFAULT_QUERY_LIMIT


class RagHit(BaseModel):
    score: float
    payload: dict[str, Any]


class RagQueryResponse(BaseModel):
    hits: list[RagHit]
    embed_dim: int | None = None
    queried_at: str


async def _embed(text: str) -> tuple[list[float], int]:
    url = f"{config.EMBED_URL.rstrip('/')}/embed"
    body = {"texts": [text]}
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(url, json=body)
        r.raise_for_status()
        data = r.json()
    vectors = data.get("vectors") or data.get("embeddings") or []
    if not vectors:
        raise RuntimeError(f"embed server returned no vectors: {data!r}")
    vec = vectors[0]
    return vec, len(vec)


@router.post("/query", response_model=RagQueryResponse)
async def query(slug: str, body: RagQuery) -> RagQueryResponse:
    paths.project_root(slug)
    if not body.text.strip():
        raise HTTPException(400, "query text is empty")
    coll = collection_name(slug)
    try:
        vec, dim = await _embed(body.text)
    except (httpx.HTTPError, RuntimeError) as e:
        raise HTTPException(502, f"embed failed: {e}")

    search_url = f"{config.QDRANT_URL.rstrip('/')}/collections/{coll}/points/search"
    payload = {
        "vector": vec,
        "limit": max(1, min(body.limit, config.RAG_MAX_QUERY_LIMIT)),
        "with_payload": True,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(search_url, json=payload)
            if r.status_code == 404:
                raise HTTPException(
                    404,
                    f"collection {coll!r} not found — run an ingest first "
                    "(see /api/projects/{slug}/rag for the command).",
                )
            r.raise_for_status()
            data = r.json().get("result", [])
    except httpx.HTTPError as e:
        raise HTTPException(502, f"qdrant search failed: {e}")

    hits = [
        RagHit(score=float(h.get("score", 0.0)), payload=h.get("payload") or {})
        for h in data
    ]
    return RagQueryResponse(
        hits=hits,
        embed_dim=dim,
        queried_at=datetime.now(timezone.utc).isoformat(),
    )

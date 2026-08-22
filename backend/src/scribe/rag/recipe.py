"""Recipe generation for per-novel RAG."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .. import config


def collection_name(slug: str) -> str:
    """Qdrant collection name for a scribe project."""
    return f"scribe-{slug}"


_SKIP_DIRS = {".git"}


def build_recipe(
    slug: str,
    title: str,
    *,
    project_path: Path,
    host_writing_root: str,
    qdrant_url: str,
) -> dict[str, Any]:
    """Build a deterministic recipe dict for a scribe project."""
    host_project = f"{host_writing_root.rstrip('/')}/{slug}"

    sources = []
    for child in sorted(project_path.iterdir()):
        if not child.is_dir() or child.name in _SKIP_DIRS or child.name.startswith("."):
            continue
        sources.append({
            "type": "directory",
            "path": f"{host_project}/{child.name}",
            "include": ["*.md"],
            "metadata": {"kind": child.name, "project": slug},
        })

    return {
        "corpus": collection_name(slug),
        "live_ingest": True,
        "description": (
            f"scribe novel: {title}. Per-project RAG over the project directories. "
            "Chunks tagged via `kind` metadata matching directory names."
        ),
        "sources": sources,
        "chunking": {
            "size": config.RAG_CHUNK_SIZE,
            "overlap": config.RAG_CHUNK_OVERLAP,
            "strategy": config.RAG_CHUNK_STRATEGY,
        },
        "embedding": {
            "model": config.EMBED_MODEL,
            "dimension": config.EMBED_DIMENSION,
            "backend": config.EMBED_BACKEND,
            "device": config.EMBED_DEVICE,
            "batch_size": config.EMBED_BATCH_SIZE,
        },
        "qdrant": {
            "url": qdrant_url,
            "collection": collection_name(slug),
            "on_disk": True,
            "distance": "cosine",
        },
        "notify": {
            "topic": "rag-ingest",
            "on_complete": True,
            "on_failure": True,
        },
    }


def serialize_recipe(recipe: dict[str, Any]) -> str:
    return yaml.safe_dump(recipe, sort_keys=False, allow_unicode=True)

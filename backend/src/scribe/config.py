import os
from pathlib import Path

import httpx

WRITING_ROOT = Path(os.environ.get("WRITING_ROOT", "/data/writing"))
APPDATA_ROOT = Path(os.environ.get("APPDATA_ROOT", "/data/appdata"))
ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_URL", "http://localhost:11435")
QDRANT_URL = os.environ.get("QDRANT_URL", "")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")
EMBED_URL = os.environ.get("EMBED_URL", "")
RAG_RECIPES_DIR = Path(os.environ.get("RAG_RECIPES_DIR", "/data/rag/recipes"))
RAG_HOST_RECIPES_DIR = os.environ.get("RAG_HOST_RECIPES_DIR", "/data/rag/recipes")
RAG_HOST_WRITING_ROOT = os.environ.get("RAG_HOST_WRITING_ROOT", "/data/writing")
FORGEJO_BASE_URL = os.environ.get("FORGEJO_BASE_URL", "")
FORGEJO_USER = os.environ.get("FORGEJO_USER", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
PORT = int(os.environ.get("PORT", "3030"))
STATIC_ROOT = Path(os.environ.get("STATIC_ROOT", "/app/static"))

GIT_AUTHOR_NAME = os.environ.get("GIT_AUTHOR_NAME", "Scribe Auto")
GIT_AUTHOR_EMAIL = os.environ.get("GIT_AUTHOR_EMAIL", "scribe@scribe.local")

SCRIBE_AUTOCOMMIT_DISABLED = os.environ.get("SCRIBE_AUTOCOMMIT_DISABLED") == "1"
AUTOCOMMIT_INTERVAL_MIN = int(os.environ.get("AUTOCOMMIT_INTERVAL_MIN", "10"))

ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")
ALERT_WEBHOOK_TOKEN = os.environ.get("ALERT_WEBHOOK_TOKEN", "")
ALERT_WEBHOOK_STYLE = os.environ.get("ALERT_WEBHOOK_STYLE", "json")


def forgejo_token() -> str:
    # read live, not cached at import: tests delete/restore this env var per-test
    return os.environ.get("FORGEJO_TOKEN", "")


# RAG chunking / embedding defaults
RAG_CHUNK_SIZE = 500
RAG_CHUNK_OVERLAP = 100
RAG_CHUNK_STRATEGY = "sentence"
EMBED_MODEL = "bge-m3"
EMBED_DIMENSION = 1024
EMBED_BACKEND = "cpu"
EMBED_DEVICE = "cpu"
EMBED_BATCH_SIZE = 32

# Summarize endpoint defaults
SUMMARIZE_MAX_TOKENS = 240
SUMMARIZE_TEMPERATURE = 0.3

# Rewrite default max tokens
REWRITE_DEFAULT_MAX_TOKENS = 1024

# RAG query limits
RAG_DEFAULT_QUERY_LIMIT = 8
RAG_MAX_QUERY_LIMIT = 50

# Structure ops
MAX_CHAPTER_SLOT_SEARCH = 1000

# Review sessions: default lifetime of a share token
REVIEW_SESSION_TTL_DAYS = int(os.environ.get("REVIEW_SESSION_TTL_DAYS", "180"))

# HTTP client timeouts
LLM_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=30.0)
SUMMARIZE_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=30.0)
MODELS_TIMEOUT = 10.0
QDRANT_TIMEOUT = 5.0
FORGEJO_TIMEOUT = 10.0
RAG_QUERY_TIMEOUT = 15.0

# Synthetic model entries surfaced through /api/models when an
# ANTHROPIC_API_KEY is configured. All listed models natively support a
# 1M-token context window — no beta header required.
CLAUDE_MODELS: list[dict[str, str | list[str]]] = [
    {
        "id": "claude-opus-4-8",
        "owned_by": "anthropic",
        "tags": ["claude", "big-context", "1M"],
    },
    {
        "id": "claude-sonnet-5",
        "owned_by": "anthropic",
        "tags": ["claude", "big-context", "1M"],
    },
]

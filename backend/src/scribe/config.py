import os
from pathlib import Path

WRITING_ROOT = Path(os.environ.get("WRITING_ROOT", "/data/writing"))
APPDATA_ROOT = Path(os.environ.get("APPDATA_ROOT", "/data/appdata"))
ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_URL", "http://localhost")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost")
EMBED_URL = os.environ.get("EMBED_URL", "http://localhost")
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

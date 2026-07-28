import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import SCRIBE_AUTOCOMMIT_DISABLED, STATIC_ROOT, WRITING_ROOT
from .routes import chat, export, files, git as git_routes, projects, rag, review, structure_ops, sync

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if not SCRIBE_AUTOCOMMIT_DISABLED:
        from .git.autocommit import start_scheduler, stop_scheduler
        start_scheduler()
        try:
            yield
        finally:
            stop_scheduler()
    else:
        yield


app = FastAPI(title="scribe", version=__version__, lifespan=lifespan)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "writing_root": str(WRITING_ROOT),
        "writing_root_exists": WRITING_ROOT.exists(),
    }


app.include_router(projects.router)
app.include_router(files.router)
app.include_router(structure_ops.router)
app.include_router(sync.router)
app.include_router(git_routes.router)
app.include_router(chat.router)
app.include_router(chat.models_router)
app.include_router(rag.router)
app.include_router(export.router)
app.include_router(review.router)
app.include_router(review.review_router)


if STATIC_ROOT.exists():
    # Serve hashed assets directly under /assets/.
    app.mount(
        "/assets",
        StaticFiles(directory=str(STATIC_ROOT / "assets")),
        name="assets",
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str, request: Request) -> FileResponse:
        """Serve index.html for any non-API route so client-side routing
        survives a hard refresh (e.g. /p/<slug>/write?path=...)."""
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (STATIC_ROOT / full_path).resolve()
        if full_path and candidate.is_file() and str(candidate).startswith(str(STATIC_ROOT.resolve())):
            return FileResponse(candidate)
        return FileResponse(STATIC_ROOT / "index.html")

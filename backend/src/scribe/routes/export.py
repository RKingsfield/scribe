"""Pandoc-based export: markdown / docx / html / epub."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from ..export.manuscript import ExportOptions, compose_manuscript
from ..export.pandoc import pandoc, safe_filename
from ..storage import paths
from ..storage.project import load_project

router = APIRouter(prefix="/api/projects/{slug}/export", tags=["export"])


ExportFormat = Literal["md", "docx", "html", "epub"]

PANDOC_FORMATS: dict[str, tuple[str, str]] = {
    # format -> (pandoc -t flag, mimetype)
    "docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "html": ("html5", "text/html; charset=utf-8"),
    "epub": ("epub3", "application/epub+zip"),
}


def _export_data(slug: str, options: ExportOptions) -> tuple[str, str, str | None]:
    """Compose manuscript and return (markdown, title, author)."""
    md = compose_manuscript(slug, options)
    project_root = paths.project_root(slug)
    project = load_project(project_root)
    return md, project.title, project.author


@router.get("")
async def export_project(
    slug: str,
    format: ExportFormat = Query("docx"),
    include_summaries: bool = Query(False),
    include_scene_beats: bool = Query(False),
    title_page: bool = Query(True),
) -> Response:
    options = ExportOptions(
        include_summaries=include_summaries,
        include_scene_beats=include_scene_beats,
        title_page=title_page,
    )
    md, title, author = await run_in_threadpool(_export_data, slug, options)
    filename = safe_filename(slug, format)

    if format == "md":
        return Response(
            content=md.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    if format not in PANDOC_FORMATS:
        raise HTTPException(400, f"unsupported format: {format}")

    target, mime = PANDOC_FORMATS[format]
    output = await pandoc(md, target, title=title, author=author)
    return Response(
        content=output,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

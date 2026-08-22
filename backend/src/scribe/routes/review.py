import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import markdown
import nh3
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import config
from ..export.manuscript import ExportOptions, compose_manuscript, strip_scene_beats, walk_chapters
from ..export.pandoc import pandoc, safe_filename
from ..storage import paths
from ..storage import review as review_store
from ..storage.helpers import slugify
from ..storage.project import load_project
from ..storage.review import (
    CommentData,
    ManuscriptChapter,
    ManuscriptData,
    ManuscriptScene,
    SessionData,
)

router = APIRouter(prefix="/api/projects", tags=["review"])
review_router = APIRouter(prefix="/api/review", tags=["review"])

MAX_REVIEWER_NAME_LEN = 100


class AnchorModel(BaseModel):
    prefix: str = Field(max_length=500)
    exact: str = Field(max_length=500)
    suffix: str = Field(max_length=500)


class CommentCreate(BaseModel):
    scene: str
    anchor: AnchorModel
    text: str = Field(max_length=10000)
    author: str | None = None


class CommentUpdate(BaseModel):
    resolved: bool | None = None


class CommentOut(BaseModel):
    id: str
    session: str
    scene: str
    anchor: AnchorModel
    author: str
    text: str
    created: str
    resolved: bool


class SessionCreate(BaseModel):
    name: str
    chapters: list[str]
    expires: str | None = None  # ISO date/datetime; defaults to created + REVIEW_SESSION_TTL_DAYS


class SessionUpdate(BaseModel):
    name: str | None = None
    active: bool | None = None
    chapters: list[str] | None = None
    expires: str | None = None


class SessionOut(BaseModel):
    id: str
    name: str
    token: str
    chapters: list[str]
    created: str
    expires: str | None = None
    active: bool


def _normalize_expiry(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid expires timestamp: {value!r}")
    if "T" not in value and ":" not in value:
        # A bare date means access through that whole day, not until it starts.
        dt += timedelta(hours=23, minutes=59, seconds=59)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


def _validate_session_scene(slug: str, scene: str, chapter_dirs: list[str]) -> Path:
    resolved = paths.resolve_in_project(slug, scene)
    chapter_dir = str(Path(scene).parent)
    if chapter_dir not in chapter_dirs:
        raise HTTPException(status_code=404, detail="scene not in session chapters")
    return resolved


def _get_session_or_404(slug: str, session_id: str) -> SessionData:
    for session in review_store.load_sessions(slug):
        if session["id"] == session_id:
            return session
    raise HTTPException(status_code=404, detail="session not found")


def _require_active_session(token: str) -> tuple[SessionData, str]:
    result = review_store.resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    if review_store.session_expired(session):
        raise HTTPException(status_code=404, detail="session expired")
    return session, slug


@router.get("/{slug}/review/sessions", response_model=list[SessionOut])
def list_sessions(slug: str) -> list[SessionData]:
    paths.project_root(slug)
    return review_store.load_sessions(slug)


@router.post("/{slug}/review/sessions", response_model=SessionOut)
def create_session(slug: str, body: SessionCreate) -> SessionData:
    paths.project_root(slug)
    sessions = review_store.load_sessions(slug)
    existing_ids = {s["id"] for s in sessions}
    base_id = slugify(body.name)
    session_id = base_id
    if session_id in existing_ids:
        session_id = f"{base_id}-{secrets.token_hex(3)}"
    created = datetime.now(UTC)
    expires = (
        _normalize_expiry(body.expires)
        if body.expires
        else (created + timedelta(days=config.REVIEW_SESSION_TTL_DAYS)).isoformat()
    )
    session: SessionData = {
        "id": session_id,
        "name": body.name,
        "token": secrets.token_hex(12),
        "chapters": body.chapters,
        "created": created.isoformat(),
        "expires": expires,
        "active": True,
    }
    sessions.append(session)
    review_store.save_sessions(slug, sessions)
    return session


@router.patch("/{slug}/review/sessions/{session_id}", response_model=SessionOut)
def update_session(slug: str, session_id: str, body: SessionUpdate) -> SessionData:
    paths.project_root(slug)
    sessions = review_store.load_sessions(slug)
    for session in sessions:
        if session["id"] == session_id:
            if body.name is not None:
                session["name"] = body.name
            if body.active is not None:
                session["active"] = body.active
            if body.chapters is not None:
                session["chapters"] = body.chapters
            if body.expires is not None:
                session["expires"] = _normalize_expiry(body.expires)
            review_store.save_sessions(slug, sessions)
            return session
    raise HTTPException(status_code=404, detail="session not found")


@router.delete("/{slug}/review/sessions/{session_id}", status_code=204)
def delete_session(slug: str, session_id: str) -> Response:
    project_root = paths.project_root(slug)
    sessions = review_store.load_sessions(slug)
    target = next((s for s in sessions if s["id"] == session_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="session not found")
    remaining = [s for s in sessions if s["id"] != session_id]
    review_store.save_sessions(slug, remaining)
    review_store.delete_session_comments(project_root, session_id)
    return Response(status_code=204)


def _render_manuscript(slug: str, chapter_dirs: list[str]) -> ManuscriptData:
    project_root = paths.project_root(slug)
    project = load_project(project_root)

    chapter_filter = set(chapter_dirs)
    walked = walk_chapters(project_root, chapter_filter)

    md_converter = markdown.Markdown(extensions=["tables", "smarty"])
    chapters: list[ManuscriptChapter] = []
    for ch in walked:
        scenes: list[ManuscriptScene] = []
        for scene in ch.scenes:
            body = strip_scene_beats(scene.body)
            md_converter.reset()
            html = nh3.clean(md_converter.convert(body))
            scenes.append({
                "path": scene.rel_path,
                "title": scene.title,
                "html": html,
            })
        chapters.append({
            "slug": ch.slug,
            "title": ch.title,
            "number": ch.meta.get("chapter", None),
            "kind": str(ch.meta.get("kind", "chapter")),
            "scenes": scenes,
        })

    return {"title": project.title, "author": project.author or "", "chapters": chapters}


@router.get("/{slug}/review/sessions/{session_id}/manuscript")
def get_session_manuscript(slug: str, session_id: str) -> ManuscriptData:
    paths.project_root(slug)
    session = _get_session_or_404(slug, session_id)
    return _render_manuscript(slug, session.get("chapters", []))


@router.get("/{slug}/review/sessions/{session_id}/comments", response_model=list[CommentOut])
def get_session_comments(slug: str, session_id: str) -> list[CommentData]:
    project_root = paths.project_root(slug)
    session = _get_session_or_404(slug, session_id)
    return review_store.load_comments(project_root, session.get("chapters", []), session["id"])


@router.patch("/{slug}/review/sessions/{session_id}/comments/{comment_id}", response_model=CommentOut)
def update_session_comment(slug: str, session_id: str, comment_id: str, body: CommentUpdate) -> CommentData:
    project_root = paths.project_root(slug)
    session = _get_session_or_404(slug, session_id)
    updates: dict[str, Any] = {k: v for k, v in body.model_dump().items() if v is not None}
    comment = review_store.update_comment(project_root, session.get("chapters", []), session["id"], comment_id, updates)
    if comment is None:
        raise HTTPException(status_code=404, detail="comment not found")
    return comment


@router.post("/{slug}/review/sessions/{session_id}/comments", response_model=CommentOut)
def add_session_comment(slug: str, session_id: str, body: CommentCreate) -> CommentData:
    paths.project_root(slug)
    session = _get_session_or_404(slug, session_id)
    return _create_comment(slug, session, body, default_author="Author")


@router.get("/{slug}/review/sessions/{session_id}/export")
async def export_session(slug: str, session_id: str, format: str = Query("epub")) -> Response:
    paths.project_root(slug)
    session = _get_session_or_404(slug, session_id)
    return await _export_manuscript(slug, session.get("chapters", []), format)


@review_router.get("/{token}/manuscript")
def get_manuscript(token: str) -> ManuscriptData:
    session, slug = _require_active_session(token)
    return _render_manuscript(slug, session.get("chapters", []))


@review_router.get("/{token}/comments", response_model=list[CommentOut])
def list_comments(token: str) -> list[CommentData]:
    session, slug = _require_active_session(token)
    project_root = paths.project_root(slug)
    return review_store.load_comments(project_root, session.get("chapters", []), session["id"])


def _create_comment(slug: str, session: SessionData, body: CommentCreate, default_author: str) -> CommentData:
    resolved_scene = _validate_session_scene(slug, body.scene, session.get("chapters", []))
    raw_name = body.author if body.author is not None else default_author
    author = raw_name[:MAX_REVIEWER_NAME_LEN].strip() or default_author
    comment: CommentData = {
        "id": str(uuid.uuid4()),
        "session": session["id"],
        "scene": body.scene,
        "anchor": body.anchor.model_dump(),
        "author": author,
        "text": body.text,
        "created": datetime.now(UTC).isoformat(),
        "resolved": False,
    }
    review_store.save_comment(resolved_scene, comment)
    return comment


@review_router.post("/{token}/comments", response_model=CommentOut)
def add_comment(token: str, body: CommentCreate) -> CommentData:
    session, slug = _require_active_session(token)
    return _create_comment(slug, session, body, default_author="Anonymous")


@review_router.patch("/{token}/comments/{comment_id}", response_model=CommentOut)
def update_comment(token: str, comment_id: str, body: CommentUpdate) -> CommentData:
    session, slug = _require_active_session(token)
    updates: dict[str, Any] = {k: v for k, v in body.model_dump().items() if v is not None}
    project_root = paths.project_root(slug)
    comment = review_store.update_comment(project_root, session.get("chapters", []), session["id"], comment_id, updates)
    if comment is None:
        raise HTTPException(status_code=404, detail="comment not found")
    return comment


async def _export_manuscript(slug: str, chapter_dirs: list[str], format: str) -> Response:
    if format not in ("epub", "md"):
        raise HTTPException(status_code=400, detail="format must be epub or md")
    chapter_filter = set(chapter_dirs)
    opts = ExportOptions(title_page=True, include_summaries=False, include_scene_beats=False)
    md = await run_in_threadpool(compose_manuscript, slug, opts, chapter_filter=chapter_filter)
    filename = safe_filename(slug, format)
    if format == "md":
        return Response(
            content=md.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    project = load_project(paths.project_root(slug))
    output = await pandoc(md, "epub3", title=project.title, author=project.author)
    return Response(
        content=output,
        media_type="application/epub+zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@review_router.get("/{token}/export")
async def export_review(token: str, format: str = Query("epub")) -> Response:
    session, slug = _require_active_session(token)
    return await _export_manuscript(slug, session.get("chapters", []), format)

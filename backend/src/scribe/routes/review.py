import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import markdown
import yaml
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from .. import config
from ..export.manuscript import ExportOptions, compose_manuscript, strip_scene_beats, walk_chapters
from ..export.pandoc import pandoc, safe_filename
from ..storage import paths
from ..storage.fs import write_text_atomic
from ..storage.helpers import slugify
from ..storage.project import load_project

router = APIRouter(prefix="/api/projects", tags=["review"])
review_router = APIRouter(prefix="/api/review", tags=["review"])


class AnchorModel(BaseModel):
    prefix: str
    exact: str
    suffix: str


class CommentCreate(BaseModel):
    scene: str
    anchor: AnchorModel
    text: str


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


class SessionUpdate(BaseModel):
    name: str | None = None
    active: bool | None = None
    chapters: list[str] | None = None


class SessionOut(BaseModel):
    id: str
    name: str
    token: str
    chapters: list[str]
    created: str
    active: bool


def _sessions_path(slug: str) -> Path:
    return config.WRITING_ROOT / slug / "review" / "sessions.yml"


def _load_sessions(slug: str) -> list[dict[str, Any]]:
    path = _sessions_path(slug)
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def _save_sessions(slug: str, sessions: list[dict[str, Any]]) -> None:
    path = _sessions_path(slug)
    write_text_atomic(path, yaml.dump(sessions, allow_unicode=True))


def _comments_path(project_root: Path, scene_path: str) -> Path:
    chapter_dir = (project_root / scene_path).parent
    return chapter_dir / "comments.yml"


def _load_comments(project_root: Path, chapter_dirs: list[str], session_id: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for chapter_rel in chapter_dirs:
        path = project_root / chapter_rel / "comments.yml"
        if not path.exists():
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        result.extend(c for c in data if c.get("session") == session_id)
    return result


def _save_comment(project_root: Path, scene_path: str, comment: dict[str, Any]) -> None:
    path = _comments_path(project_root, scene_path)
    existing: list[dict[str, Any]] = []
    if path.exists():
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            existing = data
    existing.append(comment)
    write_text_atomic(path, yaml.dump(existing, allow_unicode=True))


def _update_comment(
    project_root: Path,
    chapter_dirs: list[str],
    comment_id: str,
    updates: dict[str, Any],
) -> dict[str, Any] | None:
    for chapter_rel in chapter_dirs:
        path = project_root / chapter_rel / "comments.yml"
        if not path.exists():
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        for comment in data:
            if comment.get("id") == comment_id:
                comment.update(updates)
                write_text_atomic(path, yaml.dump(data, allow_unicode=True))
                return comment
    return None




def resolve_token(token: str) -> tuple[dict[str, Any], str] | None:
    """Scan all projects for a session matching token. Returns (session, slug) or None."""
    if not config.WRITING_ROOT.exists():
        return None
    for project_dir in config.WRITING_ROOT.iterdir():
        if not project_dir.is_dir():
            continue
        slug = project_dir.name
        for session in _load_sessions(slug):
            if session.get("token") == token:
                return session, slug
    return None


@router.get("/{slug}/review/sessions", response_model=list[SessionOut])
def list_sessions(slug: str) -> list[dict[str, Any]]:
    paths.project_root(slug)
    return _load_sessions(slug)


@router.post("/{slug}/review/sessions", response_model=SessionOut)
def create_session(slug: str, body: SessionCreate) -> dict[str, Any]:
    paths.project_root(slug)
    sessions = _load_sessions(slug)
    existing_ids = {s["id"] for s in sessions}
    base_id = slugify(body.name)
    session_id = base_id
    if session_id in existing_ids:
        session_id = f"{base_id}-{secrets.token_hex(3)}"
    session: dict[str, Any] = {
        "id": session_id,
        "name": body.name,
        "token": secrets.token_hex(12),
        "chapters": body.chapters,
        "created": datetime.now(timezone.utc).isoformat(),
        "active": True,
    }
    sessions.append(session)
    _save_sessions(slug, sessions)
    return session


@router.patch("/{slug}/review/sessions/{session_id}", response_model=SessionOut)
def update_session(slug: str, session_id: str, body: SessionUpdate) -> dict[str, Any]:
    paths.project_root(slug)
    sessions = _load_sessions(slug)
    for session in sessions:
        if session["id"] == session_id:
            if body.name is not None:
                session["name"] = body.name
            if body.active is not None:
                session["active"] = body.active
            if body.chapters is not None:
                session["chapters"] = body.chapters
            _save_sessions(slug, sessions)
            return session
    raise HTTPException(status_code=404, detail="session not found")


@router.delete("/{slug}/review/sessions/{session_id}", status_code=204)
def delete_session(slug: str, session_id: str) -> Response:
    paths.project_root(slug)
    sessions = _load_sessions(slug)
    remaining = [s for s in sessions if s["id"] != session_id]
    if len(remaining) == len(sessions):
        raise HTTPException(status_code=404, detail="session not found")
    _save_sessions(slug, remaining)
    return Response(status_code=204)


def _render_manuscript(slug: str, chapter_dirs: list[str]) -> dict[str, Any]:
    project_root = paths.project_root(slug)
    project = load_project(project_root)

    chapter_filter = set(chapter_dirs)
    walked = walk_chapters(project_root, chapter_filter)

    md_converter = markdown.Markdown(extensions=["tables", "smarty"])
    chapters: list[dict[str, Any]] = []
    for ch in walked:
        scenes: list[dict[str, Any]] = []
        for scene in ch.scenes:
            body = strip_scene_beats(scene.body)
            md_converter.reset()
            html = md_converter.convert(body)
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


@review_router.get("/{token}/manuscript")
def get_manuscript(token: str) -> dict[str, Any]:
    result = resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    return _render_manuscript(slug, session.get("chapters", []))


@review_router.get("/{token}/comments", response_model=list[CommentOut])
def list_comments(token: str) -> list[dict[str, Any]]:
    result = resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    project_root = config.WRITING_ROOT / slug
    return _load_comments(project_root, session.get("chapters", []), session["id"])


@review_router.post("/{token}/comments", response_model=CommentOut)
def add_comment(token: str, body: CommentCreate, request: Request) -> dict[str, Any]:
    result = resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    author = request.headers.get("X-Reviewer-Name", "Anonymous")
    comment: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "session": session["id"],
        "scene": body.scene,
        "anchor": body.anchor.model_dump(),
        "author": author,
        "text": body.text,
        "created": datetime.now(timezone.utc).isoformat(),
        "resolved": False,
    }
    project_root = config.WRITING_ROOT / slug
    _save_comment(project_root, body.scene, comment)
    return comment


@review_router.patch("/{token}/comments/{comment_id}", response_model=CommentOut)
def update_comment(token: str, comment_id: str, body: CommentUpdate) -> dict[str, Any]:
    result = resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    updates: dict[str, Any] = {k: v for k, v in body.model_dump().items() if v is not None}
    project_root = config.WRITING_ROOT / slug
    comment = _update_comment(project_root, session.get("chapters", []), comment_id, updates)
    if comment is None:
        raise HTTPException(status_code=404, detail="comment not found")
    return comment


@review_router.get("/{token}/export")
async def export_review(token: str, format: str = Query("epub")) -> Response:
    result = resolve_token(token)
    if result is None:
        raise HTTPException(status_code=404, detail="token not found")
    session, slug = result
    if not session.get("active", True):
        raise HTTPException(status_code=404, detail="session revoked")
    if format not in ("epub", "md"):
        raise HTTPException(status_code=400, detail="format must be epub or md")
    chapter_filter = set(session.get("chapters", []))
    opts = ExportOptions(title_page=True, include_summaries=False, include_scene_beats=False)
    md = compose_manuscript(slug, opts, chapter_filter=chapter_filter)
    filename = safe_filename(slug, format)
    if format == "md":
        return Response(
            content=md.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    project = load_project(config.WRITING_ROOT / slug)
    output = await pandoc(md, "epub3", title=project.title, author=project.author)
    return Response(
        content=output,
        media_type="application/epub+zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

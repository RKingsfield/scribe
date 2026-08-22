import logging
import secrets
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TypedDict, cast

import yaml

from .. import config
from .fs import write_text_atomic
from .structure import list_chapter_dirs


class SessionData(TypedDict):
    id: str
    name: str
    token: str
    chapters: list[str]
    created: str
    expires: str
    active: bool


class CommentData(TypedDict):
    id: str
    session: str
    scene: str
    anchor: dict[str, str]
    author: str
    text: str
    created: str
    resolved: bool


class ManuscriptScene(TypedDict):
    path: str
    title: str
    html: str


class ManuscriptChapter(TypedDict):
    slug: str
    title: str
    number: int | None
    kind: str
    scenes: list[ManuscriptScene]


class ManuscriptData(TypedDict):
    title: str
    author: str
    chapters: list[ManuscriptChapter]


def _sessions_path(slug: str) -> Path:
    return config.APPDATA_ROOT / slug / "review" / "sessions.yml"


def load_sessions(slug: str) -> list[SessionData]:
    path = _sessions_path(slug)
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        logging.getLogger(__name__).warning("Invalid sessions YAML in %s", path)
        return []
    valid: list[SessionData] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        if not all(k in entry for k in ("id", "token", "chapters")):
            continue
        # Sessions created before expiry existed age out from their creation date.
        if "expires" not in entry and entry.get("created"):
            created = _parse_ts(str(entry["created"]))
            if created is not None:
                ttl = timedelta(days=config.REVIEW_SESSION_TTL_DAYS)
                entry["expires"] = (created + ttl).isoformat()
        valid.append(cast(SessionData, entry))
    return valid


def _parse_ts(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def session_expired(session: SessionData) -> bool:
    raw = session.get("expires")
    if not raw:
        return False
    dt = _parse_ts(str(raw))
    if dt is None:
        # unparseable expiry fails closed — this gates the public token surface
        return True
    return dt <= datetime.now(UTC)


def save_sessions(slug: str, sessions: list[SessionData]) -> None:
    path = _sessions_path(slug)
    write_text_atomic(path, yaml.dump(sessions, allow_unicode=True))


def _comments_path(scene_path: Path) -> Path:
    return scene_path.parent / "comments.yml"


# Serializes the comments.yml read-modify-write so concurrent posts don't lose updates.
_comments_lock = threading.Lock()


def load_comments(project_root: Path, chapter_dirs: list[str], session_id: str) -> list[CommentData]:
    result: list[CommentData] = []
    for chapter_rel in chapter_dirs:
        path = project_root / chapter_rel / "comments.yml"
        if not path.exists():
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        result.extend(c for c in data if c.get("session") == session_id)
    return result


def save_comment(scene_path: Path, comment: CommentData) -> None:
    path = _comments_path(scene_path)
    with _comments_lock:
        existing: list[CommentData] = []
        if path.exists():
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                existing = data
        existing.append(comment)
        write_text_atomic(path, yaml.dump(existing, allow_unicode=True))


def delete_session_comments(project_root: Path, session_id: str) -> None:
    # Cascades across every chapter dir, not just the session's current `chapters`
    # list, so PATCH-narrowing chapters before delete can't orphan comments.
    with _comments_lock:
        for chapter_dir in list_chapter_dirs(project_root):
            path = project_root / chapter_dir.rel_path / "comments.yml"
            if not path.exists():
                continue
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                continue
            remaining = [c for c in data if c.get("session") != session_id]
            if len(remaining) == len(data):
                continue
            if remaining:
                write_text_atomic(path, yaml.dump(remaining, allow_unicode=True))
            else:
                path.unlink()


def update_comment(
    project_root: Path,
    chapter_dirs: list[str],
    session_id: str,
    comment_id: str,
    updates: dict[str, Any],
) -> CommentData | None:
    with _comments_lock:
        for chapter_rel in chapter_dirs:
            path = project_root / chapter_rel / "comments.yml"
            if not path.exists():
                continue
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                continue
            for comment in data:
                if comment.get("id") == comment_id and comment.get("session") == session_id:
                    comment.update(updates)
                    write_text_atomic(path, yaml.dump(data, allow_unicode=True))
                    return cast(CommentData, comment)
    return None


def resolve_token(token: str) -> tuple[SessionData, str] | None:
    """Scan all projects for a session matching token. Returns (session, slug) or None."""
    if not config.APPDATA_ROOT.exists():
        return None
    for project_dir in config.APPDATA_ROOT.iterdir():
        if not project_dir.is_dir():
            continue
        slug = project_dir.name
        for session in load_sessions(slug):
            if secrets.compare_digest(str(session.get("token", "")), token):
                return session, slug
    return None

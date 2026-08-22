"""Tree-building helpers: read chapter/scene/reference entries from disk."""

from __future__ import annotations

from pathlib import Path
from typing import Any, TypedDict

from . import frontmatter as fm
from . import structure
from .helpers import classify_chapter_kind, coerce_order, order_sort_key


class SceneEntryData(TypedDict):
    path: str
    title: str | None
    summary: str | None
    scene: int | None
    order: float | None
    pov: str | None
    status: str | None
    words_target: int | None
    word_count: int


class ChapterEntryData(TypedDict):
    path: str
    meta_path: str
    slug: str
    kind: str
    title: str | None
    summary: str | None
    chapter: int | None
    interlude: int | None
    order: float | None
    act: str | None
    scenes: list[SceneEntryData]
    word_count: int


class ReferenceEntryData(TypedDict):
    path: str
    title: str | None
    aliases: list[str]
    tags: list[str]
    order: float | None


def _coerce_str_list(v: Any) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v if x is not None and str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [s.strip() for s in v.split(",") if s.strip()]
    return []


def read_scene_entry(rel_path: str, body_path: Path) -> SceneEntryData:
    text = body_path.read_text(encoding="utf-8")
    meta, body = fm.parse_lenient(text)
    return {
        "path": rel_path,
        "title": meta.get("title"),
        "summary": meta.get("summary"),
        "scene": meta.get("scene"),
        "order": coerce_order(meta.get("order")),
        "pov": meta.get("pov"),
        "status": meta.get("status"),
        "words_target": meta.get("words_target"),
        "word_count": fm.word_count(body),
    }


def read_chapter_scenes(
    project_root: Path, chapter_slug: str
) -> list[tuple[float | None, str, dict[str, Any], str]]:
    """Read a chapter's scenes in one pass, sorted by order.

    Returns (order, rel_path, meta, body) tuples.
    """
    entries: list[tuple[float | None, str, dict[str, Any], str]] = []
    for s in structure.list_scenes(project_root, chapter_slug):
        text = (project_root / s.rel_path).read_text(encoding="utf-8")
        meta, body = fm.parse_lenient(text)
        entries.append((coerce_order(meta.get("order")), s.rel_path, meta, body))
    entries.sort(key=lambda t: order_sort_key(t[0], t[1]))
    return entries


def read_chapter_entry(project_root: Path, ch: structure.ChapterDir) -> ChapterEntryData:
    meta_fp = project_root / ch.meta_rel_path
    meta_text = meta_fp.read_text(encoding="utf-8")
    meta, _meta_body = fm.parse_lenient(meta_text)
    scenes_raw = [
        read_scene_entry(s.rel_path, project_root / s.rel_path)
        for s in structure.list_scenes(project_root, ch.slug)
    ]
    scenes_raw.sort(key=lambda s: order_sort_key(s["order"], s["path"]))
    kind = classify_chapter_kind(meta)
    chapter_n = meta.get("chapter") if kind == "chapter" else None
    interlude_n = meta.get("interlude") if kind == "interlude" else None
    return {
        "path": ch.rel_path,
        "meta_path": ch.meta_rel_path,
        "slug": ch.slug,
        "kind": kind,
        "title": meta.get("title"),
        "summary": meta.get("summary"),
        "chapter": chapter_n,
        "interlude": interlude_n,
        "order": coerce_order(meta.get("order")),
        "act": meta.get("act"),
        "scenes": scenes_raw,
        "word_count": sum(s["word_count"] for s in scenes_raw),
    }


def read_reference_entry(rel_path: str, body_path: Path) -> ReferenceEntryData:
    text = body_path.read_text(encoding="utf-8")
    meta, _ = fm.parse(text)
    return {
        "path": rel_path,
        "title": meta.get("title"),
        "aliases": _coerce_str_list(meta.get("aliases")),
        "tags": _coerce_str_list(meta.get("tags")),
        "order": coerce_order(meta.get("order")),
    }

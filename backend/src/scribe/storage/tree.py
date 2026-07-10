"""Tree-building helpers: read chapter/scene/reference entries from disk."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import frontmatter as fm
from . import structure
from .helpers import classify_chapter_kind, order_sort_key


def _coerce_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _coerce_str_list(v: Any) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v if x is not None and str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [s.strip() for s in v.split(",") if s.strip()]
    return []


def read_scene_entry(rel_path: str, body_path: Path) -> dict[str, Any]:
    text = body_path.read_text(encoding="utf-8")
    meta, body = fm.parse(text)
    return {
        "path": rel_path,
        "title": meta.get("title"),
        "summary": meta.get("summary"),
        "scene": meta.get("scene"),
        "order": _coerce_float(meta.get("order")),
        "pov": meta.get("pov"),
        "status": meta.get("status"),
        "words_target": meta.get("words_target"),
        "word_count": fm.word_count(body),
    }


def read_chapter_entry(project_root: Path, ch: structure.ChapterDir) -> dict[str, Any]:
    meta_fp = project_root / ch.meta_rel_path
    meta_text = meta_fp.read_text(encoding="utf-8")
    meta, _meta_body = fm.parse(meta_text)
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
        "order": _coerce_float(meta.get("order")),
        "pov": meta.get("pov"),
        "status": meta.get("status"),
        "words_target": meta.get("words_target"),
        "act": meta.get("act"),
        "scenes": scenes_raw,
        "word_count": sum(s["word_count"] for s in scenes_raw),
    }


def read_reference_entry(rel_path: str, body_path: Path) -> dict[str, Any]:
    text = body_path.read_text(encoding="utf-8")
    meta, _ = fm.parse(text)
    return {
        "path": rel_path,
        "title": meta.get("title"),
        "aliases": _coerce_str_list(meta.get("aliases")),
        "tags": _coerce_str_list(meta.get("tags")),
        "order": _coerce_float(meta.get("order")),
    }

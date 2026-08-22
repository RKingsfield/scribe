"""Compose an on-disk project into a single markdown manuscript."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..storage import frontmatter as fm
from ..storage import paths, structure
from ..storage.helpers import coerce_order, order_sort_key
from ..storage.project import load_project
from ..storage.tree import read_chapter_scenes

SCENE_BEAT_RE = re.compile(r"\[\[(.*?)\]\]", re.DOTALL)


@dataclass
class ExportOptions:
    include_summaries: bool = False
    include_scene_beats: bool = False
    title_page: bool = True


@dataclass
class SceneData:
    rel_path: str
    title: str
    body: str
    meta: dict[str, Any]


@dataclass
class ChapterData:
    slug: str
    rel_path: str
    title: str
    meta: dict[str, Any]
    body: str
    scenes: list[SceneData] = field(default_factory=list)


def strip_scene_beats(body: str) -> str:
    return SCENE_BEAT_RE.sub("", body)


def walk_chapters(
    project_root: Path,
    chapter_filter: set[str] | None = None,
) -> list[ChapterData]:
    """Walk chapters and scenes in order, returning structured data."""
    chapter_dirs = structure.list_chapter_dirs(project_root)
    if chapter_filter is not None:
        chapter_dirs = [ch for ch in chapter_dirs if ch.rel_path in chapter_filter]

    entries: list[tuple[float | None, structure.ChapterDir, dict[str, Any], str]] = []
    for ch in chapter_dirs:
        meta_text = (project_root / ch.meta_rel_path).read_text(encoding="utf-8")
        meta, body = fm.parse_lenient(meta_text)
        entries.append((coerce_order(meta.get("order")), ch, meta, body))
    entries.sort(key=lambda t: order_sort_key(t[0], t[1].slug))

    result: list[ChapterData] = []
    for _, ch, ch_meta, ch_body in entries:
        chapter = ChapterData(
            slug=ch.slug,
            rel_path=ch.rel_path,
            title=ch_meta.get("title") or ch.slug,
            meta=ch_meta,
            body=ch_body,
            scenes=[],
        )
        for _, rel_path, s_meta, s_body in read_chapter_scenes(project_root, ch.slug):
            chapter.scenes.append(SceneData(
                rel_path=rel_path,
                title=str(s_meta.get("title", "")),
                body=s_body,
                meta=s_meta,
            ))
        result.append(chapter)
    return result


def compose_manuscript(slug: str, options: ExportOptions | None = None, chapter_filter: set[str] | None = None) -> str:
    """Build the unified markdown for a scribe project.

    chapter_filter: if set, only include chapters whose rel_path is in this set.
    """
    opts = options or ExportOptions()
    project_root = paths.project_root(slug)
    project = load_project(project_root)

    parts: list[str] = []
    if opts.title_page:
        parts.append(f"# {project.title}\n")
        if project.author:
            parts.append(f"_{project.author}_\n")
        parts.append("\n\\newpage\n")

    chapters = walk_chapters(project_root, chapter_filter)

    for ch in chapters:
        parts.append(f"\n# {ch.title}\n")

        if opts.include_summaries and ch.meta.get("summary"):
            parts.append(f"\n_{ch.meta['summary']}_\n")

        if ch.body.strip():
            parts.append(ch.body.strip() + "\n")

        for i, scene in enumerate(ch.scenes):
            cleaned = scene.body if opts.include_scene_beats else strip_scene_beats(scene.body)
            if i > 0:
                parts.append("\n***\n")
            parts.append("\n" + cleaned.strip() + "\n")

    return "\n".join(parts)

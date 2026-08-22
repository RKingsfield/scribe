from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class SceneFile:
    rel_path: str
    chapter_slug: str
    scene_filename: str


@dataclass
class ChapterDir:
    slug: str
    rel_path: str
    meta_rel_path: str


CHAPTER_META_BASENAME = "chapter.md"


def list_chapter_dirs(project_root: Path) -> list[ChapterDir]:
    chapters_dir = project_root / "chapters"
    if not chapters_dir.is_dir():
        return []
    out: list[ChapterDir] = []
    for d in sorted(chapters_dir.iterdir()):
        if not d.is_dir():
            continue
        if d.name.startswith("."):
            continue
        meta = d / CHAPTER_META_BASENAME
        if not meta.is_file():
            continue
        out.append(
            ChapterDir(
                slug=d.name,
                rel_path=f"chapters/{d.name}",
                meta_rel_path=f"chapters/{d.name}/{CHAPTER_META_BASENAME}",
            )
        )
    return out


def list_scenes(project_root: Path, chapter_slug: str) -> list[SceneFile]:
    chapter_path = project_root / "chapters" / chapter_slug
    if not chapter_path.is_dir():
        return []
    out: list[SceneFile] = []
    for fp in sorted(chapter_path.glob("*.md")):
        if fp.name == CHAPTER_META_BASENAME:
            continue
        if ".conflict." in fp.name:
            continue
        out.append(
            SceneFile(
                rel_path=f"chapters/{chapter_slug}/{fp.name}",
                chapter_slug=chapter_slug,
                scene_filename=fp.name,
            )
        )
    return out

"""Structural operations on chapters and scenes."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config
from ..storage import frontmatter as fm
from ..storage import paths
from ..storage.fs import write_text_atomic
from ..storage.helpers import (
    SLUG_RE,
    classify_chapter_kind,
    coerce_order,
    is_empty_chapter_dir,
    next_scene_number,
    order_sort_key,
    slug_position,
    slugify,
)

router = APIRouter(prefix="/api/projects/{slug}", tags=["structure"])


class NewChapterRequest(BaseModel):
    chapter: int | None = None  # starting hint; auto-computed when None
    title: str | None = None
    slug: str | None = None
    act: str | None = None
    kind: Literal["chapter", "interlude"] = "chapter"


class NewSceneRequest(BaseModel):
    title: str | None = None


class NewSimpleEntryRequest(BaseModel):
    title: str
    slug: str | None = None


def _validate_slug(s: str) -> None:
    if not SLUG_RE.match(s):
        raise HTTPException(400, f"Invalid slug: {s!r} (lowercase, digits, _-)")


@router.post("/chapter/new")
def new_chapter(slug: str, body: NewChapterRequest) -> dict[str, Any]:
    root = paths.project_root(slug)
    chapters_dir = root / "chapters"
    chapters_dir.mkdir(parents=True, exist_ok=True)

    # Walk every existing chapter dir once to compute:
    #  - max position (leading slug number) → next dir position
    #  - max chapter ordinal (frontmatter `chapter:`, only chapter-kind dirs)
    #  - max interlude ordinal (frontmatter `interlude:` or trailing slug
    #    number, only interlude-kind dirs)
    max_position = 0
    max_chapter_ordinal = 0
    max_interlude_ordinal = 0
    existing_dirs: dict[str, bool] = {}  # slug -> non_empty
    for d in chapters_dir.iterdir():
        if not d.is_dir() or d.name.startswith("."):
            continue
        non_empty = not is_empty_chapter_dir(d)
        existing_dirs[d.name] = non_empty
        pos = slug_position(d.name)
        # Only non-empty dirs claim their position. Empty orphans don't
        # block re-use of their slot.
        if non_empty and pos is not None and pos > max_position:
            max_position = pos
        meta_fp = d / "chapter.md"
        if meta_fp.is_file():
            try:
                meta, _body = fm.parse(meta_fp.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
            kind = classify_chapter_kind(meta)
            if kind == "chapter":
                ch_n = meta.get("chapter")
                if isinstance(ch_n, int) and ch_n > max_chapter_ordinal:
                    max_chapter_ordinal = ch_n
            else:  # interlude
                int_n = meta.get("interlude")
                if isinstance(int_n, int) and int_n > max_interlude_ordinal:
                    max_interlude_ordinal = int_n

    if body.slug:
        # Caller supplied an explicit slug — respect it; collide loudly
        # unless the existing dir is empty (no .md files).
        chapter_slug = body.slug
        _validate_slug(chapter_slug)
        chapter_dir = chapters_dir / chapter_slug
        if chapter_dir.exists() and not is_empty_chapter_dir(chapter_dir):
            raise HTTPException(409, f"Chapter directory exists: {chapter_slug}")
        ordinal = body.chapter or (
            max_chapter_ordinal + 1 if body.kind == "chapter"
            else max_interlude_ordinal + 1
        )
        position = slug_position(chapter_slug) or (max_position + 1)
    else:
        # Auto-pick. Position = next free leading number. Ordinal = max
        # of own kind + 1. Slug is `{pos:02d}_{Kind}_{ord:02d}`. If the
        # candidate dir collides with a non-empty existing dir we walk
        # the position upward; an empty dir is fair game.
        ordinal = (
            body.chapter
            if body.chapter is not None
            else (
                max_chapter_ordinal + 1 if body.kind == "chapter"
                else max_interlude_ordinal + 1
            )
        )
        kind_label = "Chapter" if body.kind == "chapter" else "Interlude"
        position = max_position + 1
        for _ in range(config.MAX_CHAPTER_SLOT_SEARCH):
            chapter_slug = f"{position:02d}_{kind_label}_{ordinal:02d}"
            non_empty = existing_dirs.get(chapter_slug, False)
            if not non_empty:
                break
            position += 1
        else:
            raise HTTPException(500, "Could not find a free chapter slot")
        chapter_dir = chapters_dir / chapter_slug

    chapter_dir.mkdir(parents=True, exist_ok=True)

    if body.kind == "chapter":
        default_title = body.title or f"Chapter {ordinal}"
        chapter_meta: dict[str, Any] = {
            "title": default_title,
            "summary": "",
            "chapter": ordinal,
            "order": float(position),
        }
    else:
        default_title = body.title or f"Interlude {ordinal}"
        chapter_meta = {
            "title": default_title,
            "summary": "",
            "kind": "interlude",
            "interlude": ordinal,
            "order": float(position),
        }
    if body.act:
        chapter_meta["act"] = body.act
    write_text_atomic(chapter_dir / "chapter.md", fm.serialize(chapter_meta, ""))

    scene_meta = {"scene": 1, "order": 1.0, "status": "draft"}
    write_text_atomic(chapter_dir / "01.md", fm.serialize(scene_meta, ""))

    return {
        "slug": chapter_slug,
        "chapter": ordinal if body.kind == "chapter" else None,
        "interlude": ordinal if body.kind == "interlude" else None,
        "kind": body.kind,
        "position": position,
        "path": f"chapters/{chapter_slug}",
        "meta_path": f"chapters/{chapter_slug}/chapter.md",
        "first_scene_path": f"chapters/{chapter_slug}/01.md",
    }


@router.delete("/chapter/{chapter_slug}", status_code=204)
def delete_chapter(slug: str, chapter_slug: str) -> None:
    _validate_slug(chapter_slug)
    root = paths.project_root(slug)
    chapter_dir = root / "chapters" / chapter_slug
    if not chapter_dir.is_dir():
        return
    if chapter_dir.resolve().parent != (root / "chapters").resolve():
        raise HTTPException(400, "Refusing to delete outside chapters/")
    shutil.rmtree(chapter_dir)


@router.post("/chapter/{chapter_slug}/scene/new")
def new_scene(slug: str, chapter_slug: str, body: NewSceneRequest) -> dict[str, Any]:
    _validate_slug(chapter_slug)
    root = paths.project_root(slug)
    chapter_dir = root / "chapters" / chapter_slug
    if not chapter_dir.is_dir():
        raise HTTPException(404, f"Chapter not found: {chapter_slug}")
    n = next_scene_number(chapter_dir)
    filename = f"{n:02d}.md"
    scene_meta: dict[str, Any] = {"scene": n, "order": float(n)}
    if body.title:
        scene_meta["title"] = body.title
    write_text_atomic(chapter_dir / filename, fm.serialize(scene_meta, ""))
    return {
        "scene": n,
        "path": f"chapters/{chapter_slug}/{filename}",
    }


@router.post("/character/new")
def new_character(slug: str, body: NewSimpleEntryRequest) -> dict[str, Any]:
    return _new_simple(slug, "character-profiles", body)


@router.post("/reference/new")
def new_reference(slug: str, body: NewSimpleEntryRequest) -> dict[str, Any]:
    return _new_simple(slug, "references", body)


@router.post("/category/{folder}/new")
def new_category_entry(slug: str, folder: str, body: NewSimpleEntryRequest) -> dict[str, Any]:
    _validate_slug(folder)
    return _new_simple(slug, folder, body)


def _new_simple(slug: str, folder: str, body: NewSimpleEntryRequest) -> dict[str, Any]:
    root = paths.project_root(slug)
    file_slug = body.slug or slugify(body.title)
    _validate_slug(file_slug)
    target_dir = root / folder
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{file_slug}.md"
    if target.exists():
        raise HTTPException(409, f"{folder}/{file_slug}.md already exists")
    max_order = 0.0
    for fp in target_dir.glob("*.md"):
        try:
            existing_meta, _ = fm.parse(fp.read_text(encoding="utf-8"))
            v = existing_meta.get("order")
            if v is not None:
                max_order = max(max_order, float(v))
        except (OSError, ValueError):
            pass
    meta: dict[str, Any] = {"title": body.title, "aliases": [], "order": max_order + 1.0}
    write_text_atomic(target, fm.serialize(meta, ""))
    return {"path": f"{folder}/{file_slug}.md", "title": body.title}


class ReorderItem(BaseModel):
    path: str
    order: float
    # If set, also writes the `act` frontmatter field. Empty string clears it
    # (chapter has no act). None means leave act unchanged.
    act: str | None = None


class ReorderRequest(BaseModel):
    items: list[ReorderItem]


def _apply_order_updates(slug: str, items: list[ReorderItem]) -> list[str]:
    updated: list[str] = []
    for it in items:
        abs_path = paths.resolve_in_project(slug, it.path)
        if not abs_path.is_file():
            continue
        text = abs_path.read_text(encoding="utf-8")
        meta, content = fm.parse(text)
        meta["order"] = it.order
        if it.act is not None:
            if it.act == "":
                meta.pop("act", None)
            else:
                meta["act"] = it.act
        write_text_atomic(abs_path, fm.serialize(meta, content))
        updated.append(it.path)
    return updated


def _renumber_chapter_ordinals(slug: str) -> None:
    """Walk all chapters in order and renumber chapter/interlude ordinals."""
    root = paths.project_root(slug)
    chapters_dir = root / "chapters"
    if not chapters_dir.is_dir():
        return

    entries: list[tuple[Path, dict[str, Any], str]] = []
    for d in chapters_dir.iterdir():
        if not d.is_dir() or d.name.startswith("."):
            continue
        meta_fp = d / "chapter.md"
        if not meta_fp.is_file():
            continue
        text = meta_fp.read_text(encoding="utf-8")
        meta, content = fm.parse(text)
        entries.append((meta_fp, meta, content))

    entries.sort(key=lambda e: order_sort_key(coerce_order(e[1].get("order")), str(e[0])))

    ch_n = 0
    int_n = 0
    for meta_fp, meta, content in entries:
        kind = classify_chapter_kind(meta)
        if kind == "interlude":
            int_n += 1
            if meta.get("interlude") != int_n:
                meta["interlude"] = int_n
                write_text_atomic(meta_fp, fm.serialize(meta, content))
        else:
            ch_n += 1
            if meta.get("chapter") != ch_n:
                meta["chapter"] = ch_n
                write_text_atomic(meta_fp, fm.serialize(meta, content))


@router.post("/reorder")
def reorder(slug: str, body: ReorderRequest) -> dict[str, Any]:
    """Bulk-update the `order` (and optionally `act`) frontmatter field for
    many files at once. Each item's path must resolve safely under the project
    root."""
    paths.project_root(slug)
    updated = _apply_order_updates(slug, body.items)
    if any(it.path.endswith("/chapter.md") for it in body.items):
        _renumber_chapter_ordinals(slug)
    return {"updated": updated, "count": len(updated)}


class SceneMoveRequest(BaseModel):
    src_path: str
    dst_chapter_slug: str
    src_order: list[ReorderItem]
    dst_order: list[ReorderItem]


class SceneMoveResponse(BaseModel):
    new_path: str
    scene: int


@router.post("/scene/move")
def move_scene(slug: str, body: SceneMoveRequest) -> SceneMoveResponse:
    root = paths.project_root(slug)

    _validate_slug(body.dst_chapter_slug)
    dst_chapter_dir = root / "chapters" / body.dst_chapter_slug
    if not (dst_chapter_dir / "chapter.md").is_file():
        raise HTTPException(404, f"Destination chapter not found: {body.dst_chapter_slug}")

    src_abs = paths.resolve_in_project(slug, body.src_path)
    if not src_abs.is_file():
        raise HTTPException(404, f"Source scene not found: {body.src_path}")
    if src_abs.name == "chapter.md":
        raise HTTPException(400, "Cannot move chapter.md")

    src_chapter_dir = src_abs.parent
    if src_chapter_dir.resolve() == dst_chapter_dir.resolve():
        raise HTTPException(400, "Same-chapter reorder uses /reorder")

    new_n = next_scene_number(dst_chapter_dir)

    text = src_abs.read_text(encoding="utf-8")
    meta, body_content = fm.parse(text)
    meta["scene"] = new_n
    for item in body.dst_order:
        if item.path == body.src_path:
            meta["order"] = item.order
            break

    new_filename = f"{new_n:02d}.md"
    new_abs = dst_chapter_dir / new_filename
    write_text_atomic(new_abs, fm.serialize(meta, body_content))
    src_abs.unlink()

    for conflict_file in src_chapter_dir.glob(f"{src_abs.stem}.conflict.*"):
        shutil.move(str(conflict_file), str(dst_chapter_dir / conflict_file.name))

    _apply_order_updates(slug, [it for it in body.src_order if it.path != body.src_path])
    _apply_order_updates(slug, [it for it in body.dst_order if it.path != body.src_path])

    rel_path = f"chapters/{body.dst_chapter_slug}/{new_filename}"
    return SceneMoveResponse(new_path=rel_path, scene=new_n)

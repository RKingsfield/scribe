"""Shared helpers used across routes and export layers."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

LEADING_NUM_RE = re.compile(r"^(\d+)")
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

ORDER_FALLBACK = 1e9


def coerce_order(v: str | float | None) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "untitled"


def classify_chapter_kind(meta: dict[str, Any]) -> str:
    kind = meta.get("kind")
    return kind if kind in ("chapter", "interlude") else "chapter"


def slug_position(slug: str) -> int | None:
    m = LEADING_NUM_RE.match(slug)
    return int(m.group(1)) if m else None



def order_sort_key(order: float | None, fallback: str = "") -> tuple[float, str]:
    return (order if order is not None else ORDER_FALLBACK, fallback)


def is_empty_chapter_dir(chapter_dir: Path) -> bool:
    """A chapter dir is "empty" (safe to re-use) if it contains no .md files."""
    if not chapter_dir.is_dir():
        return False
    for p in chapter_dir.iterdir():
        if p.suffix == ".md":
            return False
    return True


def next_scene_number(chapter_dir: Path) -> int:
    nums: list[int] = []
    for p in chapter_dir.glob("*.md"):
        if p.name == "chapter.md":
            continue
        try:
            nums.append(int(p.stem))
        except ValueError:
            pass
    return (max(nums) + 1) if nums else 1

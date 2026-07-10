from pathlib import Path
from fastapi import HTTPException

from .. import config


def writing_root() -> Path:
    return Path(config.WRITING_ROOT)


def list_projects() -> list[str]:
    root = writing_root()
    if not root.is_dir():
        return []
    return sorted(
        p.name for p in root.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    )


def project_root(slug: str, must_exist: bool = True) -> Path:
    if not slug or "/" in slug or "\\" in slug or slug.startswith("."):
        raise HTTPException(400, f"Invalid project slug: {slug!r}")
    root = writing_root() / slug
    if must_exist and not root.is_dir():
        raise HTTPException(404, f"Project not found: {slug}")
    resolved = root.resolve()
    base = writing_root().resolve()
    try:
        resolved.relative_to(base)
    except ValueError:
        raise HTTPException(400, "Path escape detected")
    return root


def resolve_in_project(slug: str, rel_path: str) -> Path:
    root = project_root(slug)
    if not rel_path:
        raise HTTPException(400, "Empty path")
    p = Path(rel_path)
    if p.is_absolute() or any(part in {"..", ""} for part in p.parts):
        raise HTTPException(400, f"Invalid path: {rel_path!r}")
    abs_path = (root / p).resolve()
    try:
        # .resolve() on both sides ensures symlinks pointing outside the project are rejected
        abs_path.relative_to(root.resolve())
    except ValueError:
        raise HTTPException(400, "Path escape detected")
    return abs_path

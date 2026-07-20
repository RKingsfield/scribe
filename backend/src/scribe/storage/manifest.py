from pathlib import Path
from typing import Any

from .fs import sha256_text

TRACKED_SUFFIXES = {".md", ".yml", ".yaml", ".txt"}


def walk_project(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel_parts = p.relative_to(root).parts
        if any(part.startswith(".") for part in rel_parts):
            continue
        if p.suffix not in TRACKED_SUFFIXES:
            continue
        rel = p.relative_to(root).as_posix()
        st = p.stat()
        try:
            text = p.read_text(encoding="utf-8")
            sha = sha256_text(text)
        except UnicodeDecodeError:
            sha = "binary"
        out.append({
            "path": rel,
            "mtime_ns": st.st_mtime_ns,
            "size": st.st_size,
            "sha256": sha,
        })
    return out

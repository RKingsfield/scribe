from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict

from .fs import sha256_text

TRACKED_SUFFIXES = {".md", ".yml", ".yaml", ".txt"}


class ManifestEntry(TypedDict):
    path: str
    mtime_ns: int
    size: int
    sha256: str


def iter_tracked_files(root: Path) -> Iterator[Path]:
    """Yield every tracked file under root, sorted, skipping hidden paths and
    untracked suffixes. Shared by the manifest walk and the conflict scan."""
    if not root.is_dir():
        return
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix not in TRACKED_SUFFIXES:
            continue
        if any(part.startswith(".") for part in p.relative_to(root).parts):
            continue
        yield p


def walk_project(root: Path) -> list[ManifestEntry]:
    out: list[ManifestEntry] = []
    for p in iter_tracked_files(root):
        rel = p.relative_to(root).as_posix()
        st = p.stat()
        try:
            sha = sha256_text(p.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            sha = "binary"
        out.append({
            "path": rel,
            "mtime_ns": st.st_mtime_ns,
            "size": st.st_size,
            "sha256": sha,
        })
    return out

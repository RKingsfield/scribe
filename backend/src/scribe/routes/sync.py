import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..storage import paths
from ..storage.manifest import ManifestEntry, iter_tracked_files, walk_project

router = APIRouter(prefix="/api/projects/{slug}", tags=["sync"])

_CONFLICT_RE = re.compile(
    r"^(?P<base>.+)\.conflict\."
    r"(?P<device>[A-Za-z0-9_-]+)\."
    r"(?P<ts>\d{8}T\d{6}Z)\."
    r"(?P<ext>[^.]+)$"
)


class Manifest(BaseModel):
    slug: str
    entries: list[ManifestEntry]


class ConflictEntry(BaseModel):
    path: str            # the conflict file itself, relative to project root
    canonical_path: str  # the file it forks from
    device_id: str
    timestamp: str       # YYYYMMDDTHHMMSSZ
    size: int
    mtime_ns: int


class ConflictList(BaseModel):
    slug: str
    conflicts: list[ConflictEntry]


@router.get("/sync", response_model=Manifest)
def get_manifest(slug: str) -> Manifest:
    root = paths.project_root(slug)
    return Manifest(slug=slug, entries=walk_project(root))


@router.get("/conflicts", response_model=ConflictList)
def list_conflicts(slug: str) -> ConflictList:
    root = paths.project_root(slug)
    out: list[ConflictEntry] = []
    for p in iter_tracked_files(root):
        name = p.name
        m = _CONFLICT_RE.match(name)
        if not m:
            continue
        rel = p.relative_to(root).as_posix()
        prefix = rel[: -len(name)]
        canonical = f"{prefix}{m['base']}.{m['ext']}"
        st = p.stat()
        out.append(
            ConflictEntry(
                path=rel,
                canonical_path=canonical,
                device_id=m["device"],
                timestamp=m["ts"],
                size=st.st_size,
                mtime_ns=st.st_mtime_ns,
            )
        )
    return ConflictList(slug=slug, conflicts=out)


@router.delete("/conflicts", status_code=204)
def discard_conflict(slug: str, path: str = Query(...)) -> None:
    abs_path = paths.resolve_in_project(slug, path)
    name = abs_path.name
    if not _CONFLICT_RE.match(name):
        raise HTTPException(400, "Not a conflict file")
    if not abs_path.is_file():
        raise HTTPException(404, "Conflict file not found")
    abs_path.unlink()

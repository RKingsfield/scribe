import re
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Response
from pydantic import BaseModel

from ..storage import frontmatter as fm
from ..storage import paths
from ..storage.fs import file_etag, write_text_atomic

router = APIRouter(prefix="/api/projects/{slug}", tags=["files"])

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class FileGet(BaseModel):
    path: str
    body: str
    frontmatter: dict[str, Any]
    etag: str
    word_count: int


class FilePut(BaseModel):
    body: str
    frontmatter: dict[str, Any] = {}


class FilePutResult(FileGet):
    conflict: bool = False
    conflict_path: str | None = None


class FileMove(BaseModel):
    src: str
    dst: str


@router.get("/file", response_model=FileGet)
def get_file(slug: str, path: str = Query(...)) -> FileGet:
    abs_path = paths.resolve_in_project(slug, path)
    if not abs_path.is_file():
        raise HTTPException(404, f"File not found: {path}")
    text = abs_path.read_text(encoding="utf-8")
    meta, body = fm.parse(text)
    return FileGet(
        path=path,
        body=body,
        frontmatter=meta,
        etag=file_etag(abs_path),
        word_count=fm.word_count(body),
    )


@router.put("/file", response_model=FilePutResult)
def put_file(
    slug: str,
    payload: FilePut,
    response: Response,
    path: str = Query(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
    on_conflict: str | None = Header(default=None, alias="X-On-Conflict"),
    device_id: str | None = Header(default=None, alias="X-Device-Id"),
) -> FilePutResult:
    abs_path = paths.resolve_in_project(slug, path)
    if abs_path.exists() and if_match is not None:
        current = file_etag(abs_path)
        if if_match != current:
            if on_conflict == "save-as-conflict":
                conflict_rel = _write_conflict(slug, path, payload, device_id)
                response.headers["ETag"] = current
                return FilePutResult(
                    path=path,
                    body=payload.body,
                    frontmatter=payload.frontmatter or {},
                    etag=current,
                    word_count=fm.word_count(payload.body),
                    conflict=True,
                    conflict_path=conflict_rel,
                )
            raise HTTPException(412, f"etag mismatch (server={current})")
    text = fm.serialize(payload.frontmatter or {}, payload.body)
    write_text_atomic(abs_path, text)
    new_etag = file_etag(abs_path)
    response.headers["ETag"] = new_etag
    return FilePutResult(
        path=path,
        body=payload.body,
        frontmatter=payload.frontmatter or {},
        etag=new_etag,
        word_count=fm.word_count(payload.body),
    )


def _write_conflict(
    slug: str,
    rel_path: str,
    payload: FilePut,
    device_id: str | None,
) -> str:
    did = device_id if (device_id and _DEVICE_ID_RE.match(device_id)) else "unknown"
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    base, dot, ext = rel_path.rpartition(".")
    stem = base if dot else rel_path
    suffix = ext if dot else "md"
    conflict_rel = f"{stem}.conflict.{did}.{ts}.{suffix}"
    abs_conflict = paths.resolve_in_project(slug, conflict_rel)
    text = fm.serialize(payload.frontmatter or {}, payload.body)
    write_text_atomic(abs_conflict, text)
    return conflict_rel


@router.delete("/file", status_code=204)
def delete_file(slug: str, path: str = Query(...)) -> Response:
    abs_path = paths.resolve_in_project(slug, path)
    if not abs_path.is_file():
        raise HTTPException(404, f"File not found: {path}")
    abs_path.unlink()
    return Response(status_code=204)


@router.post("/file/move", response_model=FileGet)
def move_file(slug: str, move: FileMove, response: Response) -> FileGet:
    src = paths.resolve_in_project(slug, move.src)
    dst = paths.resolve_in_project(slug, move.dst)
    if not src.is_file():
        raise HTTPException(404, f"Source not found: {move.src}")
    if dst.exists():
        raise HTTPException(409, f"Destination exists: {move.dst}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    text = dst.read_text(encoding="utf-8")
    meta, body = fm.parse(text)
    new_etag = file_etag(dst)
    response.headers["ETag"] = new_etag
    return FileGet(
        path=move.dst,
        body=body,
        frontmatter=meta,
        etag=new_etag,
        word_count=fm.word_count(body),
    )

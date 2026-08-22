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


@router.get("/file", response_model=FileGet)
def get_file(slug: str, path: str = Query(...)) -> FileGet:
    abs_path = paths.resolve_in_project(slug, path)
    if not abs_path.is_file():
        raise HTTPException(404, f"File not found: {path}")
    raw = abs_path.read_bytes()
    # etag must hash the same bytes PUT's If-Match check does, not read_text()'s
    # universal-newline-translated form, or CRLF files 412 forever.
    # Lenient parse: a broken header comes back as editable body text, and
    # serialize({}, body) round-trips it unchanged, so the file is fixable in-app.
    meta, body = fm.parse_lenient(raw.decode("utf-8"))
    return FileGet(
        path=path,
        body=body,
        frontmatter=meta,
        etag=file_etag(abs_path, content=raw),
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
    # An If-Match claim about a file that no longer exists is a stale-path write
    # (e.g. a conflict resolve racing a scene move) — refuse rather than create a
    # ghost. save-as-conflict callers keep the recreate path: a deleted scene with
    # queued edits resurrects loss-free instead of jamming the flush queue.
    if if_match is not None and not abs_path.exists() and on_conflict != "save-as-conflict":
        raise HTTPException(412, f"conditional write to missing file: {path}")
    if abs_path.exists() and if_match is not None:
        current = file_etag(abs_path)
        if if_match != current:
            if on_conflict == "save-as-conflict":
                conflict_rel = _write_conflict(slug, path, payload, device_id)
                canonical_text = abs_path.read_text(encoding="utf-8")
                canonical_meta, canonical_body = fm.parse_lenient(canonical_text)
                response.headers["ETag"] = current
                return FilePutResult(
                    path=path,
                    body=canonical_body,
                    frontmatter=canonical_meta,
                    etag=current,
                    word_count=fm.word_count(canonical_body),
                    conflict=True,
                    conflict_path=conflict_rel,
                )
            raise HTTPException(412, f"etag mismatch (server={current})")
    text = fm.serialize(payload.frontmatter or {}, payload.body)
    write_text_atomic(abs_path, text)
    new_etag = file_etag(abs_path, content=text.encode("utf-8"))
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
def delete_file(
    slug: str,
    path: str = Query(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> Response:
    abs_path = paths.resolve_in_project(slug, path)
    if not abs_path.is_file():
        raise HTTPException(404, f"File not found: {path}")
    # A conditional delete is a replayed offline delete: the file changed elsewhere
    # since it was queued, so refuse rather than destroy the newer edit.
    if if_match is not None:
        current = file_etag(abs_path)
        if if_match != current:
            raise HTTPException(412, f"etag mismatch (server={current})")
    abs_path.unlink()
    return Response(status_code=204)

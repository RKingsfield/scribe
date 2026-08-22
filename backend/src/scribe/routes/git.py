from fastapi import APIRouter
from pydantic import BaseModel

from ..git.autocommit import commit_and_push_project
from ..storage import paths

router = APIRouter(prefix="/api/projects/{slug}/git", tags=["git"])


class CommitResult(BaseModel):
    slug: str
    commit: str | None = None
    pushed: bool = False
    push_error: str | None = None
    status: str | None = None
    error: str | None = None


class CommitRequest(BaseModel):
    message: str | None = None


@router.post("/commit", response_model=CommitResult)
def commit_now(slug: str, body: CommitRequest | None = None) -> CommitResult:
    paths.project_root(slug)
    result = commit_and_push_project(slug, message=body.message if body else None)
    return CommitResult(**result)

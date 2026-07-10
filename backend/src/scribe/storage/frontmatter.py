from typing import Any

import frontmatter as _fm
from pydantic import BaseModel, ConfigDict, Field


class ChapterFrontmatter(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str | None = None
    summary: str | None = None
    chapter: int | None = None
    scene: int | None = None
    order: float | None = None
    status: str | None = "draft"
    words_target: int | None = None
    pov: str | None = None


class ReferenceFrontmatter(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str | None = None
    aliases: list[str] = Field(default_factory=list)


def parse(text: str) -> tuple[dict[str, Any], str]:
    post = _fm.loads(text)
    return dict(post.metadata), post.content


def serialize(meta: dict[str, Any], body: str) -> str:
    if not meta:
        return body if body.endswith("\n") else body + "\n"
    post = _fm.Post(body)
    post.metadata.update(meta)
    return _fm.dumps(post) + "\n"


def word_count(body: str) -> int:
    return len(body.split())

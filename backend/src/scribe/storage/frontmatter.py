from typing import Any

import frontmatter as _fm


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

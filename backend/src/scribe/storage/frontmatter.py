import logging
from typing import Any

import frontmatter as _fm
import yaml

log = logging.getLogger(__name__)


def parse(text: str) -> tuple[dict[str, Any], str]:
    post = _fm.loads(text)
    return dict(post.metadata), post.content


def parse_lenient(text: str) -> tuple[dict[str, Any], str]:
    """Malformed frontmatter degrades to `({}, text)` so nothing is lost."""
    try:
        return parse(text)
    except (ValueError, yaml.YAMLError) as e:
        log.warning("Malformed frontmatter, treating whole file as body: %s", e)
        return {}, text


def serialize(meta: dict[str, Any], body: str) -> str:
    if not meta:
        return body if body.endswith("\n") else body + "\n"
    post = _fm.Post(body)
    post.metadata.update(meta)
    return str(_fm.dumps(post)) + "\n"


def word_count(body: str) -> int:
    return len(body.split())

from __future__ import annotations

import logging
from urllib.parse import urlparse, urlunparse

import httpx

from .. import config

log = logging.getLogger(__name__)


def repo_name_for(slug: str) -> str:
    return f"scribe-{slug}"


def ensure_repo(base_url: str, user: str, token: str, repo_name: str) -> bool:
    """Returns True if the repo exists or was just created. False on auth/network failure."""
    if not base_url or not user or not token:
        return False
    headers = {"Authorization": f"token {token}"}
    try:
        r = httpx.get(
            f"{base_url}/api/v1/repos/{user}/{repo_name}",
            headers=headers,
            timeout=config.QDRANT_TIMEOUT,
        )
        if r.status_code == 200:
            return True
        if r.status_code == 404:
            r = httpx.post(
                f"{base_url}/api/v1/user/repos",
                headers=headers,
                json={"name": repo_name, "private": True, "auto_init": False},
                timeout=config.FORGEJO_TIMEOUT,
            )
            if r.status_code in (201, 409):
                return True
            log.warning("Forgejo repo create failed (%s): %s", r.status_code, r.text[:200])
            return False
        log.warning("Forgejo repo lookup failed (%s)", r.status_code)
        return False
    except httpx.RequestError as e:
        log.warning("Forgejo repo ensure network error: %s", e)
        return False


def push_url(base_url: str, user: str, token: str, repo_name: str) -> str:
    """HTTPS push URL with embedded credentials."""
    p = urlparse(base_url)
    netloc = f"{user}:{token}@{p.netloc}"
    return urlunparse((p.scheme, netloc, f"/{user}/{repo_name}.git", "", "", ""))

from __future__ import annotations

import logging
from pathlib import Path

from git import GitCommandError, InvalidGitRepositoryError, Repo

log = logging.getLogger(__name__)


def ensure_repo(root: Path, author_name: str, author_email: str) -> Repo:
    try:
        repo = Repo(root)
    except InvalidGitRepositoryError:
        repo = Repo.init(root, initial_branch="main")
    with repo.config_writer(config_level="repository") as cw:
        cw.set_value("user", "name", author_name)
        cw.set_value("user", "email", author_email)
        cw.set_value("commit", "gpgsign", "false")
    return repo


def commit_all_changes(repo: Repo, message: str) -> str | None:
    """Stage all changes and commit. Returns commit sha or None if nothing to commit."""
    repo.git.add(A=True)
    try:
        repo.git.commit(m=message, allow_empty=False)
    except GitCommandError as e:
        if "nothing to commit" in str(e).lower() or "no changes added" in str(e).lower():
            return None
        raise
    return repo.head.commit.hexsha


def set_remote(repo: Repo, name: str, url: str) -> None:
    if name in [r.name for r in repo.remotes]:
        repo.remote(name).set_url(url)
    else:
        repo.create_remote(name, url=url)


def push(repo: Repo, remote_name: str = "origin", branch: str = "main") -> None:
    """Push to the named remote. Raises GitCommandError on failure."""
    repo.git.push(remote_name, branch, set_upstream=True)

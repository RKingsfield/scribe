from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler

from git import Repo

from .. import config
from ..storage import paths
from . import forgejo, repo as gitrepo

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _ensure_remote_setup(repo: Repo, slug: str) -> bool:
    token = os.environ.get("FORGEJO_TOKEN", "")
    if not (config.FORGEJO_BASE_URL and config.FORGEJO_USER and token):
        return False
    repo_name = forgejo.repo_name_for(slug)
    if not forgejo.ensure_repo(
        config.FORGEJO_BASE_URL, config.FORGEJO_USER, token, repo_name
    ):
        return False
    url = forgejo.push_url(
        config.FORGEJO_BASE_URL, config.FORGEJO_USER, token, repo_name
    )
    gitrepo.set_remote(repo, "origin", url)
    return True


def commit_and_push_project(slug: str, message: str | None = None) -> dict[str, Any]:
    project_root = paths.writing_root() / slug
    if not project_root.is_dir():
        return {"slug": slug, "status": "no-project"}

    if message is None:
        message = f"auto: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"

    repo = gitrepo.ensure_repo(
        project_root, config.GIT_AUTHOR_NAME, config.GIT_AUTHOR_EMAIL
    )
    sha = gitrepo.commit_all_changes(repo, message)

    pushed = False
    push_error: str | None = None
    if _ensure_remote_setup(repo, slug):
        try:
            gitrepo.push(repo)
            pushed = True
        except Exception as e:
            push_error = str(e)
            log.warning("push failed for %s: %s", slug, e)

    return {
        "slug": slug,
        "commit": sha,
        "pushed": pushed,
        "push_error": push_error,
    }


def commit_all_projects() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for slug in paths.list_projects():
        try:
            out.append(commit_and_push_project(slug))
        except Exception as e:
            log.exception("autocommit failed for %s", slug)
            out.append({"slug": slug, "error": str(e)})
    return out


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    interval = int(os.environ.get("AUTOCOMMIT_INTERVAL_MIN", "10"))
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(
        commit_all_projects,
        "interval",
        minutes=interval,
        id="autocommit",
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    log.info("autocommit scheduler started (every %d min)", interval)


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None

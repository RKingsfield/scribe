from __future__ import annotations

import logging
import re
import threading
from datetime import UTC, datetime
from typing import TypedDict

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from git import Repo

from .. import config
from ..storage import paths
from . import forgejo
from . import repo as gitrepo

log = logging.getLogger(__name__)


class CommitPushResult(TypedDict, total=False):
    slug: str
    commit: str | None
    pushed: bool
    push_error: str | None
    status: str
    error: str

_scheduler: BackgroundScheduler | None = None
_last_alert: dict[str, datetime] = {}
_ALERT_COOLDOWN_SECONDS = 3600

_CREDENTIAL_RE = re.compile(r"://[^/@\s]+@")


def _redact_credentials(text: str) -> str:
    """Strip user:token@ from any URL embedded in a git error string before it leaves the process."""
    return _CREDENTIAL_RE.sub("://***@", text)


# Serializes the commit path: manual POST /git/commit and the autocommit scheduler
# both call commit_and_push_project, and racing `git add`/`git commit` on the same
# repo trips a stale .git/index.lock.
_commit_lock = threading.Lock()


def _ensure_remote_setup(repo: Repo, slug: str) -> bool:
    token = config.forgejo_token()
    if not (config.FORGEJO_BASE_URL and config.FORGEJO_USER and token):
        return False
    repo_name = forgejo.repo_name_for(slug)
    if not forgejo.ensure_repo(config.FORGEJO_BASE_URL, config.FORGEJO_USER, token, repo_name):
        return False
    url = forgejo.push_url(
        config.FORGEJO_BASE_URL, config.FORGEJO_USER, token, repo_name
    )
    gitrepo.set_remote(repo, "origin", url)
    return True


def commit_and_push_project(slug: str, message: str | None = None) -> CommitPushResult:
    project_root = paths.writing_root() / slug
    if not project_root.is_dir():
        return {"slug": slug, "status": "no-project"}

    if message is None:
        message = f"auto: {datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}"

    with _commit_lock:
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
            except Exception as e:  # noqa: BLE001 — best-effort push; any failure is recorded, not raised
                push_error = _redact_credentials(str(e))
                log.warning("push failed for %s: %s", slug, e)

    return {
        "slug": slug,
        "commit": sha,
        "pushed": pushed,
        "push_error": push_error,
    }


def _send_alert(slug: str, error: str) -> None:
    if not config.ALERT_WEBHOOK_URL:
        return
    now = datetime.now(UTC)
    last = _last_alert.get(slug)
    if last and (now - last).total_seconds() < _ALERT_COOLDOWN_SECONDS:
        return
    title = f"scribe: autocommit failed ({slug})"
    message = f"autocommit failed for {slug}: {_redact_credentials(error)}"
    headers: dict[str, str] = {}
    if config.ALERT_WEBHOOK_TOKEN:
        headers["Authorization"] = f"Bearer {config.ALERT_WEBHOOK_TOKEN}"
    try:
        if config.ALERT_WEBHOOK_STYLE == "ntfy":
            headers.update({"Title": title, "Priority": "high", "Tags": "warning"})
            httpx.post(config.ALERT_WEBHOOK_URL, content=message, headers=headers, timeout=10)
        else:
            httpx.post(
                config.ALERT_WEBHOOK_URL,
                json={"title": title, "message": message},
                headers=headers,
                timeout=10,
            )
        _last_alert[slug] = now
    except Exception:  # noqa: BLE001 — best-effort alert; any failure is logged, not raised
        log.warning("failed to send alert for %s", slug)


def commit_all_projects() -> list[CommitPushResult]:
    out: list[CommitPushResult] = []
    for slug in paths.list_projects():
        try:
            result = commit_and_push_project(slug)
            push_error = result.get("push_error")
            if push_error:
                _send_alert(slug, push_error)
            out.append(result)
        except Exception as e:  # best-effort per-project; failures logged, not raised
            log.exception("autocommit failed for %s", slug)
            _send_alert(slug, str(e))
            out.append({"slug": slug, "error": _redact_credentials(str(e))})
    return out


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    interval = config.AUTOCOMMIT_INTERVAL_MIN
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

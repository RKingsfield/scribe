import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from scribe.git import autocommit
from scribe.git import repo as gitrepo
from scribe.git.autocommit import _send_alert, commit_and_push_project
from scribe.main import app


def test_commit_initializes_repo_and_commits(sample_project: Path) -> None:
    result = commit_and_push_project("example-novel")
    assert result["commit"] is not None
    assert (sample_project / ".git").is_dir()
    # Re-running with no changes returns commit=None.
    result2 = commit_and_push_project("example-novel")
    assert result2["commit"] is None


def test_commit_picks_up_new_files(sample_project: Path) -> None:
    commit_and_push_project("example-novel")
    (sample_project / "chapters" / "02.md").write_text(
        "---\ntitle: Chapter 2\nchapter: 2\norder: 2\n---\nFresh body.\n",
        encoding="utf-8",
    )
    result = commit_and_push_project("example-novel")
    assert result["commit"] is not None


def test_concurrent_commit_calls_do_not_race_on_index_lock(
    monkeypatch, sample_project: Path
) -> None:
    monkeypatch.delenv("FORGEJO_TOKEN", raising=False)
    commit_and_push_project("example-novel")  # establish the repo before racing

    errors: list[Exception] = []
    results: list[dict] = []
    barrier = threading.Barrier(2)

    def worker(filename: str) -> None:
        (sample_project / filename).write_text("concurrent edit\n", encoding="utf-8")
        barrier.wait()
        try:
            results.append(commit_and_push_project("example-novel"))
        except Exception as e:  # noqa: BLE001 — captured for the assertion below
            errors.append(e)

    threads = [
        threading.Thread(target=worker, args=("race-a.md",)),
        threading.Thread(target=worker, args=("race-b.md",)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert len(results) == 2


def test_no_remote_when_token_missing(monkeypatch, sample_project: Path) -> None:
    monkeypatch.delenv("FORGEJO_TOKEN", raising=False)
    result = commit_and_push_project("example-novel")
    assert result["pushed"] is False
    assert result["push_error"] is None


def test_commit_route(sample_project: Path) -> None:
    c = TestClient(app)
    r = c.post("/api/projects/example-novel/git/commit", json={"message": "manual save"})
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "example-novel"
    assert body["commit"] is not None


def test_ensure_repo_idempotent(tmp_path: Path) -> None:
    r1 = gitrepo.ensure_repo(tmp_path, "Tester", "t@example.com")
    r2 = gitrepo.ensure_repo(tmp_path, "Tester", "t@example.com")
    assert r1.git_dir == r2.git_dir


def test_send_alert_ntfy_style(monkeypatch) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "https://ntfy.example.com/alerts")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_TOKEN", "tok")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_STYLE", "ntfy")
    autocommit._last_alert.clear()

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "index.lock exists")
        mock_post.assert_called_once()
        assert "mynovel" in mock_post.call_args.kwargs["content"]
        assert mock_post.call_args.args[0] == "https://ntfy.example.com/alerts"
        assert mock_post.call_args.kwargs["headers"]["Title"].startswith("scribe:")


def test_send_alert_json_style(monkeypatch) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "https://hooks.example.com/webhook")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_TOKEN", "")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_STYLE", "json")
    autocommit._last_alert.clear()

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "some error")
        mock_post.assert_called_once()
        body = mock_post.call_args.kwargs["json"]
        assert "mynovel" in body["message"]
        assert "Authorization" not in mock_post.call_args.kwargs["headers"]


def test_send_alert_throttled(monkeypatch) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "https://ntfy.example.com/alerts")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_TOKEN", "tok")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_STYLE", "ntfy")
    autocommit._last_alert.clear()

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "err1")
        _send_alert("mynovel", "err2")
        assert mock_post.call_count == 1

    autocommit._last_alert["mynovel"] = datetime.now(UTC) - timedelta(seconds=3601)
    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "err3")
        assert mock_post.call_count == 1


def test_send_alert_skipped_without_config(monkeypatch) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "")
    autocommit._last_alert.clear()

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "error")
        mock_post.assert_not_called()


def test_send_alert_redacts_credentials_from_url(monkeypatch) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "https://hooks.example.com/webhook")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_TOKEN", "")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_STYLE", "json")
    autocommit._last_alert.clear()

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        _send_alert("mynovel", "push failed: https://user:tok3n@git.example/x.git")
        body = mock_post.call_args.kwargs["json"]
        assert "tok3n" not in body["message"]
        assert "https://***@git.example/x.git" in body["message"]


def test_commit_all_projects_alerts_on_push_failure(monkeypatch, sample_project: Path) -> None:
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_URL", "https://hooks.example.com/webhook")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_TOKEN", "")
    monkeypatch.setattr("scribe.config.ALERT_WEBHOOK_STYLE", "json")
    autocommit._last_alert.clear()

    def fake_push(*args, **kwargs):
        raise RuntimeError(
            "fatal: unable to access "
            "'https://user:tok3n@git.example/x.git/': Failed to connect"
        )

    monkeypatch.setattr(autocommit, "_ensure_remote_setup", lambda repo, slug: True)
    monkeypatch.setattr(gitrepo, "push", fake_push)

    with patch("scribe.git.autocommit.httpx.post") as mock_post:
        results = autocommit.commit_all_projects()

    mock_post.assert_called_once()
    body = mock_post.call_args.kwargs["json"]
    assert "example-novel" in body["message"]
    assert "tok3n" not in body["message"]
    assert "https://***@git.example/x.git/" in body["message"]
    assert results[0]["push_error"] is not None


def test_commit_route_redacts_push_error(monkeypatch, sample_project: Path) -> None:
    def fake_push(*args, **kwargs):
        raise RuntimeError(
            "fatal: unable to access "
            "'https://user:tok3n@git.example/x.git/': Failed to connect"
        )

    monkeypatch.setattr(autocommit, "_ensure_remote_setup", lambda repo, slug: True)
    monkeypatch.setattr(gitrepo, "push", fake_push)

    result = commit_and_push_project("example-novel")
    assert result["push_error"] is not None
    assert "tok3n" not in result["push_error"]
    assert "https://***@git.example/x.git/" in result["push_error"]

    c = TestClient(app)
    r = c.post("/api/projects/example-novel/git/commit", json={"message": "manual save"})
    assert r.status_code == 200
    body = r.json()
    assert "tok3n" not in body["push_error"]

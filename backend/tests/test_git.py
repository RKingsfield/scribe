from pathlib import Path

from fastapi.testclient import TestClient

from scribe.git import repo as gitrepo
from scribe.git.autocommit import commit_and_push_project
from scribe.main import app


def test_commit_initializes_repo_and_commits(sample_project: Path) -> None:
    result = commit_and_push_project("barrow")
    assert result["commit"] is not None
    assert (sample_project / ".git").is_dir()
    # Re-running with no changes returns commit=None.
    result2 = commit_and_push_project("barrow")
    assert result2["commit"] is None


def test_commit_picks_up_new_files(sample_project: Path) -> None:
    commit_and_push_project("barrow")
    (sample_project / "chapters" / "02.md").write_text(
        "---\ntitle: Chapter 2\nchapter: 2\norder: 2\n---\nFresh body.\n",
        encoding="utf-8",
    )
    result = commit_and_push_project("barrow")
    assert result["commit"] is not None


def test_no_remote_when_token_missing(monkeypatch, sample_project: Path) -> None:
    monkeypatch.delenv("FORGEJO_TOKEN", raising=False)
    result = commit_and_push_project("barrow")
    assert result["pushed"] is False
    assert result["push_error"] is None


def test_commit_route(sample_project: Path) -> None:
    c = TestClient(app)
    r = c.post("/api/projects/barrow/git/commit", json={"message": "manual save"})
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "barrow"
    assert body["commit"] is not None


def test_ensure_repo_idempotent(tmp_path: Path) -> None:
    r1 = gitrepo.ensure_repo(tmp_path, "Tester", "t@example.com")
    r2 = gitrepo.ensure_repo(tmp_path, "Tester", "t@example.com")
    assert r1.git_dir == r2.git_dir

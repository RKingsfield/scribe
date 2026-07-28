"""Test Forgejo integration: ensure_repo and push_url."""

from unittest.mock import patch, MagicMock

from scribe.git.forgejo import ensure_repo, push_url, repo_name_for


def test_repo_name_for() -> None:
    assert repo_name_for("my-novel") == "scribe-my-novel"


def test_push_url_embeds_credentials() -> None:
    url = push_url("https://git.example.com", "user", "tok123", "scribe-novel")
    assert url == "https://user:tok123@git.example.com/user/scribe-novel.git"


def test_push_url_preserves_port() -> None:
    url = push_url("https://git.example.com:3000", "user", "tok", "repo")
    assert "git.example.com:3000" in url
    assert url.endswith("/user/repo.git")


def test_ensure_repo_returns_false_on_empty_config() -> None:
    assert ensure_repo("", "user", "tok", "repo") is False
    assert ensure_repo("http://x", "", "tok", "repo") is False
    assert ensure_repo("http://x", "user", "", "repo") is False


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_exists(mock_httpx: MagicMock) -> None:
    mock_httpx.get.return_value = MagicMock(status_code=200)
    result = ensure_repo("https://git.example.com", "user", "tok", "repo")
    assert result is True
    mock_httpx.get.assert_called_once()


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_creates_on_404(mock_httpx: MagicMock) -> None:
    mock_httpx.get.return_value = MagicMock(status_code=404)
    mock_httpx.post.return_value = MagicMock(status_code=201)
    result = ensure_repo("https://git.example.com", "user", "tok", "repo")
    assert result is True
    mock_httpx.post.assert_called_once()


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_create_conflict_is_ok(mock_httpx: MagicMock) -> None:
    mock_httpx.get.return_value = MagicMock(status_code=404)
    mock_httpx.post.return_value = MagicMock(status_code=409)
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is True


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_create_failure(mock_httpx: MagicMock) -> None:
    mock_httpx.get.return_value = MagicMock(status_code=404)
    mock_httpx.post.return_value = MagicMock(status_code=500, text="internal error")
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is False


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_network_error(mock_httpx: MagicMock) -> None:
    import httpx
    mock_httpx.get.side_effect = httpx.RequestError("connection refused")
    mock_httpx.RequestError = httpx.RequestError
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is False

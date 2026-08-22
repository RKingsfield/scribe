"""Test Forgejo integration: ensure_repo and push_url."""

from unittest.mock import MagicMock, patch

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


def _mock_client(get_response: MagicMock, post_response: MagicMock | None = None) -> MagicMock:
    client = MagicMock()
    client.get = MagicMock(return_value=get_response)
    client.post = MagicMock(return_value=post_response)
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=client)
    ctx.__exit__ = MagicMock(return_value=False)
    return ctx


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_exists(mock_httpx: MagicMock) -> None:
    mock_httpx.Client.return_value = _mock_client(MagicMock(status_code=200))
    result = ensure_repo("https://git.example.com", "user", "tok", "repo")
    assert result is True


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_creates_on_404(mock_httpx: MagicMock) -> None:
    mock_httpx.Client.return_value = _mock_client(
        MagicMock(status_code=404), MagicMock(status_code=201)
    )
    result = ensure_repo("https://git.example.com", "user", "tok", "repo")
    assert result is True


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_create_conflict_is_ok(mock_httpx: MagicMock) -> None:
    mock_httpx.Client.return_value = _mock_client(
        MagicMock(status_code=404), MagicMock(status_code=409)
    )
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is True


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_create_failure(mock_httpx: MagicMock) -> None:
    mock_httpx.Client.return_value = _mock_client(
        MagicMock(status_code=404), MagicMock(status_code=500, text="internal error")
    )
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is False


@patch("scribe.git.forgejo.httpx")
def test_ensure_repo_network_error(mock_httpx: MagicMock) -> None:
    import httpx

    client = MagicMock()
    client.get = MagicMock(side_effect=httpx.RequestError("connection refused"))
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=client)
    ctx.__exit__ = MagicMock(return_value=False)
    mock_httpx.Client.return_value = ctx
    mock_httpx.RequestError = httpx.RequestError
    assert ensure_repo("https://git.example.com", "user", "tok", "repo") is False

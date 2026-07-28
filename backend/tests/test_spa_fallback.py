"""Test the SPA fallback route path containment check."""

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient


def _make_app(static_root: Path) -> FastAPI:
    """Build a minimal app with the same spa_fallback logic as main.py."""
    app = FastAPI()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str, request: Request) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (static_root / full_path).resolve()
        if full_path and candidate.is_file() and str(candidate).startswith(str(static_root.resolve())):
            return FileResponse(candidate)
        return FileResponse(static_root / "index.html")

    return app


def test_serves_index_for_spa_routes(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html>app</html>")
    client = TestClient(_make_app(tmp_path))
    r = client.get("/p/some-project/write")
    assert r.status_code == 200
    assert "app" in r.text


def test_serves_static_file(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "favicon.ico").write_text("icon")
    client = TestClient(_make_app(tmp_path))
    r = client.get("/favicon.ico")
    assert r.status_code == 200
    assert r.text == "icon"


def test_rejects_api_paths(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html>app</html>")
    client = TestClient(_make_app(tmp_path))
    r = client.get("/api/nonexistent")
    assert r.status_code == 404


def test_blocks_path_traversal(tmp_path: Path) -> None:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>app</html>")
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve")
    client = TestClient(_make_app(static))
    r = client.get("/../secret.txt")
    assert "do not serve" not in r.text


def test_blocks_encoded_traversal(tmp_path: Path) -> None:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>app</html>")
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve")
    client = TestClient(_make_app(static))
    r = client.get("/%2e%2e/secret.txt")
    assert "do not serve" not in r.text

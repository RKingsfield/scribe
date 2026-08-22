"""Tests for per-novel RAG recipe generation + routes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient

from scribe import config
from scribe.rag.recipe import build_recipe, collection_name


def test_collection_name_uses_scribe_prefix() -> None:
    assert collection_name("the-example-novel") == "scribe-the-example-novel"


def test_build_recipe_has_dynamic_sources_with_kind_metadata(tmp_path: Path) -> None:
    # Setup a project with specific directories
    project_slug = "test-project"
    project_dir = tmp_path / project_slug
    project_dir.mkdir()
    
    (project_dir / "chapters").mkdir()
    (project_dir / "character-profiles").mkdir()
    (project_dir / "references").mkdir()
    (project_dir / "planning").mkdir()
    (project_dir / ".git").mkdir()  # Should be skipped
    
    recipe = build_recipe(
        slug=project_slug,
        title="Test Project",
        project_path=project_dir,
        host_writing_root="/data/writing",
        qdrant_url="http://localhost",
    )

    assert recipe["corpus"] == "scribe-test-project"
    assert recipe["live_ingest"] is True
    assert recipe["qdrant"]["collection"] == "scribe-test-project"

    sources = recipe["sources"]
    assert len(sources) == 4

    kinds = sorted(s["metadata"]["kind"] for s in sources)
    assert kinds == ["chapters", "character-profiles", "planning", "references"]

    paths = sorted(s["path"] for s in sources)
    assert paths == [
        "/data/writing/test-project/chapters",
        "/data/writing/test-project/character-profiles",
        "/data/writing/test-project/planning",
        "/data/writing/test-project/references",
    ]


def test_build_recipe_is_deterministic(tmp_path: Path) -> None:
    project_dir = tmp_path / "foo"
    project_dir.mkdir()
    (project_dir / "chapters").mkdir()
    (project_dir / "references").mkdir()
    a = build_recipe("foo", "Foo", project_path=project_dir, host_writing_root=str(tmp_path), qdrant_url="http://y")
    b = build_recipe("foo", "Foo", project_path=project_dir, host_writing_root=str(tmp_path), qdrant_url="http://y")
    assert a == b


# ---------------- httpx fakes for qdrant + embed ----------------


class _FakeResp:
    def __init__(self, status: int, payload: Any) -> None:
        self.status_code = status
        self._payload = payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)  # type: ignore[arg-type]

    def json(self) -> Any:
        return self._payload


class _FakeAsyncClient:
    """Configurable per-(method, url-suffix) fake."""

    def __init__(self, responses: dict[tuple[str, str], _FakeResp]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def _match(self, method: str, url: str) -> _FakeResp:
        for (m, suffix), resp in self._responses.items():
            if m == method and url.endswith(suffix):
                return resp
        raise AssertionError(f"unmocked {method} {url}")

    async def get(self, url: str, **kwargs: Any) -> _FakeResp:
        self.calls.append(("GET", url, None))
        return self._match("GET", url)

    async def post(self, url: str, json: Any = None, **kwargs: Any) -> _FakeResp:
        self.calls.append(("POST", url, json))
        return self._match("POST", url)

    async def delete(self, url: str, **kwargs: Any) -> _FakeResp:
        self.calls.append(("DELETE", url, None))
        return self._match("DELETE", url)


def _patch_httpx(monkeypatch: pytest.MonkeyPatch, responses: dict[tuple[str, str], _FakeResp]) -> _FakeAsyncClient:
    fake = _FakeAsyncClient(responses)

    def factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
        return fake

    monkeypatch.setattr("scribe.routes.rag.httpx.AsyncClient", factory)
    return fake


# ---------------- /rag (state) ----------------


def test_rag_state_when_no_recipe_and_no_collection(
    sample_project: Path, monkeypatch, tmp_path: Path, client: TestClient
) -> None:
    monkeypatch.setattr(config, "RAG_RECIPES_DIR", tmp_path / "recipes")
    _patch_httpx(
        monkeypatch,
        {
            ("GET", "/collections/scribe-example-novel"): _FakeResp(404, {}),
        },
    )
    r = client.get("/api/projects/example-novel/rag")
    assert r.status_code == 200
    data = r.json()
    assert data["collection"] == "scribe-example-novel"
    assert data["recipe_exists"] is False
    assert data["qdrant"]["exists"] is False
    assert data["recipe_path"].endswith("/scribe/example-novel.yml")
    assert "llm-rag ingest scribe/example-novel" in data["ingest_command"]


def test_rag_state_when_collection_exists(
    sample_project: Path, monkeypatch, tmp_path: Path, client: TestClient
) -> None:
    monkeypatch.setattr(config, "RAG_RECIPES_DIR", tmp_path / "recipes")
    _patch_httpx(
        monkeypatch,
        {
            ("GET", "/collections/scribe-example-novel"): _FakeResp(
                200,
                {
                    "result": {
                        "points_count": 132,
                        "vectors_count": 132,
                        "indexed_vectors_count": 132,
                        "status": "green",
                    },
                    "status": "ok",
                },
            ),
        },
    )
    r = client.get("/api/projects/example-novel/rag")
    assert r.status_code == 200
    qd = r.json()["qdrant"]
    assert qd["exists"] is True
    assert qd["points_count"] == 132
    assert qd["status"] == "green"


# ---------------- /rag/recipe ----------------


def test_put_recipe_writes_yaml_to_recipes_dir(
    sample_project: Path, monkeypatch, tmp_path: Path, client: TestClient
) -> None:
    writing_root = str(sample_project.parent)
    recipes_dir = tmp_path / "recipes"
    monkeypatch.setattr(config, "RAG_RECIPES_DIR", recipes_dir)
    monkeypatch.setattr(config, "RAG_HOST_WRITING_ROOT", writing_root)
    r = client.put("/api/projects/example-novel/rag/recipe")
    assert r.status_code == 200
    data = r.json()
    assert data["written"] is True
    on_disk = Path(data["recipe_path"])
    assert on_disk.is_file()
    parsed = yaml.safe_load(on_disk.read_text(encoding="utf-8"))
    assert parsed["corpus"] == "scribe-example-novel"
    assert any(
        s["path"] == f"{writing_root}/example-novel/chapters" for s in parsed["sources"]
    )


# ---------------- /rag/collection (delete) ----------------


def test_delete_collection_proxies_to_qdrant(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    fake = _patch_httpx(
        monkeypatch,
        {
            ("DELETE", "/collections/scribe-example-novel"): _FakeResp(200, {"status": "ok"}),
        },
    )
    r = client.delete("/api/projects/example-novel/rag/collection")
    assert r.status_code == 204
    methods = [c[0] for c in fake.calls]
    assert "DELETE" in methods


def test_delete_collection_tolerates_404(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_httpx(
        monkeypatch,
        {
            ("DELETE", "/collections/scribe-example-novel"): _FakeResp(404, {}),
        },
    )
    r = client.delete("/api/projects/example-novel/rag/collection")
    assert r.status_code == 204


# ---------------- /rag/query ----------------


def test_query_returns_hits_from_qdrant_search(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_httpx(
        monkeypatch,
        {
            ("POST", "/embed"): _FakeResp(200, {"vectors": [[0.1] * 8]}),
            ("POST", "/collections/scribe-example-novel/points/search"): _FakeResp(
                200,
                {
                    "result": [
                        {
                            "score": 0.91,
                            "payload": {
                                "kind": "chapter",
                                "path": "chapters/01/01.md",
                                "text": "Tarn tested his axe balance.",
                            },
                        }
                    ],
                    "status": "ok",
                },
            ),
        },
    )
    r = client.post(
        "/api/projects/example-novel/rag/query",
        json={"text": "Who tested the axe?", "limit": 5},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["embed_dim"] == 8
    assert len(data["hits"]) == 1
    assert data["hits"][0]["payload"]["path"] == "chapters/01/01.md"


def test_query_404_when_collection_missing(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_httpx(
        monkeypatch,
        {
            ("POST", "/embed"): _FakeResp(200, {"vectors": [[0.0] * 8]}),
            ("POST", "/collections/scribe-example-novel/points/search"): _FakeResp(404, {}),
        },
    )
    r = client.post(
        "/api/projects/example-novel/rag/query", json={"text": "anything"}
    )
    assert r.status_code == 404


def test_query_rejects_empty_text(sample_project: Path, client: TestClient) -> None:
    r = client.post("/api/projects/example-novel/rag/query", json={"text": "  "})
    assert r.status_code == 400


def test_query_uses_embeddings_key_as_fallback(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_httpx(
        monkeypatch,
        {
            ("POST", "/embed"): _FakeResp(200, {"embeddings": [[0.2] * 8]}),
            ("POST", "/collections/scribe-example-novel/points/search"): _FakeResp(
                200,
                {
                    "result": [
                        {
                            "score": 0.85,
                            "payload": {
                                "kind": "scene",
                                "path": "chapters/01/02.md",
                                "text": "A scene text.",
                            },
                        }
                    ],
                    "status": "ok",
                },
            ),
        },
    )
    r = client.post(
        "/api/projects/example-novel/rag/query",
        json={"text": "Search query", "limit": 5},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["embed_dim"] == 8
    assert len(data["hits"]) == 1

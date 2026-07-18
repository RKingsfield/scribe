from pathlib import Path

from fastapi.testclient import TestClient

from scribe.main import app


def client() -> TestClient:
    return TestClient(app)


def test_list_projects(sample_project: Path) -> None:
    r = client().get("/api/projects")
    assert r.status_code == 200
    items = r.json()
    assert any(i["slug"] == "example-novel" and i["title"] == "The Example Novel" for i in items)


def test_get_project_tree_nested(sample_project: Path) -> None:
    r = client().get("/api/projects/example-novel")
    assert r.status_code == 200
    tree = r.json()
    assert tree["title"] == "The Example Novel"
    assert len(tree["acts"]) == 1

    # Two chapters
    assert len(tree["chapters"]) == 2
    ch1 = tree["chapters"][0]
    assert ch1["slug"] == "01_Chapter_01"
    assert ch1["path"] == "chapters/01_Chapter_01"
    assert ch1["meta_path"] == "chapters/01_Chapter_01/chapter.md"
    assert ch1["title"] == "Chapter 1"
    assert ch1["pov"] == "Tarn"
    assert len(ch1["scenes"]) == 1
    assert ch1["word_count"] >= 4
    assert ch1["scenes"][0]["path"] == "chapters/01_Chapter_01/01.md"
    assert ch1["scenes"][0]["scene"] == 1

    ch11 = tree["chapters"][1]
    assert ch11["slug"] == "11_Chapter_11"
    assert len(ch11["scenes"]) == 2
    assert ch11["scenes"][0]["scene"] == 1
    assert ch11["scenes"][1]["scene"] == 2

    char_cat = next(c for c in tree["categories"] if c["folder"] == "character-profiles")
    assert char_cat["name"] == "Characters"
    assert char_cat["codex"] is True
    chars = char_cat["entries"][0]
    assert chars["title"] == "Tarn"
    assert "the Foxhead" in chars["aliases"]


def test_get_project_404(writing_root: Path) -> None:
    r = client().get("/api/projects/no-such-thing")
    assert r.status_code == 404


def test_file_get_put_etag_chapter_meta(sample_project: Path) -> None:
    c = client()
    r = c.get("/api/projects/example-novel/file", params={"path": "chapters/01_Chapter_01/chapter.md"})
    assert r.status_code == 200
    body = r.json()
    etag = body["etag"]
    assert body["frontmatter"]["title"] == "Chapter 1"

    new_meta = dict(body["frontmatter"])
    new_meta["summary"] = "Updated chapter summary."
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
        json={"body": body["body"], "frontmatter": new_meta},
        headers={"If-Match": etag},
    )
    assert r.status_code == 200
    assert r.json()["etag"] != etag


def test_file_get_scene(sample_project: Path) -> None:
    r = client().get("/api/projects/example-novel/file", params={"path": "chapters/01_Chapter_01/01.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["frontmatter"]["scene"] == 1
    assert "Tarn tested" in body["body"]


def test_file_path_escape_rejected(sample_project: Path) -> None:
    r = client().get("/api/projects/example-novel/file", params={"path": "../../etc/passwd"})
    assert r.status_code == 400


def test_file_create_scene(sample_project: Path) -> None:
    c = client()
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/02.md"},
        json={
            "body": "Continuation scene.\n",
            "frontmatter": {"scene": 2, "order": 2, "summary": "Aftermath."},
        },
    )
    assert r.status_code == 200
    r = c.get("/api/projects/example-novel")
    ch1 = r.json()["chapters"][0]
    assert len(ch1["scenes"]) == 2


def test_file_move_scene(sample_project: Path) -> None:
    c = client()
    r = c.post(
        "/api/projects/example-novel/file/move",
        json={"src": "chapters/11_Chapter_11/02.md", "dst": "chapters/11_Chapter_11/03.md"},
    )
    assert r.status_code == 200
    assert r.json()["path"] == "chapters/11_Chapter_11/03.md"


def test_sync_manifest(sample_project: Path) -> None:
    r = client().get("/api/projects/example-novel/sync")
    assert r.status_code == 200
    paths_seen = {e["path"] for e in r.json()["entries"]}
    assert "chapters/01_Chapter_01/chapter.md" in paths_seen
    assert "chapters/01_Chapter_01/01.md" in paths_seen
    assert "chapters/11_Chapter_11/02.md" in paths_seen
    assert "project.yml" in paths_seen


def test_init_project(writing_root: Path) -> None:
    c = client()
    r = c.post("/api/projects/test-novel/init", json={"title": "Test Novel", "author": "Me"})
    assert r.status_code == 201
    assert (writing_root / "test-novel" / "chapters").is_dir()
    r = c.post("/api/projects/test-novel/init", json={"title": "Dup"})
    assert r.status_code == 409


def test_update_project_acts(sample_project: Path) -> None:
    c = client()
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One", "chapters": [1, 16]},
        {"name": "Act Two", "chapters": [17, 32]},
    ]})
    assert r.status_code == 200
    r = c.get("/api/projects/example-novel")
    assert len(r.json()["acts"]) == 2


def test_put_etag_mismatch_412_default(sample_project: Path) -> None:
    c = client()
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
        json={"body": "loser body", "frontmatter": {}},
        headers={"If-Match": "stale-etag-1234"},
    )
    assert r.status_code == 412


def test_put_save_as_conflict(sample_project: Path) -> None:
    c = client()
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
        json={
            "body": "lost-edit body",
            "frontmatter": {"title": "Chapter 1", "summary": "Lost edit"},
        },
        headers={
            "If-Match": "stale-etag-1234",
            "X-On-Conflict": "save-as-conflict",
            "X-Device-Id": "browser-A",
        },
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["conflict"] is True
    cp = payload["conflict_path"]
    assert cp.startswith("chapters/01_Chapter_01/chapter.conflict.browser-A.")
    assert cp.endswith(".md")

    # canonical file untouched
    canonical = sample_project / "chapters" / "01_Chapter_01" / "chapter.md"
    assert "Lost edit" not in canonical.read_text(encoding="utf-8")

    # conflict file written with body
    conflict_abs = sample_project / cp
    assert conflict_abs.is_file()
    assert "lost-edit body" in conflict_abs.read_text(encoding="utf-8")


def test_list_and_discard_conflicts(sample_project: Path) -> None:
    c = client()
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
        json={"body": "x", "frontmatter": {}},
        headers={
            "If-Match": "stale-etag-1234",
            "X-On-Conflict": "save-as-conflict",
            "X-Device-Id": "phone1",
        },
    )
    assert r.status_code == 200
    cp = r.json()["conflict_path"]

    r = c.get("/api/projects/example-novel/conflicts")
    assert r.status_code == 200
    items = r.json()["conflicts"]
    assert any(it["path"] == cp for it in items)
    item = next(it for it in items if it["path"] == cp)
    assert item["canonical_path"] == "chapters/01_Chapter_01/chapter.md"
    assert item["device_id"] == "phone1"

    r = c.delete("/api/projects/example-novel/conflicts", params={"path": cp})
    assert r.status_code == 204
    r = c.get("/api/projects/example-novel/conflicts")
    assert all(it["path"] != cp for it in r.json()["conflicts"])


def test_conflicts_parses_disk_written_conflict(sample_project: Path) -> None:
    conflict_name = "01.conflict.abc123.20250101T000000Z.md"
    conflict_file = sample_project / "chapters" / "01_Chapter_01" / conflict_name
    conflict_body = "---\nscene: 1\n---\nConflict body.\n"
    conflict_file.write_text(conflict_body, encoding="utf-8")

    r = client().get("/api/projects/example-novel/conflicts")
    assert r.status_code == 200
    items = r.json()["conflicts"]
    match = [it for it in items if it["device_id"] == "abc123"]
    assert len(match) == 1
    entry = match[0]
    assert entry["path"] == f"chapters/01_Chapter_01/{conflict_name}"
    assert entry["canonical_path"] == "chapters/01_Chapter_01/01.md"
    assert entry["device_id"] == "abc123"
    assert entry["timestamp"] == "20250101T000000Z"
    assert entry["size"] == len(conflict_body.encode("utf-8"))


def test_discard_conflict_rejects_canonical(sample_project: Path) -> None:
    r = client().delete(
        "/api/projects/example-novel/conflicts",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
    )
    assert r.status_code == 400

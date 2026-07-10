"""Integration test: simulates the client's full flush sequence against the API."""

from pathlib import Path

from fastapi.testclient import TestClient

from scribe.main import app


def client() -> TestClient:
    return TestClient(app)


def test_full_flush_roundtrip(writing_root: Path) -> None:
    c = client()

    # 1. Create a project
    r = c.post("/api/projects/sync-test/init", json={"title": "Sync Test", "author": "Test"})
    assert r.status_code == 201

    # 2. Create a chapter
    r = c.post(
        "/api/projects/sync-test/chapter/new",
        json={"kind": "chapter", "title": "First Chapter"},
    )
    assert r.status_code == 200
    ch = r.json()
    chapter_slug = ch["slug"]
    scene_path = ch["first_scene_path"]
    assert chapter_slug
    assert scene_path

    # 3. Create a second scene
    r = c.post(
        f"/api/projects/sync-test/chapter/{chapter_slug}/scene/new",
        json={"title": "Second beat"},
    )
    assert r.status_code == 200
    scene2 = r.json()
    scene2_path = scene2["path"]

    # 4. Write content to the first scene (no etag required for new file)
    r = c.put(
        "/api/projects/sync-test/file",
        params={"path": scene_path},
        json={
            "body": "The door creaked open.\n",
            "frontmatter": {"scene": 1, "order": 1, "status": "draft"},
        },
    )
    assert r.status_code == 200
    etag1 = r.json()["etag"]
    assert etag1

    # 5. Verify the manifest reflects the file with the correct hash
    r = c.get("/api/projects/sync-test/sync")
    assert r.status_code == 200
    manifest = r.json()
    scene_entry = next(
        (e for e in manifest["entries"] if e["path"] == scene_path), None
    )
    assert scene_entry is not None
    assert scene_entry["sha256"]
    assert scene_entry["size"] > 0
    first_hash = scene_entry["sha256"]

    # 6. Update the file with the correct etag
    r = c.put(
        "/api/projects/sync-test/file",
        params={"path": scene_path},
        json={
            "body": "The door creaked open. A figure stepped through.\n",
            "frontmatter": {"scene": 1, "order": 1, "status": "draft"},
        },
        headers={"If-Match": etag1},
    )
    assert r.status_code == 200
    etag2 = r.json()["etag"]
    assert etag2 != etag1

    # 7. Verify the etag changed in the manifest
    r = c.get("/api/projects/sync-test/sync")
    assert r.status_code == 200
    manifest2 = r.json()
    scene_entry2 = next(
        (e for e in manifest2["entries"] if e["path"] == scene_path), None
    )
    assert scene_entry2 is not None
    assert scene_entry2["sha256"] != first_hash

    # 8. Attempt a write with a stale etag + save-as-conflict
    r = c.put(
        "/api/projects/sync-test/file",
        params={"path": scene_path},
        json={
            "body": "Conflicting edit from another device.\n",
            "frontmatter": {"scene": 1, "order": 1, "status": "draft"},
        },
        headers={
            "If-Match": etag1,  # stale
            "X-On-Conflict": "save-as-conflict",
            "X-Device-Id": "test-device",
        },
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["conflict"] is True
    conflict_path = payload["conflict_path"]
    assert "conflict" in conflict_path
    assert "test-device" in conflict_path
    # The returned etag is the server's current etag (canonical unchanged)
    assert payload["etag"] == etag2

    # 9. Verify GET /conflicts shows the conflict
    r = c.get("/api/projects/sync-test/conflicts")
    assert r.status_code == 200
    conflicts = r.json()["conflicts"]
    match = [c for c in conflicts if c["path"] == conflict_path]
    assert len(match) == 1
    assert match[0]["canonical_path"] == scene_path
    assert match[0]["device_id"] == "test-device"


def test_etag_mismatch_without_conflict_header_returns_412(writing_root: Path) -> None:
    c = client()

    c.post("/api/projects/etag-test/init", json={"title": "ETag Test"})
    r = c.post(
        "/api/projects/etag-test/chapter/new",
        json={"kind": "chapter"},
    )
    scene_path = r.json()["first_scene_path"]

    # Write initial content
    r = c.put(
        "/api/projects/etag-test/file",
        params={"path": scene_path},
        json={"body": "initial", "frontmatter": {}},
    )
    assert r.status_code == 200

    # Attempt update with stale etag, no X-On-Conflict header → 412
    r = c.put(
        "/api/projects/etag-test/file",
        params={"path": scene_path},
        json={"body": "stale update", "frontmatter": {}},
        headers={"If-Match": "bogus-etag"},
    )
    assert r.status_code == 412


def test_manifest_includes_all_structural_files(writing_root: Path) -> None:
    c = client()

    c.post("/api/projects/manifest-test/init", json={"title": "Manifest Test"})
    c.post(
        "/api/projects/manifest-test/chapter/new",
        json={"kind": "chapter", "title": "Ch 1"},
    )
    c.post(
        "/api/projects/manifest-test/chapter/new",
        json={"kind": "interlude", "title": "Interlude 1"},
    )

    r = c.get("/api/projects/manifest-test/sync")
    assert r.status_code == 200
    paths = {e["path"] for e in r.json()["entries"]}

    assert "project.yml" in paths
    # Both chapter dirs should have chapter.md and 01.md
    chapter_metas = [p for p in paths if p.endswith("chapter.md")]
    scene_files = [p for p in paths if p.endswith("01.md")]
    assert len(chapter_metas) == 2
    assert len(scene_files) == 2

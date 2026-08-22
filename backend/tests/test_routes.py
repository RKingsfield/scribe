from pathlib import Path

from fastapi.testclient import TestClient

from scribe.storage import frontmatter as fm


def test_list_projects(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects")
    assert r.status_code == 200
    items = r.json()
    assert any(i["slug"] == "example-novel" and i["title"] == "The Example Novel" for i in items)


def test_get_project_tree_nested(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel")
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
    assert "pov" not in ch1
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


def test_get_project_tree_excludes_conflict_files(sample_project: Path, client: TestClient) -> None:
    conflict = sample_project / "chapters" / "01_Chapter_01" / "01.conflict.dev.20260101T000000Z.md"
    conflict.write_text(
        "---\nscene: 1\norder: 1\n---\nConflicting body.\n", encoding="utf-8"
    )
    r = client.get("/api/projects/example-novel")
    assert r.status_code == 200
    ch1 = r.json()["chapters"][0]
    assert len(ch1["scenes"]) == 1
    assert ch1["scenes"][0]["path"] == "chapters/01_Chapter_01/01.md"


def test_get_project_tree_survives_malformed_scene_frontmatter(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    scene.write_text("---\ntitle: [unclosed\n---\nBody text here.\n", encoding="utf-8")
    r = client.get("/api/projects/example-novel")
    assert r.status_code == 200
    ch1 = r.json()["chapters"][0]
    assert len(ch1["scenes"]) == 1
    scene_entry = ch1["scenes"][0]
    assert scene_entry["path"] == "chapters/01_Chapter_01/01.md"
    assert scene_entry["title"] is None
    assert scene_entry["word_count"] > 0


def test_get_project_404(writing_root: Path, client: TestClient) -> None:
    r = client.get("/api/projects/no-such-thing")
    assert r.status_code == 404


def test_list_projects_skips_malformed_project_yml(writing_root: Path, client: TestClient) -> None:
    broken = writing_root / "broken"
    broken.mkdir()
    (broken / "project.yml").write_text("title: [unclosed\nslug: broken\n", encoding="utf-8")
    r = client.get("/api/projects")
    assert r.status_code == 200
    assert any(i["slug"] == "broken" and i["title"] == "broken" for i in r.json())


def test_file_get_put_etag_chapter_meta(sample_project: Path, client: TestClient) -> None:
    c = client
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


def test_file_get_put_etag_crlf_body(sample_project: Path, client: TestClient) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    scene.write_bytes(b"---\r\nscene: 1\r\norder: 1\r\n---\r\nCRLF body line.\r\n")

    c = client
    r = c.get("/api/projects/example-novel/file", params={"path": "chapters/01_Chapter_01/01.md"})
    assert r.status_code == 200
    body = r.json()
    etag = body["etag"]

    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/01.md"},
        json={"body": body["body"], "frontmatter": body["frontmatter"]},
        headers={"If-Match": etag},
    )
    assert r.status_code == 200
    assert r.json()["conflict"] is False


def test_file_get_malformed_frontmatter_returns_raw_and_round_trips(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    original = "---\ntitle: [unclosed\n---\nBody text here.\n"
    scene.write_text(original, encoding="utf-8")

    r = client.get("/api/projects/example-novel/file", params={"path": "chapters/01_Chapter_01/01.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["frontmatter"] == {}
    assert body["body"] == original

    r = client.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/01.md"},
        json={"body": body["body"], "frontmatter": body["frontmatter"]},
        headers={"If-Match": body["etag"]},
    )
    assert r.status_code == 200
    assert scene.read_text(encoding="utf-8") == original


def test_file_get_scene(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/file", params={"path": "chapters/01_Chapter_01/01.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["frontmatter"]["scene"] == 1
    assert "Tarn tested" in body["body"]


def test_file_path_escape_rejected(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/file", params={"path": "../../etc/passwd"})
    assert r.status_code == 400


def test_file_null_byte_path_rejected(sample_project: Path, client: TestClient) -> None:
    r = client.get(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/01.md\x00.txt"},
    )
    assert r.status_code == 400


def test_file_absolute_path_rejected(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/file", params={"path": "/etc/passwd"})
    assert r.status_code == 400


def test_file_dot_git_get_and_put_rejected(sample_project: Path, client: TestClient) -> None:
    c = client
    r = c.get("/api/projects/example-novel/file", params={"path": ".git/config"})
    assert r.status_code == 400
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": ".git/config"},
        json={"body": "[core]\n", "frontmatter": {}},
    )
    assert r.status_code == 400
    assert not (sample_project / ".git").exists()


def test_file_create_scene(sample_project: Path, client: TestClient) -> None:
    c = client
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


def test_sync_manifest(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/sync")
    assert r.status_code == 200
    paths_seen = {e["path"] for e in r.json()["entries"]}
    assert "chapters/01_Chapter_01/chapter.md" in paths_seen
    assert "chapters/01_Chapter_01/01.md" in paths_seen
    assert "chapters/11_Chapter_11/02.md" in paths_seen
    assert "project.yml" in paths_seen


def test_init_project(writing_root: Path, client: TestClient) -> None:
    c = client
    r = c.post("/api/projects/test-novel/init", json={"title": "Test Novel", "author": "Me"})
    assert r.status_code == 201
    assert (writing_root / "test-novel" / "chapters").is_dir()
    r = c.post("/api/projects/test-novel/init", json={"title": "Dup"})
    assert r.status_code == 409


def test_init_project_honours_categories(writing_root: Path, client: TestClient) -> None:
    r = client.post("/api/projects/test-novel/init", json={
        "title": "Test Novel",
        "categories": [
            {"name": "Locations", "folder": "locations", "codex": True},
            {"name": "Notes", "folder": "notes", "codex": False},
        ],
    })
    assert r.status_code == 201
    assert (writing_root / "test-novel" / "locations").is_dir()
    assert (writing_root / "test-novel" / "notes").is_dir()
    tree = client.get("/api/projects/test-novel").json()
    assert [c["folder"] for c in tree["categories"]] == ["locations", "notes"]


def test_init_project_rejects_invalid_slugs(writing_root: Path, client: TestClient) -> None:
    c = client
    invalid_slugs = ["_test", "-test", "9$special"]
    for slug in invalid_slugs:
        r = c.post(f"/api/projects/{slug}/init", json={"title": "Test"})
        assert r.status_code == 400, f"Slug {slug!r} should be rejected but got {r.status_code}"


def test_update_project_acts(sample_project: Path, client: TestClient) -> None:
    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One", "chapters": [1, 16]},
        {"name": "Act Two", "chapters": [17, 32]},
    ]})
    assert r.status_code == 200
    r = c.get("/api/projects/example-novel")
    assert len(r.json()["acts"]) == 2


def _set_chapter_act(sample_project: Path, chapter_dir: str, act: str) -> None:
    meta_path = sample_project / "chapters" / chapter_dir / "chapter.md"
    meta, body = fm.parse(meta_path.read_text(encoding="utf-8"))
    meta["act"] = act
    meta_path.write_text(fm.serialize(meta, body), encoding="utf-8")


def _chapter_act(sample_project: Path, chapter_dir: str, client: TestClient) -> str | None:
    r = client.get(
        "/api/projects/example-novel/file",
        params={"path": f"chapters/{chapter_dir}/chapter.md"},
    )
    assert r.status_code == 200
    return r.json()["frontmatter"].get("act")


def test_update_project_acts_same_length_rename(sample_project: Path, client: TestClient) -> None:
    _set_chapter_act(sample_project, "01_Chapter_01", "Act One")
    _set_chapter_act(sample_project, "11_Chapter_11", "Act Two")
    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act Two"},
    ]})
    assert r.status_code == 200

    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act II"},
    ]})
    assert r.status_code == 200
    assert _chapter_act(sample_project, "01_Chapter_01", client) == "Act One"
    assert _chapter_act(sample_project, "11_Chapter_11", client) == "Act II"


def test_update_project_acts_rename_skips_malformed_chapter(
    sample_project: Path, client: TestClient
) -> None:
    _set_chapter_act(sample_project, "01_Chapter_01", "Act One")
    malformed = sample_project / "chapters" / "11_Chapter_11" / "chapter.md"
    original = "---\ntitle: [unclosed\n---\nBody text here.\n"
    malformed.write_text(original, encoding="utf-8")

    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [{"name": "Act One Renamed"}]})
    assert r.status_code == 200
    assert _chapter_act(sample_project, "01_Chapter_01", client) == "Act One Renamed"
    assert malformed.read_text(encoding="utf-8") == original


def test_update_project_acts_mid_list_delete_no_rename(sample_project: Path, client: TestClient) -> None:
    _set_chapter_act(sample_project, "01_Chapter_01", "Act Two")
    _set_chapter_act(sample_project, "11_Chapter_11", "Act Three")
    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act Two"},
        {"name": "Act Three"},
    ]})
    assert r.status_code == 200

    # Delete "Act One" -> positional zip would wrongly compute {Act Two->Act One, Act Three->Act Two}.
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act Two"},
        {"name": "Act Three"},
    ]})
    assert r.status_code == 200
    assert _chapter_act(sample_project, "01_Chapter_01", client) == "Act Two"
    assert _chapter_act(sample_project, "11_Chapter_11", client) == "Act Three"


def test_update_project_acts_mid_list_insert_no_rename(sample_project: Path, client: TestClient) -> None:
    _set_chapter_act(sample_project, "01_Chapter_01", "Act One")
    _set_chapter_act(sample_project, "11_Chapter_11", "Act Three")
    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act Three"},
    ]})
    assert r.status_code == 200

    # Insert "Act Two" in the middle -> positional zip would wrongly rename Act Three -> Act Two.
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act Two"},
        {"name": "Act Three"},
    ]})
    assert r.status_code == 200
    assert _chapter_act(sample_project, "01_Chapter_01", client) == "Act One"
    assert _chapter_act(sample_project, "11_Chapter_11", client) == "Act Three"


def test_update_project_acts_append_no_rename(sample_project: Path, client: TestClient) -> None:
    _set_chapter_act(sample_project, "01_Chapter_01", "Act One")
    c = client
    r = c.put("/api/projects/example-novel", json={"acts": [
        {"name": "Act One"},
        {"name": "Act Two"},
    ]})
    assert r.status_code == 200
    r = c.get("/api/projects/example-novel")
    assert [a["name"] for a in r.json()["acts"]] == ["Act One", "Act Two"]
    assert _chapter_act(sample_project, "01_Chapter_01", client) == "Act One"


def test_put_etag_mismatch_412_default(sample_project: Path, client: TestClient) -> None:
    c = client
    r = c.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
        json={"body": "loser body", "frontmatter": {}},
        headers={"If-Match": "stale-etag-1234"},
    )
    assert r.status_code == 412


def test_put_if_match_missing_file_412(sample_project: Path, client: TestClient) -> None:
    r = client.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/99.md"},
        json={"body": "ghost body", "frontmatter": {}},
        headers={"If-Match": "some-etag"},
    )
    assert r.status_code == 412
    assert not (sample_project / "chapters" / "01_Chapter_01" / "99.md").exists()


def test_put_if_match_missing_file_save_as_conflict_recreates(
    sample_project: Path, client: TestClient
) -> None:
    # A deleted scene with queued edits resurrects loss-free on flush.
    r = client.put(
        "/api/projects/example-novel/file",
        params={"path": "chapters/01_Chapter_01/99.md"},
        json={"body": "queued edit body", "frontmatter": {}},
        headers={"If-Match": "offline", "X-On-Conflict": "save-as-conflict"},
    )
    assert r.status_code == 200
    assert r.json()["conflict"] is False
    assert (sample_project / "chapters" / "01_Chapter_01" / "99.md").exists()


def test_delete_file_if_match_current_etag_deletes(
    sample_project: Path, client: TestClient
) -> None:
    path = "chapters/11_Chapter_11/02.md"
    etag = client.get("/api/projects/example-novel/file", params={"path": path}).json()["etag"]
    r = client.delete(
        "/api/projects/example-novel/file", params={"path": path}, headers={"If-Match": etag}
    )
    assert r.status_code == 204
    assert not (sample_project / path).exists()


def test_delete_file_if_match_stale_412_leaves_file(
    sample_project: Path, client: TestClient
) -> None:
    path = "chapters/11_Chapter_11/02.md"
    before = (sample_project / path).read_text(encoding="utf-8")
    r = client.delete(
        "/api/projects/example-novel/file",
        params={"path": path},
        headers={"If-Match": "stale-etag-1234"},
    )
    assert r.status_code == 412
    assert (sample_project / path).read_text(encoding="utf-8") == before


def test_delete_file_without_if_match_deletes(
    sample_project: Path, client: TestClient
) -> None:
    path = "chapters/11_Chapter_11/02.md"
    r = client.delete("/api/projects/example-novel/file", params={"path": path})
    assert r.status_code == 204
    assert not (sample_project / path).exists()
    # A missing file is still 404, conditional or not.
    r = client.delete(
        "/api/projects/example-novel/file", params={"path": path}, headers={"If-Match": "any"}
    )
    assert r.status_code == 404


def test_put_save_as_conflict(sample_project: Path, client: TestClient) -> None:
    c = client
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


def test_list_and_discard_conflicts(sample_project: Path, client: TestClient) -> None:
    c = client
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

    # conflict filename (<stem>.conflict.<device>.<ts>.md) is not dot-prefixed, still readable
    r = c.get("/api/projects/example-novel/file", params={"path": cp})
    assert r.status_code == 200

    r = c.delete("/api/projects/example-novel/conflicts", params={"path": cp})
    assert r.status_code == 204
    r = c.get("/api/projects/example-novel/conflicts")
    assert all(it["path"] != cp for it in r.json()["conflicts"])


def test_conflicts_parses_disk_written_conflict(sample_project: Path, client: TestClient) -> None:
    conflict_name = "01.conflict.abc123.20250101T000000Z.md"
    conflict_file = sample_project / "chapters" / "01_Chapter_01" / conflict_name
    conflict_body = "---\nscene: 1\n---\nConflict body.\n"
    conflict_file.write_text(conflict_body, encoding="utf-8")

    r = client.get("/api/projects/example-novel/conflicts")
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


def test_discard_conflict_rejects_canonical(sample_project: Path, client: TestClient) -> None:
    r = client.delete(
        "/api/projects/example-novel/conflicts",
        params={"path": "chapters/01_Chapter_01/chapter.md"},
    )
    assert r.status_code == 400

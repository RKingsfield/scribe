from pathlib import Path

from fastapi.testclient import TestClient


def test_new_chapter_creates_dir_with_two_counter_slug(
    sample_project: Path,
    client: TestClient,
) -> None:
    # Fixture has chapters/01 + chapters/11. Max position = 11, max
    # chapter ordinal = 11. New chapter should land at position 12,
    # ordinal 12.
    r = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"title": "Aftermath"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "12_Chapter_12"
    assert body["kind"] == "chapter"
    assert body["chapter"] == 12
    assert body["position"] == 12
    assert (sample_project / "chapters" / "12_Chapter_12" / "chapter.md").is_file()
    assert (sample_project / "chapters" / "12_Chapter_12" / "01.md").is_file()


def test_new_interlude_creates_dir(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"kind": "interlude"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "12_Interlude_01"
    assert body["kind"] == "interlude"
    assert body["interlude"] == 1
    text = (
        sample_project / "chapters" / "12_Interlude_01" / "chapter.md"
    ).read_text()
    assert "kind: interlude" in text
    assert "interlude: 1" in text


def test_new_chapter_after_interlude_keeps_chapter_ordinal(
    sample_project: Path,
    client: TestClient,
) -> None:
    # An interlude bumps position but not chapter ordinal.
    r1 = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"kind": "interlude"},
    )
    assert r1.json()["slug"] == "12_Interlude_01"
    r2 = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"kind": "chapter"},
    )
    body = r2.json()
    assert body["position"] == 13
    assert body["chapter"] == 12  # next chapter ordinal, not 13
    assert body["slug"] == "13_Chapter_12"


def test_new_chapter_explicit_slug_still_409s(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"slug": "01_Chapter_01"},
    )
    assert r.status_code == 409


def test_new_chapter_takes_over_empty_orphan_dir(sample_project: Path, client: TestClient) -> None:
    # Empty orphan at the candidate slug (position 12, ordinal 12) — re-use it.
    orphan = sample_project / "chapters" / "12_Chapter_12"
    orphan.mkdir(parents=True, exist_ok=True)
    r = client.post("/api/projects/example-novel/chapter/new", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "12_Chapter_12"
    assert (orphan / "chapter.md").is_file()
    assert (orphan / "01.md").is_file()


def test_new_chapter_skips_orphan_with_content(sample_project: Path, client: TestClient) -> None:
    # Orphan at the candidate slug has stray content — must not clobber.
    orphan = sample_project / "chapters" / "12_Chapter_12"
    orphan.mkdir(parents=True, exist_ok=True)
    (orphan / "stray.md").write_text("important notes\n")
    r = client.post("/api/projects/example-novel/chapter/new", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] != "12_Chapter_12"
    assert (orphan / "stray.md").read_text() == "important notes\n"


def test_new_chapter_with_act_writes_frontmatter(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"act": "Act 2"},
    )
    assert r.status_code == 200
    slug = r.json()["slug"]
    text = (sample_project / "chapters" / slug / "chapter.md").read_text()
    assert "act: Act 2" in text


def test_new_chapter_skips_dir_with_malformed_chapter_md(
    sample_project: Path, client: TestClient
) -> None:
    broken = sample_project / "chapters" / "05_Chapter_05"
    broken.mkdir(parents=True)
    (broken / "chapter.md").write_text("---\ntitle: [unclosed\nchapter: 5\n---\n", encoding="utf-8")
    r = client.post("/api/projects/example-novel/chapter/new", json={"title": "Aftermath"})
    assert r.status_code == 200


def test_new_scene_auto_numbers(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/01_Chapter_01/scene/new", json={"title": "Aftermath"}
    )
    assert r.status_code == 200
    assert r.json()["path"] == "chapters/01_Chapter_01/02.md"
    r = client.post("/api/projects/example-novel/chapter/11_Chapter_11/scene/new", json={})
    assert r.json()["path"] == "chapters/11_Chapter_11/03.md"


def test_new_scene_uses_provided_order(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/01_Chapter_01/scene/new",
        json={"order": 5.0},
    )
    assert r.status_code == 200
    import frontmatter

    p = sample_project / r.json()["path"]
    meta = frontmatter.load(str(p)).metadata
    assert meta["order"] == 5.0
    # Scene number still auto-computed, independent of the dragged order.
    assert meta["scene"] == r.json()["scene"]


def test_new_scene_defaults_order_to_scene_number(
    sample_project: Path, client: TestClient
) -> None:
    r = client.post("/api/projects/example-novel/chapter/01_Chapter_01/scene/new", json={})
    assert r.status_code == 200
    import frontmatter

    p = sample_project / r.json()["path"]
    meta = frontmatter.load(str(p)).metadata
    assert meta["order"] == float(meta["scene"])


def test_delete_chapter(sample_project: Path, client: TestClient) -> None:
    r = client.delete("/api/projects/example-novel/chapter/01_Chapter_01")
    assert r.status_code == 204
    assert not (sample_project / "chapters" / "01_Chapter_01").exists()


def test_delete_chapter_idempotent_on_repeat(sample_project: Path, client: TestClient) -> None:
    cli = client
    r1 = cli.delete("/api/projects/example-novel/chapter/01_Chapter_01")
    assert r1.status_code == 204
    r2 = cli.delete("/api/projects/example-novel/chapter/01_Chapter_01")
    assert r2.status_code == 204


def test_delete_chapter_missing_returns_204(sample_project: Path, client: TestClient) -> None:
    r = client.delete("/api/projects/example-novel/chapter/99_Chapter_99")
    assert r.status_code == 204


def test_new_character(sample_project: Path, client: TestClient) -> None:
    r = client.post("/api/projects/example-novel/character/new", json={"title": "Asha"})
    assert r.status_code == 200
    assert r.json()["path"] == "character-profiles/asha.md"
    assert (sample_project / "character-profiles" / "asha.md").is_file()


def test_new_reference_with_slug(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/reference/new",
        json={"title": "Geography of Ynniscarr", "slug": "ynn-geo"},
    )
    assert r.status_code == 200
    assert r.json()["path"] == "references/ynn-geo.md"


def test_invalid_slug_rejected(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chapter/new",
        json={"chapter": 99, "slug": "../escape"},
    )
    assert r.status_code == 400


def test_new_character_seeds_order(sample_project: Path, client: TestClient) -> None:
    slug = "example-novel"
    r1 = client.post(f"/api/projects/{slug}/character/new", json={"title": "Asha"})
    assert r1.status_code == 200
    p1 = sample_project / r1.json()["path"]
    import frontmatter
    fm1 = frontmatter.load(str(p1))
    assert "order" in fm1.metadata
    order1 = fm1.metadata["order"]
    r2 = client.post(f"/api/projects/{slug}/character/new", json={"title": "Tarn Two"})
    assert r2.status_code == 200
    p2 = sample_project / r2.json()["path"]
    fm2 = frontmatter.load(str(p2))
    assert fm2.metadata["order"] > order1


def test_new_reference_seeds_order(sample_project: Path, client: TestClient) -> None:
    slug = "example-novel"
    r1 = client.post(f"/api/projects/{slug}/reference/new", json={"title": "Map"})
    assert r1.status_code == 200
    p1 = sample_project / r1.json()["path"]
    import frontmatter
    fm1 = frontmatter.load(str(p1))
    assert "order" in fm1.metadata


def test_new_reference_skips_non_scalar_order(sample_project: Path, client: TestClient) -> None:
    (sample_project / "references" / "bad.md").write_text(
        "---\ntitle: Bad\norder: [1, 2]\n---\n", encoding="utf-8"
    )
    r = client.post("/api/projects/example-novel/reference/new", json={"title": "New Ref"})
    assert r.status_code == 200


def test_reorder_updates_order_field(sample_project: Path, client: TestClient) -> None:
    cli = client
    r = cli.post(
        "/api/projects/example-novel/reorder",
        json={"items": [
            {"path": "chapters/01_Chapter_01/chapter.md", "order": 5.0},
            {"path": "chapters/11_Chapter_11/chapter.md", "order": 3.0},
        ]},
    )
    assert r.status_code == 200
    assert r.json()["count"] == 2
    r = cli.get("/api/projects/example-novel")
    chapters = r.json()["chapters"]
    # After reorder, chapter 11 (order=3) comes before chapter 01 (order=5)
    assert chapters[0]["slug"] == "11_Chapter_11"
    assert chapters[1]["slug"] == "01_Chapter_01"
    # Ordinals renumber to match new order
    assert chapters[0]["chapter"] == 1
    assert chapters[1]["chapter"] == 2


def test_reorder_renumbers_interludes_independently(
    sample_project: Path, client: TestClient
) -> None:
    cli = client
    r = cli.post("/api/projects/example-novel/chapter/new", json={"kind": "interlude"})
    assert r.status_code == 200
    int_slug = r.json()["slug"]
    # Swap interlude to position 1, chapters after
    r = cli.post(
        "/api/projects/example-novel/reorder",
        json={"items": [
            {"path": f"chapters/{int_slug}/chapter.md", "order": 1.0},
            {"path": "chapters/01_Chapter_01/chapter.md", "order": 2.0},
            {"path": "chapters/11_Chapter_11/chapter.md", "order": 3.0},
        ]},
    )
    assert r.status_code == 200
    r = cli.get("/api/projects/example-novel")
    chapters = r.json()["chapters"]
    assert chapters[0]["slug"] == int_slug
    assert chapters[0]["interlude"] == 1
    assert chapters[1]["chapter"] == 1
    assert chapters[2]["chapter"] == 2


def test_reorder_writes_act_field(sample_project: Path, client: TestClient) -> None:
    cli = client
    r = cli.post(
        "/api/projects/example-novel/reorder",
        json={"items": [
            {"path": "chapters/01_Chapter_01/chapter.md", "order": 1.0, "act": "Act Two"},
        ]},
    )
    assert r.status_code == 200
    r = cli.get("/api/projects/example-novel")
    ch1 = next(c for c in r.json()["chapters"] if c["slug"] == "01_Chapter_01")
    assert ch1["act"] == "Act Two"
    # Clearing with empty string
    r = cli.post(
        "/api/projects/example-novel/reorder",
        json={"items": [{"path": "chapters/01_Chapter_01/chapter.md", "order": 1.0, "act": ""}]},
    )
    assert r.status_code == 200
    r = cli.get("/api/projects/example-novel")
    ch1 = next(c for c in r.json()["chapters"] if c["slug"] == "01_Chapter_01")
    assert ch1["act"] is None


def test_reorder_skips_malformed_frontmatter_file(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    original = "---\ntitle: [unclosed\n---\nBody text here.\n"
    scene.write_text(original, encoding="utf-8")
    r = client.post(
        "/api/projects/example-novel/reorder",
        json={"items": [
            {"path": "chapters/01_Chapter_01/01.md", "order": 2.0},
            {"path": "chapters/11_Chapter_11/chapter.md", "order": 3.0},
        ]},
    )
    assert r.status_code == 200
    assert scene.read_text(encoding="utf-8") == original
    assert "chapters/01_Chapter_01/01.md" not in r.json()["updated"]
    assert "chapters/11_Chapter_11/chapter.md" in r.json()["updated"]


# ── scene/move ──────────────────────────────────────────────────────


def _move(cli, **overrides):
    payload = {
        "src_path": "chapters/01_Chapter_01/01.md",
        "dst_chapter_slug": "11_Chapter_11",
        "src_order": [],
        "dst_order": [],
    }
    payload.update(overrides)
    return cli.post("/api/projects/example-novel/scene/move", json=payload)


def test_move_scene_happy_path(sample_project: Path, client: TestClient) -> None:
    cli = client
    r = _move(
        cli,
        dst_order=[
            {"path": "chapters/11_Chapter_11/01.md", "order": 1.0},
            {"path": "chapters/11_Chapter_11/02.md", "order": 2.0},
            {"path": "chapters/01_Chapter_01/01.md", "order": 3.0},
        ],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["new_path"] == "chapters/11_Chapter_11/03.md"
    assert body["scene"] == 3
    assert (sample_project / "chapters" / "11_Chapter_11" / "03.md").is_file()
    assert not (sample_project / "chapters" / "01_Chapter_01" / "01.md").exists()
    import frontmatter
    moved = frontmatter.load(str(sample_project / "chapters" / "11_Chapter_11" / "03.md"))
    assert moved.metadata["scene"] == 3
    assert moved.metadata["order"] == 3.0


def test_move_scene_same_chapter_rejected(sample_project: Path, client: TestClient) -> None:
    r = _move(client, src_path="chapters/11_Chapter_11/01.md", dst_chapter_slug="11_Chapter_11")
    assert r.status_code == 400


def test_move_scene_missing_dst_chapter(sample_project: Path, client: TestClient) -> None:
    r = _move(client, dst_chapter_slug="99_Chapter_99")
    assert r.status_code == 404


def test_move_scene_missing_source(sample_project: Path, client: TestClient) -> None:
    r = _move(client, src_path="chapters/01_Chapter_01/99.md")
    assert r.status_code == 404


def test_move_scene_chapter_md_rejected(sample_project: Path, client: TestClient) -> None:
    r = _move(client, src_path="chapters/01_Chapter_01/chapter.md")
    assert r.status_code == 400


def test_move_scene_empty_source_chapter(sample_project: Path, client: TestClient) -> None:
    r = _move(client, dst_order=[{"path": "chapters/01_Chapter_01/01.md", "order": 3.0}])
    assert r.status_code == 200
    assert (sample_project / "chapters" / "01_Chapter_01" / "chapter.md").is_file()
    assert not list((sample_project / "chapters" / "01_Chapter_01").glob("[0-9]*.md"))


def test_move_scene_conflict_siblings(sample_project: Path, client: TestClient) -> None:
    conflict = (
        sample_project
        / "chapters"
        / "01_Chapter_01"
        / "01.conflict.dev1.20260101T000000Z.md"
    )
    conflict.write_text("conflict content\n")
    r = _move(client)
    assert r.status_code == 200
    body = r.json()
    assert body["scene"] == 3
    assert not conflict.exists()
    # Conflict file stem is renamed to the new scene number, not left stale;
    # the device/timestamp suffix is preserved untouched.
    assert not (sample_project / "chapters" / "11_Chapter_11" / "01.conflict.dev1.20260101T000000Z.md").exists()
    moved = sample_project / "chapters" / "11_Chapter_11" / "03.conflict.dev1.20260101T000000Z.md"
    assert moved.is_file()
    assert moved.read_text() == "conflict content\n"


def test_move_scene_malformed_frontmatter_rejected(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    original = "---\ntitle: [unclosed\n---\nBody text here.\n"
    scene.write_text(original, encoding="utf-8")
    r = _move(client)
    assert r.status_code == 422
    assert scene.read_text(encoding="utf-8") == original
    assert not (sample_project / "chapters" / "11_Chapter_11" / "03.md").exists()


def test_move_scene_order_updates(sample_project: Path, client: TestClient) -> None:
    cli = client
    r = _move(
        cli,
        src_path="chapters/11_Chapter_11/01.md",
        dst_chapter_slug="01_Chapter_01",
        src_order=[{"path": "chapters/11_Chapter_11/02.md", "order": 1.0}],
        dst_order=[
            {"path": "chapters/01_Chapter_01/01.md", "order": 2.0},
            {"path": "chapters/11_Chapter_11/01.md", "order": 1.0},
        ],
    )
    assert r.status_code == 200
    import frontmatter
    bystander_src = frontmatter.load(str(sample_project / "chapters" / "11_Chapter_11" / "02.md"))
    assert bystander_src.metadata["order"] == 1.0
    bystander_dst = frontmatter.load(str(sample_project / "chapters" / "01_Chapter_01" / "01.md"))
    assert bystander_dst.metadata["order"] == 2.0

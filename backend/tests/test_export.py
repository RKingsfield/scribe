"""Tests for M14 pandoc export."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from scribe.export.manuscript import ExportOptions, compose_manuscript

# ---------------- compose_manuscript ----------------


def test_compose_includes_title_page_and_chapter_headings(sample_project: Path) -> None:
    md = compose_manuscript("example-novel")
    assert "# The Example Novel" in md
    assert "_Author_" in md
    assert "\n# Chapter 1\n" in md
    assert "Tarn tested his axe balance." in md
    # chapter 11 has two scenes — expect a *** between them
    assert "***" in md


def test_compose_excludes_conflict_files(sample_project: Path) -> None:
    proj = sample_project
    conflict = proj / "chapters" / "01_Chapter_01" / "01.conflict.dev.20260101T000000Z.md"
    conflict.write_text(
        "---\nscene: 1\norder: 1\n---\nConflicting body text.\n", encoding="utf-8"
    )
    md = compose_manuscript("example-novel")
    assert "Conflicting body text" not in md


def test_compose_drops_frontmatter(sample_project: Path) -> None:
    md = compose_manuscript("example-novel")
    assert "---\n" not in md  # no leading frontmatter
    assert "scene: 1" not in md


def test_compose_strips_scene_beats_by_default(sample_project: Path) -> None:
    # add a scene beat to one scene
    proj = sample_project
    scene = proj / "chapters" / "11_Chapter_11" / "01.md"
    text = scene.read_text(encoding="utf-8")
    scene.write_text(text + "\n[[Tarn flinches at the sound]]\n", encoding="utf-8")
    md = compose_manuscript("example-novel")
    assert "Tarn flinches" not in md
    md2 = compose_manuscript("example-novel", ExportOptions(include_scene_beats=True))
    assert "Tarn flinches" in md2


def test_compose_includes_summaries_when_requested(sample_project: Path) -> None:
    md = compose_manuscript("example-novel", ExportOptions(include_summaries=True))
    assert "Opens on the killing ground" in md
    md2 = compose_manuscript("example-novel")
    assert "Opens on the killing ground" not in md2


# ---------------- /export ----------------


def test_export_md_passthrough(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/export", params={"format": "md"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert "example-novel.md" in r.headers["content-disposition"]
    assert "# The Example Novel" in r.text


def test_export_md_survives_malformed_scene_frontmatter(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    scene.write_text("---\ntitle: [unclosed\n---\nBody text here.\n", encoding="utf-8")
    r = client.get("/api/projects/example-novel/export", params={"format": "md"})
    assert r.status_code == 200
    assert "Body text here." in r.text


def test_export_unsupported_format_400(sample_project: Path, client: TestClient) -> None:
    r = client.get("/api/projects/example-novel/export", params={"format": "pdf"})
    assert r.status_code in (400, 422)


def test_export_pandoc_when_binary_missing_returns_503(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.export.pandoc.shutil.which", lambda _: None)
    r = client.get("/api/projects/example-novel/export", params={"format": "docx"})
    assert r.status_code == 503
    assert "pandoc" in r.json()["detail"].lower()


def test_export_pandoc_invokes_subprocess_with_format_flag(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    """When pandoc is present, the route should spawn it and stream stdout."""

    monkeypatch.setattr("scribe.export.pandoc.shutil.which", lambda _: "/usr/bin/pandoc")

    captured: dict[str, Any] = {}

    class _FakeProc:
        def __init__(self, stdout: bytes) -> None:
            self._stdout = stdout
            self.returncode = 0

        async def communicate(self, input: bytes) -> tuple[bytes, bytes]:
            captured["stdin_len"] = len(input)
            return self._stdout, b""

    async def fake_create(*args: Any, **kwargs: Any) -> _FakeProc:
        captured["args"] = list(args)
        return _FakeProc(b"FAKE_DOCX_BYTES")

    monkeypatch.setattr(
        "scribe.export.pandoc.asyncio.create_subprocess_exec", fake_create
    )

    r = client.get(
        "/api/projects/example-novel/export",
        params={"format": "epub"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/epub+zip")
    assert "example-novel.epub" in r.headers["content-disposition"]
    assert r.content == b"FAKE_DOCX_BYTES"
    # epub3 with toc and metadata title should be in the args
    args = captured["args"]
    assert "epub3" in args
    assert any(a.startswith("title=") for a in args)
    assert "--toc" in args
    assert captured["stdin_len"] > 0


def test_export_propagates_pandoc_error(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.export.pandoc.shutil.which", lambda _: "/usr/bin/pandoc")

    class _FakeProc:
        returncode = 7

        async def communicate(self, input: bytes) -> tuple[bytes, bytes]:
            return b"", b"pandoc: invalid input"

    async def fake_create(*args: Any, **kwargs: Any) -> _FakeProc:
        return _FakeProc()

    monkeypatch.setattr(
        "scribe.export.pandoc.asyncio.create_subprocess_exec", fake_create
    )

    r = client.get("/api/projects/example-novel/export", params={"format": "docx"})
    assert r.status_code == 500
    assert "pandoc failed" in r.json()["detail"].lower()

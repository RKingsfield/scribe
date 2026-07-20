from pathlib import Path

import pytest
from fastapi import HTTPException

from scribe.storage import frontmatter as fm
from scribe.storage import paths
from scribe.storage.fs import file_etag, write_text_atomic
from scribe.storage.manifest import walk_project
from scribe.storage.project import load_project


def test_path_escape_blocked(sample_project: Path) -> None:
    with pytest.raises(HTTPException):
        paths.resolve_in_project("example-novel", "../../etc/passwd")
    with pytest.raises(HTTPException):
        paths.resolve_in_project("example-novel", "/etc/passwd")
    with pytest.raises(HTTPException):
        paths.resolve_in_project("example-novel", "chapters/../../escape.md")


def test_null_byte_path_blocked(sample_project: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        paths.resolve_in_project("example-novel", "chapters/01_Chapter_01/01.md\x00.txt")
    assert exc.value.status_code == 400


def test_null_byte_slug_blocked(writing_root: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        paths.project_root("bar\x00row", must_exist=False)
    assert exc.value.status_code == 400


def test_invalid_slug_blocked(writing_root: Path) -> None:
    for bad in ["", "../foo", "foo/bar", ".hidden"]:
        with pytest.raises(HTTPException):
            paths.project_root(bad, must_exist=False)


def test_resolve_within_project(sample_project: Path) -> None:
    p = paths.resolve_in_project("example-novel", "chapters/01_Chapter_01/chapter.md")
    assert p.is_file()
    p = paths.resolve_in_project("example-novel", "chapters/01_Chapter_01/01.md")
    assert p.is_file()


def test_atomic_write_replaces(tmp_path: Path) -> None:
    target = tmp_path / "out.md"
    write_text_atomic(target, "first\n")
    assert target.read_text() == "first\n"
    write_text_atomic(target, "second\n")
    assert target.read_text() == "second\n"
    leftovers = list(tmp_path.glob(".out.md.*"))
    assert leftovers == []


def test_frontmatter_round_trip() -> None:
    text = "---\ntitle: X\nsummary: Y\n---\nbody\n"
    meta, body = fm.parse(text)
    assert meta["title"] == "X"
    assert body.strip() == "body"
    out = fm.serialize(meta, body)
    meta2, body2 = fm.parse(out)
    assert meta2["title"] == "X"
    assert body2.strip() == "body"


def test_word_count() -> None:
    assert fm.word_count("hello world") == 2
    assert fm.word_count("") == 0
    assert fm.word_count("one\ntwo three") == 3


def test_etag_changes_on_edit(tmp_path: Path) -> None:
    f = tmp_path / "x.md"
    f.write_text("a")
    e1 = file_etag(f)
    f.write_text("b")
    e2 = file_etag(f)
    assert e1 != e2


def test_manifest_walks_only_tracked_files(sample_project: Path) -> None:
    entries = walk_project(sample_project)
    paths_seen = {e["path"] for e in entries}
    assert "chapters/01_Chapter_01/chapter.md" in paths_seen
    assert "chapters/01_Chapter_01/01.md" in paths_seen
    assert "chapters/11_Chapter_11/01.md" in paths_seen
    assert "chapters/11_Chapter_11/02.md" in paths_seen
    assert "references/glossary.md" in paths_seen
    assert "character-profiles/tarn.md" in paths_seen
    assert "project.yml" in paths_seen
    for e in entries:
        assert e["sha256"] != "binary"
        assert e["size"] > 0


def test_manifest_skips_dotfiles(sample_project: Path) -> None:
    (sample_project / ".hidden.md").write_text("nope")
    (sample_project / ".git").mkdir()
    (sample_project / ".git" / "config").write_text("[core]")
    entries = walk_project(sample_project)
    for e in entries:
        assert not any(part.startswith(".") for part in e["path"].split("/"))


def test_load_project(sample_project: Path) -> None:
    p = load_project(sample_project)
    assert p.title == "The Example Novel"
    assert p.slug == "example-novel"
    assert len(p.acts) == 1
    assert p.acts[0].name == "Act One"
    assert p.acts[0].chapters == [1, 16]

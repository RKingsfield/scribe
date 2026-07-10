import os
from pathlib import Path

import pytest

os.environ.setdefault("SCRIBE_AUTOCOMMIT_DISABLED", "1")


@pytest.fixture
def writing_root(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr("scribe.config.WRITING_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def sample_project(writing_root: Path) -> Path:
    proj = writing_root / "barrow"
    (proj / "chapters" / "01_Chapter_01").mkdir(parents=True)
    (proj / "chapters" / "11_Chapter_11").mkdir(parents=True)
    (proj / "references").mkdir(parents=True)
    (proj / "character-profiles").mkdir(parents=True)

    (proj / "project.yml").write_text(
        "title: The Barrow Path\nslug: barrow\nauthor: Author\n"
        "default_model: local\nacts:\n  - name: Act One\n    chapters: [1, 16]\n",
        encoding="utf-8",
    )

    (proj / "chapters" / "01_Chapter_01" / "chapter.md").write_text(
        "---\ntitle: Chapter 1\nsummary: Opens on the killing ground.\n"
        "chapter: 1\norder: 1\nstatus: draft\nwords_target: 3000\npov: Tarn\n---\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "01_Chapter_01" / "01.md").write_text(
        "---\nscene: 1\norder: 1\n---\n## Chapter 1\n\nTarn tested his axe balance.\n",
        encoding="utf-8",
    )

    (proj / "chapters" / "11_Chapter_11" / "chapter.md").write_text(
        "---\ntitle: The Marsh\nchapter: 11\norder: 11\n---\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "11_Chapter_11" / "01.md").write_text(
        "---\nscene: 1\norder: 1\n---\nBody of scene 11.1.\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "11_Chapter_11" / "02.md").write_text(
        "---\nscene: 2\norder: 2\n---\nBody of scene 11.2.\n",
        encoding="utf-8",
    )

    (proj / "character-profiles" / "tarn.md").write_text(
        "---\ntitle: Tarn\naliases: [Old Tarn, the Foxhead]\n---\n"
        "Tarn is a Torvane warrior.\n",
        encoding="utf-8",
    )
    (proj / "references" / "glossary.md").write_text(
        "---\ntitle: Glossary\n---\nTorvane: mountain clan.\n",
        encoding="utf-8",
    )
    return proj

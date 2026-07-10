from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .fs import write_text_atomic


class Act(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str


class Category(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    folder: str
    codex: bool = True


DEFAULT_CATEGORIES: list[Category] = [
    Category(name="Characters", folder="character-profiles", codex=True),
    Category(name="References", folder="references", codex=True),
]


class Project(BaseModel):
    model_config = ConfigDict(extra="allow")
    title: str
    author: str | None = None
    slug: str
    rag_recipe: str | None = None
    default_model: str = "local"
    acts: list[Act] = Field(default_factory=list)
    categories: list[Category] | None = None

    @property
    def resolved_categories(self) -> list[Category]:
        return self.categories if self.categories is not None else list(DEFAULT_CATEGORIES)


def load_project(root: Path) -> Project:
    pyml = root / "project.yml"
    if not pyml.exists():
        return Project(title=root.name, slug=root.name)
    raw: dict[str, Any] = yaml.safe_load(pyml.read_text(encoding="utf-8")) or {}
    raw.setdefault("title", root.name)
    raw.setdefault("slug", root.name)
    return Project(**raw)


def save_project(root: Path, project: Project) -> None:
    pyml = root / "project.yml"
    text = yaml.safe_dump(
        project.model_dump(exclude_none=True, exclude_defaults=False),
        sort_keys=False,
        allow_unicode=True,
    )
    write_text_atomic(pyml, text)

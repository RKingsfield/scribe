from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..storage import frontmatter as fm
from ..storage import paths
from ..storage import structure
from ..storage.fs import write_text_atomic
from ..storage.helpers import order_sort_key
from ..storage.project import Act, Category, Project, load_project, save_project
from ..storage.tree import read_chapter_entry, read_reference_entry

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectListItem(BaseModel):
    slug: str
    title: str


class SceneEntry(BaseModel):
    path: str
    title: str | None = None
    summary: str | None = None
    scene: int | None = None
    order: float | None = None
    pov: str | None = None
    status: str | None = None
    words_target: int | None = None
    word_count: int = 0


class ChapterEntry(BaseModel):
    path: str            # directory path, e.g. "chapters/01"
    meta_path: str       # "chapters/01/chapter.md"
    slug: str            # "01" or "17_Chapter_16" or "16-interlude-01"
    kind: str = "chapter"  # "chapter" | "interlude"
    title: str | None = None
    summary: str | None = None
    chapter: int | None = None     # ordinal among chapter-kind entries
    interlude: int | None = None   # ordinal among interlude-kind entries
    order: float | None = None
    act: str | None = None
    scenes: list[SceneEntry] = []
    word_count: int = 0


class ReferenceEntry(BaseModel):
    path: str
    title: str | None = None
    aliases: list[str] = []
    tags: list[str] = []
    order: float | None = None


class CategoryData(BaseModel):
    name: str
    folder: str
    codex: bool = True
    entries: list[ReferenceEntry] = []


class ProjectTree(BaseModel):
    slug: str
    title: str
    author: str | None = None
    rag_recipe: str | None = None
    default_model: str = "local"
    acts: list[Act] = []
    chapters: list[ChapterEntry] = []
    categories: list[CategoryData] = []


class ProjectUpdate(BaseModel):
    title: str | None = None
    author: str | None = None
    rag_recipe: str | None = None
    default_model: str | None = None
    acts: list[Act] | None = None
    categories: list[Category] | None = None


@router.get("", response_model=list[ProjectListItem])
def get_projects() -> list[ProjectListItem]:
    items: list[ProjectListItem] = []
    for slug in paths.list_projects():
        root = paths.writing_root() / slug
        try:
            p = load_project(root)
            items.append(ProjectListItem(slug=p.slug or slug, title=p.title))
        except (OSError, ValueError):
            items.append(ProjectListItem(slug=slug, title=slug))
    return items


@router.get("/{slug}", response_model=ProjectTree)
def get_project(slug: str) -> ProjectTree:
    root = paths.project_root(slug)
    p = load_project(root)

    chapter_dirs = structure.list_chapter_dirs(root)
    chapters = [ChapterEntry(**read_chapter_entry(root, c)) for c in chapter_dirs]
    chapters.sort(key=lambda c: order_sort_key(c.order, c.slug))

    cat_data: list[CategoryData] = []
    for cat in p.resolved_categories:
        entries: list[ReferenceEntry] = []
        cat_dir = root / cat.folder
        if cat_dir.is_dir():
            for fp in cat_dir.glob("*.md"):
                entries.append(ReferenceEntry(**read_reference_entry(f"{cat.folder}/{fp.name}", fp)))
            entries.sort(key=lambda r: order_sort_key(r.order, r.path))
        cat_data.append(CategoryData(
            name=cat.name,
            folder=cat.folder,
            codex=cat.codex,
            entries=entries,
        ))

    return ProjectTree(
        slug=p.slug or slug,
        title=p.title,
        author=p.author,
        rag_recipe=p.rag_recipe,
        default_model=p.default_model,
        acts=p.acts,
        chapters=chapters,
        categories=cat_data,
    )


@router.put("/{slug}", response_model=Project)
def put_project(slug: str, update: ProjectUpdate) -> Project:
    root = paths.project_root(slug)
    p = load_project(root)

    if update.acts is not None:
        _apply_act_renames(root, p.acts, update.acts)

    data = p.model_dump()
    for k, v in update.model_dump(exclude_none=True).items():
        data[k] = v
    new = Project(**data)
    save_project(root, new)
    return new


def _apply_act_renames(root: Path, old_acts: list[Act], new_acts: list[Act]) -> None:
    renames: dict[str, str] = {}
    for old, new in zip(old_acts, new_acts):
        if old.name != new.name:
            renames[old.name] = new.name
    if not renames:
        return
    for chapter_dir in structure.list_chapter_dirs(root):
        meta_path = root / chapter_dir.meta_rel_path
        if not meta_path.is_file():
            continue
        text = meta_path.read_text(encoding="utf-8")
        meta, body = fm.parse(text)
        act_val = meta.get("act")
        if act_val in renames:
            meta["act"] = renames[act_val]
            write_text_atomic(meta_path, fm.serialize(meta, body))


@router.post("/{slug}/init", response_model=Project, status_code=201)
def init_project(slug: str, init: ProjectUpdate) -> Project:
    if "/" in slug or slug.startswith(".") or not slug:
        raise HTTPException(400, f"Invalid slug: {slug!r}")
    root = paths.writing_root() / slug
    if root.exists():
        raise HTTPException(409, f"Project already exists: {slug}")
    root.mkdir(parents=True, exist_ok=True)
    (root / "chapters").mkdir(exist_ok=True)
    p = Project(
        title=init.title or slug,
        author=init.author,
        slug=slug,
        rag_recipe=init.rag_recipe,
        default_model=init.default_model or "local",
        acts=init.acts or [],
    )
    for cat in p.resolved_categories:
        (root / cat.folder).mkdir(exist_ok=True)
    save_project(root, p)
    return p

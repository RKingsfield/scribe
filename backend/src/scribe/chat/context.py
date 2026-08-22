"""Build a scoped corpus from the on-disk project for an LLM chat request."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..storage import frontmatter as fm
from ..storage import paths, structure
from ..storage.project import load_project
from ..storage.tree import read_chapter_scenes

ScopeKind = Literal["everything", "act", "chapter", "scene", "codex"]


class ScopeRequest(BaseModel):
    kind: ScopeKind
    act: int | None = None
    chapter_slug: str | None = Field(default=None, alias="chapter")
    scene_path: str | None = Field(default=None, alias="path")

    model_config = {"populate_by_name": True}


@dataclass
class FileSection:
    path: str
    title: str | None
    text: str  # raw file body (no frontmatter), may include leading meta line


@dataclass
class ScopeBundle:
    label: str
    sections: list[FileSection] = field(default_factory=list)
    codex: str | None = None  # rendered codex block (characters + references)

    @property
    def char_count(self) -> int:
        n = sum(len(s.text) for s in self.sections)
        if self.codex:
            n += len(self.codex)
        return n

    @property
    def estimated_tokens(self) -> int:
        # rough char/4 heuristic; good enough for a UI hint
        return self.char_count // 4


def _read_section(project_root: Path, rel_path: str) -> FileSection:
    abs_path = project_root / rel_path
    text = abs_path.read_text(encoding="utf-8")
    meta, body = fm.parse_lenient(text)
    title = meta.get("title")
    return FileSection(path=rel_path, title=title, text=body)


def _collect_chapter(project_root: Path, ch: structure.ChapterDir) -> list[FileSection]:
    sections: list[FileSection] = [_read_section(project_root, ch.meta_rel_path)]
    for _, rel_path, meta, body in read_chapter_scenes(project_root, ch.slug):
        sections.append(FileSection(path=rel_path, title=meta.get("title"), text=body))
    return sections


def build_codex(project_root: Path) -> str | None:
    proj = load_project(project_root)
    blocks: list[str] = []
    for cat in proj.resolved_categories:
        if not cat.codex:
            continue
        cat_dir = project_root / cat.folder
        if not cat_dir.is_dir():
            continue
        chunk: list[str] = [f"# {cat.name}\n"]
        for fp in sorted(cat_dir.glob("*.md")):
            text = fp.read_text(encoding="utf-8")
            meta, body = fm.parse_lenient(text)
            title = meta.get("title") or fp.stem
            aliases = meta.get("aliases") or []
            alias_str = f" (aka {', '.join(str(a) for a in aliases)})" if aliases else ""
            chunk.append(f"## {title}{alias_str}\n\n{body.strip()}\n")
        if len(chunk) > 1:
            blocks.append("\n".join(chunk))
    if not blocks:
        return None
    return "\n\n".join(blocks)


def _chapter_act(project_root: Path, ch: structure.ChapterDir) -> str | None:
    """Resolve which act a chapter belongs to, from its `act` frontmatter."""
    meta_text = (project_root / ch.meta_rel_path).read_text(encoding="utf-8")
    meta, _ = fm.parse_lenient(meta_text)
    if meta.get("act"):
        return str(meta["act"])
    return None


def build_bundle(slug: str, scope: ScopeRequest, include_codex: bool) -> ScopeBundle:
    """Read the requested scope from disk into a ScopeBundle."""
    project_root = paths.project_root(slug)
    project = load_project(project_root)

    sections: list[FileSection] = []
    label = ""

    if scope.kind == "everything":
        label = f"Whole project — {project.title}"
        for ch in structure.list_chapter_dirs(project_root):
            sections.extend(_collect_chapter(project_root, ch))

    elif scope.kind == "act":
        if scope.act is None:
            raise ValueError("scope.act is required when kind='act'")
        # match either project.yml `acts[].name` (string match against scope.act
        # treated as 1-indexed position) or explicit `act:` frontmatter values.
        act_index = int(scope.act) - 1
        if 0 <= act_index < len(project.acts):
            target_name = project.acts[act_index].name
        else:
            target_name = str(scope.act)
        label = f"Act — {target_name}"
        for ch in structure.list_chapter_dirs(project_root):
            ch_act = _chapter_act(project_root, ch)
            if ch_act == target_name:
                sections.extend(_collect_chapter(project_root, ch))

    elif scope.kind == "chapter":
        if not scope.chapter_slug:
            raise ValueError("scope.chapter is required when kind='chapter'")
        target = next(
            (
                c
                for c in structure.list_chapter_dirs(project_root)
                if c.slug == scope.chapter_slug
            ),
            None,
        )
        if target is None:
            raise ValueError(f"chapter not found: {scope.chapter_slug}")
        meta_text = (project_root / target.meta_rel_path).read_text(encoding="utf-8")
        meta, _ = fm.parse_lenient(meta_text)
        label = f"Chapter — {meta.get('title') or target.slug}"
        sections.extend(_collect_chapter(project_root, target))

    elif scope.kind == "scene":
        if not scope.scene_path:
            raise ValueError("scope.path is required when kind='scene'")
        paths.resolve_in_project(slug, scope.scene_path)
        sec = _read_section(project_root, scope.scene_path)
        label = f"Scene — {sec.title or scope.scene_path}"
        sections.append(sec)

    elif scope.kind == "codex":
        label = "Codex only"
        # codex is forced on regardless of include_codex flag
        include_codex = True

    else:
        raise ValueError(f"unknown scope kind: {scope.kind}")

    codex = build_codex(project_root) if include_codex else None
    return ScopeBundle(label=label, sections=sections, codex=codex)


def render_system_prompt(project_title: str, bundle: ScopeBundle) -> str:
    """Render the bundle into a single system-message string."""
    parts: list[str] = [
        (
            f"You are scribe, a writing assistant embedded in a draft of "
            f"\"{project_title}\". Be concise and grounded in the provided context. "
            f"When the user asks for prose, match the existing voice. When asked "
            f"about facts, cite the relevant chapter or character by name."
        ),
        "",
        f"Scope: {bundle.label}",
        "",
    ]
    if bundle.codex:
        parts.append("---")
        parts.append("# Codex")
        parts.append("")
        parts.append(bundle.codex)
        parts.append("")
    if bundle.sections:
        parts.append("---")
        parts.append("# Manuscript")
        parts.append("")
        for sec in bundle.sections:
            heading = sec.title or sec.path
            parts.append(f"## {heading}")
            parts.append(f"_{sec.path}_")
            parts.append("")
            parts.append(sec.text.strip())
            parts.append("")
    return "\n".join(parts)

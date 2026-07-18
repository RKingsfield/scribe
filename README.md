# scribe

A self-hosted writing app for novelists who want to own their files.

Most novel-writing software stores your work in proprietary formats or cloud databases. If the service shuts down or you want to switch tools, you're stuck exporting and hoping nothing breaks. Scribe takes a different approach: your chapters and scenes are plain markdown files in directories on your filesystem. You can `grep` them, `git diff` them, edit them in vim if you want to. The app is a layer on top of your files, not a container around them.

It runs as a single Docker container with a FastAPI backend and React PWA frontend. Point it at a directory of markdown files and go.

![Editor with sidebar and scene sidecard](docs/screenshots/write-dark.png)

![Outline planning view with act-grouped chapters](docs/screenshots/plan-outline.png)

![AI chat with scope picker and model selection](docs/screenshots/chat.png)

It's also a PWA you can pin to your phone or tablet. Edit on the plane, sync when you land -- writes go to IndexedDB immediately and flush to the server whenever you're back online. Conflicts are saved as plaintext files you can merge by hand, so nothing gets lost.

For AI-assisted writing, scribe can generate a RAG recipe from your novel's data -- characters, references, world-building notes -- for ingestion into your own LLM pipeline. You can ask questions about your world and characters without sending your manuscript to a third-party service. Everything stays on your infrastructure.

## What you get

Your novel lives as a directory tree of `.md` files with YAML frontmatter. Chapters are directories, scenes are files inside them. The app wraps that structure in a writing-focused UI:

- A distraction-free editor (CodeMirror 6) with live markdown preview, typewriter mode, and codex-aware character name highlighting
- Drag-and-drop scene and chapter reordering, including cross-chapter scene moves
- Outline and status corkboard views for planning at the act/chapter level
- AI chat and rewrite with configurable scope (scene, chapter, act, everything, codex), supporting OpenAI-compatible endpoints and the Anthropic API
- Per-novel RAG recipe generation for external ingest pipelines, with an in-app query interface
- Export to markdown, docx, epub, or html via pandoc, with `[[scene beats]]` stripped by default
- Token-gated beta reader view with highlight-anchored comments that survive edits to the underlying text
- Per-novel git with automatic commits and push to a configured remote

## Getting started

### Docker (recommended)

```bash
docker build -t scribe .
docker run -d \
  -p 3030:3030 \
  -v /path/to/writing:/data/writing \
  -v /path/to/appdata:/data/appdata \
  scribe
```

Open `http://localhost:3030` and create a project, or set `WRITING_ROOT` to an existing directory of markdown files.

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data model, module layout, request flow
- [DESIGN.md](docs/DESIGN.md) — why it's built this way, each trade-off explained
- [CODE_WALKTHROUGH.md](docs/CODE_WALKTHROUGH.md) — module-by-module deep dive into how everything works
- [Developer's guide](docs/DEVELOPERS_GUIDE.md) — local dev setup, configuration, contributing

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

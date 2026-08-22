"""Tests for the chat routes + scope-bundle builder."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from scribe.chat.context import ScopeRequest, build_bundle, render_system_prompt

# ---------------- scope builder ----------------


def test_scope_everything_pulls_all_chapters_and_scenes(sample_project: Path) -> None:
    bundle = build_bundle("example-novel", ScopeRequest(kind="everything"), include_codex=False)
    paths = [s.path for s in bundle.sections]
    assert "chapters/01_Chapter_01/chapter.md" in paths
    assert "chapters/01_Chapter_01/01.md" in paths
    assert "chapters/11_Chapter_11/chapter.md" in paths
    assert "chapters/11_Chapter_11/01.md" in paths
    assert "chapters/11_Chapter_11/02.md" in paths
    assert bundle.codex is None


def test_scope_chapter_returns_only_one_chapter(sample_project: Path) -> None:
    bundle = build_bundle(
        "example-novel",
        ScopeRequest(kind="chapter", chapter="11_Chapter_11"),
        include_codex=False,
    )
    paths = [s.path for s in bundle.sections]
    assert paths == [
        "chapters/11_Chapter_11/chapter.md",
        "chapters/11_Chapter_11/01.md",
        "chapters/11_Chapter_11/02.md",
    ]
    assert "Chapter — The Marsh" == bundle.label


def test_scope_scene_returns_single_file(sample_project: Path) -> None:
    bundle = build_bundle(
        "example-novel",
        ScopeRequest(kind="scene", path="chapters/11_Chapter_11/02.md"),
        include_codex=False,
    )
    assert len(bundle.sections) == 1
    assert bundle.sections[0].path == "chapters/11_Chapter_11/02.md"


def test_scope_codex_only_returns_codex(sample_project: Path) -> None:
    bundle = build_bundle("example-novel", ScopeRequest(kind="codex"), include_codex=False)
    assert bundle.sections == []
    assert bundle.codex is not None
    assert "Tarn" in bundle.codex
    assert "Glossary" in bundle.codex


def test_include_codex_attaches_codex_to_any_scope(sample_project: Path) -> None:
    bundle = build_bundle(
        "example-novel",
        ScopeRequest(kind="scene", path="chapters/11_Chapter_11/02.md"),
        include_codex=True,
    )
    assert bundle.codex is not None
    assert "Tarn" in bundle.codex


def test_render_system_prompt_includes_scope_label_and_paths(sample_project: Path) -> None:
    bundle = build_bundle(
        "example-novel",
        ScopeRequest(kind="chapter", chapter="01_Chapter_01"),
        include_codex=True,
    )
    prompt = render_system_prompt("The Example Novel", bundle)
    assert "The Example Novel" in prompt
    assert "Chapter — Chapter 1" in prompt
    assert "_chapters/01_Chapter_01/01.md_" in prompt
    assert "# Codex" in prompt


def test_scope_chapter_unknown_slug_raises(sample_project: Path) -> None:
    with pytest.raises(ValueError):
        build_bundle(
            "example-novel",
            ScopeRequest(kind="chapter", chapter="does-not-exist"),
            include_codex=False,
        )


@pytest.mark.parametrize(
    "bad_path",
    ["/etc/passwd", "../outside.md", ".git/config"],
)
def test_scope_scene_traversal_rejected(sample_project: Path, bad_path: str) -> None:
    with pytest.raises(HTTPException) as exc:
        build_bundle(
            "example-novel",
            ScopeRequest(kind="scene", path=bad_path),
            include_codex=False,
        )
    assert exc.value.status_code == 400


# ---------------- /scope/preview ----------------


def test_scope_preview_returns_estimates(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/scope/preview",
        json={
            "messages": [],
            "scope": {"kind": "everything"},
            "include_codex": True,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["section_count"] >= 5
    assert data["char_count"] > 0
    assert data["estimated_tokens"] >= 0
    assert data["codex_included"] is True
    assert "Whole project" in data["label"]


def test_scope_preview_chapter(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/scope/preview",
        json={
            "messages": [],
            "scope": {"kind": "chapter", "chapter": "11_Chapter_11"},
            "include_codex": False,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["section_count"] == 3
    assert data["codex_included"] is False


def test_scope_preview_act_returns_only_assigned_chapter(
    writing_root: Path, client: TestClient
) -> None:
    proj = writing_root / "acttest"
    (proj / "chapters" / "01_Chapter_01").mkdir(parents=True)
    (proj / "chapters" / "02_Chapter_02").mkdir(parents=True)
    (proj / "project.yml").write_text(
        "title: Act Test\nslug: acttest\nauthor: Author\n"
        "default_model: local\nacts:\n  - name: Act I\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "01_Chapter_01" / "chapter.md").write_text(
        "---\ntitle: Chapter 1\nchapter: 1\norder: 1\nact: Act I\n---\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "01_Chapter_01" / "01.md").write_text(
        "---\nscene: 1\norder: 1\n---\nScene one body.\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "02_Chapter_02" / "chapter.md").write_text(
        "---\ntitle: Chapter 2\nchapter: 2\norder: 2\n---\n",
        encoding="utf-8",
    )
    (proj / "chapters" / "02_Chapter_02" / "01.md").write_text(
        "---\nscene: 1\norder: 1\n---\nScene two body.\n",
        encoding="utf-8",
    )

    r = client.post(
        "/api/projects/acttest/chat/scope/preview",
        json={
            "messages": [],
            "scope": {"kind": "act", "act": 1},
            "include_codex": False,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["section_count"] == 2


def test_scope_preview_survives_malformed_scene_frontmatter(
    sample_project: Path, client: TestClient
) -> None:
    scene = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    scene.write_text("---\ntitle: [unclosed\n---\nBody text here.\n", encoding="utf-8")
    r = client.post(
        "/api/projects/example-novel/chat/scope/preview",
        json={
            "messages": [],
            "scope": {"kind": "everything"},
            "include_codex": False,
        },
    )
    assert r.status_code == 200


def test_scope_preview_invalid_kind_returns_400(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/scope/preview",
        json={"messages": [], "scope": {"kind": "act"}, "include_codex": False},
    )
    # missing act number
    assert r.status_code == 400


@pytest.mark.parametrize(
    "bad_path",
    ["/etc/passwd", "../outside.md", ".git/config"],
)
def test_scope_preview_scene_traversal_rejected(
    sample_project: Path, bad_path: str, client: TestClient
) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/scope/preview",
        json={
            "messages": [],
            "scope": {"kind": "scene", "path": bad_path},
            "include_codex": False,
        },
    )
    assert r.status_code == 400


@pytest.mark.parametrize(
    "bad_path",
    ["/etc/passwd", "../outside.md", ".git/config"],
)
def test_stream_scene_traversal_rejected(
    sample_project: Path, bad_path: str, client: TestClient
) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "scene", "path": bad_path},
        },
    )
    assert r.status_code == 400


# ---------------- /stream ----------------


class _FakeStreamResp:
    def __init__(self, lines: list[str], status_code: int = 200) -> None:
        self._lines = lines
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aread(self) -> bytes:
        return "\n".join(self._lines).encode()

    async def aiter_lines(self) -> AsyncIterator[str]:
        for ln in self._lines:
            yield ln


class _FakeAsyncClient:
    def __init__(self, lines: list[str], status_code: int = 200, **kwargs: Any) -> None:
        self._lines = lines
        self._status = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method: str, url: str, **kwargs: Any) -> _FakeStreamResp:
        return _FakeStreamResp(self._lines, self._status)

    async def get(self, url: str, **kwargs: Any) -> _FakeGetResp:
        return _FakeGetResp(
            {
                "object": "list",
                "data": [
                    {"id": "auto-router", "owned_by": "orchestrator"},
                    {"id": "Cydonia-24B-v4.3", "owned_by": "llamacpp", "tags": []},
                ],
            }
        )


class _FakeGetResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def _patch_orchestrator(monkeypatch: pytest.MonkeyPatch, lines: list[str], status: int = 200) -> None:
    def factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
        return _FakeAsyncClient(lines, status)

    monkeypatch.setattr("scribe.routes.chat.httpx.AsyncClient", factory)


def test_stream_relays_orchestrator_chunks(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        'data: {"choices":[{"delta":{"content":" there"}}]}',
        "data: [DONE]",
    ]
    _patch_orchestrator(monkeypatch, chunks)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "Say hi"}],
            "scope": {"kind": "scene", "path": "chapters/11_Chapter_11/02.md"},
        },
    ) as r:
        assert r.status_code == 200
        body = b"".join(r.iter_bytes()).decode()
    # meta first
    assert "event: meta" in body
    assert "Scene" in body  # scope label leaked through meta payload
    # chunks pass through
    assert "Hi" in body
    assert "[DONE]" in body


def test_stream_relays_orchestrator_error(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_orchestrator(monkeypatch, ["upstream is unhappy"], status=500)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "Hello"}],
            "scope": {"kind": "everything"},
        },
    ) as r:
        body = b"".join(r.iter_bytes()).decode()
    assert "event: error" in body
    payload = body.split("event: error\ndata: ", 1)[1].split("\n", 1)[0]
    assert json.loads(payload)["status"] == 500


def test_rewrite_relays_orchestrator_chunks(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    chunks = [
        'data: {"choices":[{"delta":{"content":"Tarn weighed"}}]}',
        'data: {"choices":[{"delta":{"content":" the axe."}}]}',
        "data: [DONE]",
    ]
    _patch_orchestrator(monkeypatch, chunks)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/rewrite",
        json={
            "selection": "Tarn tested his axe balance.",
            "instruction": "Tighten this; cut adverbs",
            "before_context": "The hall was empty.",
            "after_context": "He turned to the door.",
        },
    ) as r:
        assert r.status_code == 200
        body = b"".join(r.iter_bytes()).decode()
    assert "event: meta" in body
    assert "selection_chars" in body
    assert "Tarn weighed" in body
    assert "[DONE]" in body


def test_rewrite_rejects_empty_selection(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/rewrite",
        json={"selection": "   ", "instruction": "tighten"},
    )
    assert r.status_code == 400


def test_rewrite_rejects_empty_instruction(sample_project: Path, client: TestClient) -> None:
    r = client.post(
        "/api/projects/example-novel/chat/rewrite",
        json={"selection": "Tarn tested his axe balance.", "instruction": ""},
    )
    assert r.status_code == 400


def test_models_proxy_returns_cleaned_list(monkeypatch, client: TestClient) -> None:
    _patch_orchestrator(monkeypatch, [])
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "")
    r = client.get("/api/models")
    assert r.status_code == 200
    items = r.json()
    ids = [m["id"] for m in items]
    assert "auto-router" in ids
    assert "Cydonia-24B-v4.3" in ids
    assert not any(i.startswith("claude") for i in ids)


def test_models_proxy_appends_claude_when_key_set(monkeypatch, client: TestClient) -> None:
    _patch_orchestrator(monkeypatch, [])
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    r = client.get("/api/models")
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()]
    assert "claude-opus-4-8" in ids
    assert "claude-sonnet-5" in ids


# ---------------- M15: Claude API escape hatch ----------------


class _FakeAnthropicStreamResp:
    def __init__(self, lines: list[str], status_code: int = 200) -> None:
        self._lines = lines
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aread(self) -> bytes:
        return "\n".join(self._lines).encode()

    async def aiter_lines(self) -> AsyncIterator[str]:
        for ln in self._lines:
            yield ln


class _FakeAnthropicClient:
    def __init__(self, lines: list[str], status_code: int = 200, **kwargs: Any) -> None:
        self._lines = lines
        self._status = status_code
        self.captured: dict[str, Any] = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method: str, url: str, **kwargs: Any) -> _FakeAnthropicStreamResp:
        self.captured["url"] = url
        self.captured["headers"] = kwargs.get("headers")
        self.captured["json"] = kwargs.get("json")
        return _FakeAnthropicStreamResp(self._lines, self._status)


def _patch_anthropic(
    monkeypatch: pytest.MonkeyPatch, lines: list[str], status: int = 200
) -> dict[str, Any]:
    holder: dict[str, Any] = {}

    def factory(*args: Any, **kwargs: Any) -> _FakeAnthropicClient:
        c = _FakeAnthropicClient(lines, status)
        holder["client"] = c
        return c

    monkeypatch.setattr("scribe.chat.anthropic.httpx.AsyncClient", factory)
    return holder


def test_anthropic_convert_messages_extracts_system() -> None:
    from scribe.chat.anthropic import convert_messages

    sys, msgs = convert_messages(
        [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
    )
    assert sys == "be terse"
    assert msgs == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]


def test_anthropic_build_body_drops_system_into_top_level() -> None:
    from scribe.chat.anthropic import build_anthropic_body

    body = build_anthropic_body(
        {
            "model": "claude-opus-4-7",
            "messages": [
                {"role": "system", "content": "you are scribe"},
                {"role": "user", "content": "rewrite this"},
            ],
            "stream": True,
            "temperature": 0.4,
            "max_tokens": 2048,
        }
    )
    assert body["model"] == "claude-opus-4-7"
    assert body["system"] == "you are scribe"
    assert body["max_tokens"] == 2048
    assert body["temperature"] == 0.4
    assert body["stream"] is True
    assert body["messages"] == [{"role": "user", "content": "rewrite this"}]


def test_stream_routes_to_anthropic_and_translates_text_deltas(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    lines = [
        "event: message_start",
        'data: {"type":"message_start","message":{"id":"m1"}}',
        "",
        "event: content_block_start",
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        "event: ping",
        "data: {}",
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
    holder = _patch_anthropic(monkeypatch, lines)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "say hi"}],
            "scope": {"kind": "scene", "path": "chapters/11_Chapter_11/02.md"},
            "model": "claude-opus-4-7",
        },
    ) as r:
        assert r.status_code == 200
        body = b"".join(r.iter_bytes()).decode()
    assert "event: meta" in body
    assert '"upstream": "anthropic"' in body
    # text deltas got rewrapped as OpenAI-style chunks
    assert '"content": "Hello"' in body
    assert '"content": " world"' in body
    assert "[DONE]" in body
    captured = holder["client"].captured
    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-ant-test"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    sent = captured["json"]
    assert sent["model"] == "claude-opus-4-7"
    assert "system" in sent
    assert sent["messages"][0]["role"] == "user"


def test_stream_anthropic_surfaces_upstream_error(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    _patch_anthropic(
        monkeypatch,
        ['{"type":"error","error":{"type":"overloaded","message":"upstream busy"}}'],
        status=529,
    )
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "everything"},
            "model": "claude-opus-4-7",
        },
    ) as r:
        body = b"".join(r.iter_bytes()).decode()
    assert "event: error" in body
    payload = body.split("event: error\ndata: ", 1)[1].split("\n", 1)[0]
    assert json.loads(payload)["status"] == 529


def test_stream_anthropic_error_after_text_deltas(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    lines = [
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        "",
        "event: error",
        'data: {"type":"error","error":{"type":"overloaded","message":"upstream busy"}}',
        "",
    ]
    _patch_anthropic(monkeypatch, lines)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "everything"},
            "model": "claude-opus-4-7",
        },
    ) as r:
        body = b"".join(r.iter_bytes()).decode()
    assert '"content": "Hello"' in body
    assert "event: error" in body
    assert body.index('"content": "Hello"') < body.index("event: error")
    # broken response — no trailing [DONE] after an error
    assert "[DONE]" not in body


def test_stream_anthropic_flushes_trailing_text_without_message_stop(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    lines = [
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Wow<t"}}',
        "",
        # stream just ends here — no message_stop, no error
    ]
    _patch_anthropic(monkeypatch, lines)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "everything"},
            "model": "claude-opus-4-7",
        },
    ) as r:
        body = b"".join(r.iter_bytes()).decode()
    assert '"content": "Wow"' in body
    assert '"content": "<t"' in body
    assert "[DONE]" in body


def test_stream_anthropic_skips_garbage_data_frames(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    lines = [
        "event: content_block_delta",
        "data: not-json-at-all",
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        "",
        "data: {also not valid json",
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
    _patch_anthropic(monkeypatch, lines)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "everything"},
            "model": "claude-opus-4-7",
        },
    ) as r:
        assert r.status_code == 200
        body = b"".join(r.iter_bytes()).decode()
    assert '"content": "Hello"' in body
    assert "[DONE]" in body


def test_stream_503_when_claude_requested_without_key(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "")
    r = client.post(
        "/api/projects/example-novel/chat/stream",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "scope": {"kind": "scene", "path": "chapters/11_Chapter_11/02.md"},
            "model": "claude-opus-4-7",
        },
    )
    assert r.status_code == 503


# ---------------- think-block suppression ----------------


def test_strip_think_blocks_simple():
    from scribe.chat.anthropic import strip_think_blocks

    assert strip_think_blocks("Hello <think>internal</think> world") == "Hello  world"


def test_strip_think_blocks_multiline():
    from scribe.chat.anthropic import strip_think_blocks

    text = "Before <think>\nreasoning\nstuff\n</think> after"
    assert strip_think_blocks(text) == "Before  after"


def test_strip_think_blocks_none():
    from scribe.chat.anthropic import strip_think_blocks

    assert strip_think_blocks("No thinking here") == "No thinking here"


def test_think_filter_single_chunk():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello world") == "Hello world"


def test_think_filter_suppresses_think_block():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello <think>secret</think> world") == "Hello  world"


def test_think_filter_across_chunks():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello <thi") == "Hello "
    assert f.feed("nk>secret stuff") == ""
    assert f.feed("</think> world") == " world"


def test_think_filter_partial_close_tag():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello <think>secret</thi") == "Hello "
    assert f.feed("nk> world") == " world"


def test_think_filter_flush_partial_non_tag():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    result = f.feed("Hello <b>bold</b>")
    assert "<b>" in result


def test_think_filter_flush_emits_held_tag_prefix():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("a<t") == "a"
    assert f.flush() == "<t"


def test_think_filter_flush_drops_unterminated_think_block():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello <think>secret") == "Hello "
    assert f.flush() == ""


def test_think_filter_flush_noop_when_buffer_empty():
    from scribe.chat.anthropic import ThinkBlockFilter

    f = ThinkBlockFilter()
    assert f.feed("Hello world") == "Hello world"
    assert f.flush() == ""


def test_rewrite_routes_to_anthropic(sample_project: Path, monkeypatch, client: TestClient) -> None:
    monkeypatch.setattr("scribe.config.ANTHROPIC_API_KEY", "sk-ant-test")
    lines = [
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Tarn weighed the axe."}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
    _patch_anthropic(monkeypatch, lines)
    with client.stream(
        "POST",
        "/api/projects/example-novel/chat/rewrite",
        json={
            "selection": "Tarn tested his axe balance.",
            "instruction": "Tighten this.",
            "model": "claude-opus-4-7",
        },
    ) as r:
        assert r.status_code == 200
        body = b"".join(r.iter_bytes()).decode()
    assert "Tarn weighed the axe." in body
    assert '"upstream": "anthropic"' in body
    assert "[DONE]" in body


# ---------------- /summarize ----------------


class _FakeSummarizeResp:
    def __init__(self, data: dict, status_code: int = 200) -> None:
        self._data = data
        self.status_code = status_code

    def json(self) -> dict:
        return self._data


class _FakeSummarizeClient:
    def __init__(self, resp: _FakeSummarizeResp) -> None:
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url: str, **kwargs: Any) -> _FakeSummarizeResp:
        return self._resp


def _patch_summarize(monkeypatch: pytest.MonkeyPatch, data: dict, status: int = 200) -> None:
    def factory(*args: Any, **kwargs: Any) -> _FakeSummarizeClient:
        return _FakeSummarizeClient(_FakeSummarizeResp(data, status))

    monkeypatch.setattr("scribe.routes.chat.httpx.AsyncClient", factory)


def test_summarize_orchestrator_strips_think_blocks(
    sample_project: Path, monkeypatch, client: TestClient
) -> None:
    _patch_summarize(
        monkeypatch,
        {
            "choices": [
                {
                    "message": {
                        "content": "<think>reasoning</think>Summary."
                    }
                }
            ]
        },
    )
    r = client.post(
        "/api/projects/example-novel/chat/summarize",
        json={"path": "chapters/11_Chapter_11/02.md"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["summary"] == "Summary."

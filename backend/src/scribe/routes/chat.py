"""Chat routes: scope preview + streaming completions."""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import config
from ..chat.anthropic import (
    complete_anthropic,
    is_claude_model,
    stream_anthropic,
    synthetic_models,
)
from ..chat.context import ScopeBundle, ScopeRequest, build_bundle, render_system_prompt
from ..storage import frontmatter as fm
from ..storage.project import load_project
from ..storage import paths

log = logging.getLogger(__name__)

ORCHESTRATOR_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=30.0)
SUMMARIZE_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=30.0)
MODELS_TIMEOUT = 10.0

router = APIRouter(prefix="/api/projects/{slug}/chat", tags=["chat"])
models_router = APIRouter(prefix="/api", tags=["chat"])


class ChatMessage(BaseModel):
    role: str  # 'user' | 'assistant' | 'system'
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    scope: ScopeRequest
    include_codex: bool = False
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, gt=0)


class RewriteRequest(BaseModel):
    selection: str
    instruction: str
    before_context: str = ""
    after_context: str = ""
    include_codex: bool = False
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=config.REWRITE_DEFAULT_MAX_TOKENS, gt=0)


class ScopePreviewResponse(BaseModel):
    label: str
    section_count: int
    char_count: int
    estimated_tokens: int
    codex_included: bool


async def _stream_orchestrator(
    url: str, body: dict[str, Any], meta_event: dict[str, Any],
    *, use_claude: bool = False,
) -> AsyncIterator[bytes]:
    """Shared SSE generator for orchestrator (and Claude) streaming routes."""
    yield f"event: meta\ndata: {json.dumps(meta_event)}\n\n".encode()
    if use_claude:
        async for chunk in stream_anthropic(body):
            yield chunk
        return
    try:
        async with httpx.AsyncClient(timeout=ORCHESTRATOR_TIMEOUT) as client:
            async with client.stream("POST", url, json=body) as resp:
                if resp.status_code >= 400:
                    err_text = await resp.aread()
                    err = {
                        "status": resp.status_code,
                        "body": err_text.decode("utf-8", errors="replace")[:2000],
                    }
                    yield f"event: error\ndata: {json.dumps(err)}\n\n".encode()
                    return
                async for line in resp.aiter_lines():
                    if not line:
                        yield b"\n"
                        continue
                    yield (line + "\n").encode()
    except httpx.HTTPError as e:
        log.exception("orchestrator stream failed")
        err = {"status": 502, "body": f"orchestrator unreachable: {e}"}
        yield f"event: error\ndata: {json.dumps(err)}\n\n".encode()


@router.post("/scope/preview", response_model=ScopePreviewResponse)
def scope_preview(slug: str, req: ChatRequest) -> ScopePreviewResponse:
    """Dry-run: return the size of the scope so the UI can show a token badge."""
    try:
        bundle = build_bundle(slug, req.scope, req.include_codex)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return ScopePreviewResponse(
        label=bundle.label,
        section_count=len(bundle.sections),
        char_count=bundle.char_count,
        estimated_tokens=bundle.estimated_tokens,
        codex_included=bundle.codex is not None,
    )


def _build_payload(slug: str, req: ChatRequest) -> tuple[dict[str, Any], ScopeBundle]:
    project_root = paths.project_root(slug)
    project = load_project(project_root)
    bundle = build_bundle(slug, req.scope, req.include_codex)
    system_msg = render_system_prompt(project.title, bundle)
    messages = [{"role": "system", "content": system_msg}]
    messages.extend({"role": m.role, "content": m.content} for m in req.messages)
    body: dict[str, Any] = {
        "model": req.model or project.default_model or "auto-router",
        "messages": messages,
        "stream": True,
    }
    if req.temperature is not None:
        body["temperature"] = req.temperature
    if req.max_tokens is not None:
        body["max_tokens"] = req.max_tokens
    return body, bundle


@router.post("/stream")
async def stream_chat(slug: str, req: ChatRequest) -> StreamingResponse:
    """Forward to orchestrator (or Anthropic) with stream=true and relay SSE."""
    try:
        body, bundle = _build_payload(slug, req)
    except ValueError as e:
        raise HTTPException(400, str(e))

    use_claude = is_claude_model(body.get("model"))
    if use_claude and not config.ANTHROPIC_API_KEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")

    url = f"{config.ORCHESTRATOR_URL.rstrip('/')}/v1/chat/completions"
    meta = {
        "scope_label": bundle.label,
        "estimated_tokens": bundle.estimated_tokens,
        "upstream": "anthropic" if use_claude else "orchestrator",
    }

    return StreamingResponse(
        _stream_orchestrator(url, body, meta, use_claude=use_claude),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _build_rewrite_payload(slug: str, req: RewriteRequest) -> dict[str, Any]:
    project_root = paths.project_root(slug)
    project = load_project(project_root)
    parts: list[str] = [
        f"You are scribe, a writing assistant rewriting a passage from "
        f"\"{project.title}\". Match the existing voice exactly: same tense, "
        f"same point of view, same register and rhythm. Preserve all proper "
        f"nouns. Keep paragraph structure unless the instruction asks "
        f"otherwise. Reply with ONLY the rewritten passage. No preamble. No "
        f"markdown fences. No explanation.",
    ]
    if req.include_codex:
        from ..chat.context import _build_codex

        codex = _build_codex(project_root)
        if codex:
            parts.append("")
            parts.append("---")
            parts.append("# Codex (for reference only — do not echo)")
            parts.append("")
            parts.append(codex)
    system_msg = "\n".join(parts)

    user_parts: list[str] = []
    if req.before_context.strip():
        user_parts.append("Context (before the passage):")
        user_parts.append(req.before_context.strip())
        user_parts.append("")
    user_parts.append("Passage to rewrite:")
    user_parts.append(req.selection)
    user_parts.append("")
    if req.after_context.strip():
        user_parts.append("Context (after the passage):")
        user_parts.append(req.after_context.strip())
        user_parts.append("")
    user_parts.append(f"Instruction: {req.instruction.strip()}")
    user_msg = "\n".join(user_parts)

    body: dict[str, Any] = {
        "model": req.model or project.default_model or "auto-router",
        "messages": [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        "stream": True,
    }
    if req.temperature is not None:
        body["temperature"] = req.temperature
    if req.max_tokens is not None:
        body["max_tokens"] = req.max_tokens
    return body


@router.post("/rewrite")
async def stream_rewrite(slug: str, req: RewriteRequest) -> StreamingResponse:
    """Stream a focused rewrite of a selected passage."""
    if not req.selection.strip():
        raise HTTPException(400, "selection is empty")
    if not req.instruction.strip():
        raise HTTPException(400, "instruction is empty")

    body = _build_rewrite_payload(slug, req)
    use_claude = is_claude_model(body.get("model"))
    if use_claude and not config.ANTHROPIC_API_KEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")
    url = f"{config.ORCHESTRATOR_URL.rstrip('/')}/v1/chat/completions"
    meta = {
        "selection_chars": len(req.selection),
        "context_chars": len(req.before_context) + len(req.after_context),
        "codex_included": req.include_codex,
        "upstream": "anthropic" if use_claude else "orchestrator",
    }

    return StreamingResponse(
        _stream_orchestrator(url, body, meta, use_claude=use_claude),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


class SummarizeRequest(BaseModel):
    path: str  # repo-relative file path, e.g. "chapters/01/01.md"
    model: str | None = None


class SummarizeResponse(BaseModel):
    summary: str


SUMMARY_SYSTEM_PROMPT = (
    "You are scribe, a writing assistant. Summarise the passage below in "
    "one or two short sentences for use as a planning outline. Capture the "
    "essential beats — who's there, what happens, the emotional or plot "
    "shift. Neutral, present tense. Do not quote prose verbatim. Do not "
    "open with 'In this scene' or 'The scene'. Reply with ONLY the "
    "summary text — no preamble, no markdown, no quotes."
)


@router.post("/summarize", response_model=SummarizeResponse)
async def summarize(slug: str, req: SummarizeRequest) -> SummarizeResponse:
    """One-shot, non-streaming summary of a scene/chapter file body."""
    abs_path = paths.resolve_in_project(slug, req.path)
    if not abs_path.is_file():
        raise HTTPException(404, f"File not found: {req.path}")
    text = abs_path.read_text(encoding="utf-8")
    _meta, body = fm.parse(text)
    if not body.strip():
        raise HTTPException(400, "Nothing to summarise — file body is empty")

    project = load_project(paths.project_root(slug))
    model = req.model or project.default_model or "auto-router"

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": body.strip()},
        ],
        "stream": False,
        "max_tokens": config.SUMMARIZE_MAX_TOKENS,
        "temperature": config.SUMMARIZE_TEMPERATURE,
    }

    use_claude = is_claude_model(model)
    if use_claude and not config.ANTHROPIC_API_KEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")

    if use_claude:
        try:
            summary = await complete_anthropic(payload)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Anthropic unreachable: {e}")
        except RuntimeError as e:
            raise HTTPException(502, str(e))
        return SummarizeResponse(summary=summary)

    url = f"{config.ORCHESTRATOR_URL.rstrip('/')}/v1/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=SUMMARIZE_TIMEOUT) as client:
            r = await client.post(url, json=payload)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"orchestrator unreachable: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text[:500])
    data = r.json()
    try:
        summary = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(502, f"unexpected orchestrator response: {data!r}")
    return SummarizeResponse(summary=str(summary).strip())


class ModelEntry(BaseModel):
    id: str
    owned_by: str | None = None
    tags: list[str] = []


@models_router.get("/models", response_model=list[ModelEntry])
async def list_models() -> JSONResponse:
    """Proxy /v1/models and append synthetic Claude entries when configured."""
    url = f"{config.ORCHESTRATOR_URL.rstrip('/')}/v1/models"
    cleaned: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=MODELS_TIMEOUT) as client:
            r = await client.get(url)
            r.raise_for_status()
            payload = r.json()
    except httpx.HTTPError as e:
        log.warning("models proxy failed: %s", e)
        payload = None
    items = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            cleaned.append(
                {
                    "id": it.get("id") or "",
                    "owned_by": it.get("owned_by"),
                    "tags": it.get("tags") if isinstance(it.get("tags"), list) else [],
                }
            )
    cleaned = [c for c in cleaned if c["id"]]
    cleaned.extend(synthetic_models())
    return JSONResponse(cleaned)

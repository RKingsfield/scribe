"""Claude API escape hatch — translates Anthropic SSE to OpenAI-style chunks."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator

import httpx

from .. import config

log = logging.getLogger(__name__)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


def is_claude_model(model: str | None) -> bool:
    return bool(model) and str(model).startswith("claude")


def synthetic_models() -> list[dict[str, Any]]:
    """Return Claude entries to advertise iff a key is configured."""
    if not config.ANTHROPIC_API_KEY:
        return []
    return [dict(m) for m in config.CLAUDE_MODELS]


def convert_messages(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Split an OpenAI-style messages array into (system, messages).

    Anthropic's Messages API takes the system prompt as a top-level field
    rather than a message with role=system. Multiple system messages are
    joined with a blank line.
    """
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        if role == "system":
            if isinstance(content, str) and content:
                system_parts.append(content)
            continue
        if role not in ("user", "assistant"):
            continue
        out.append({"role": role, "content": content})
    return "\n\n".join(system_parts), out


def build_anthropic_body(openai_body: dict[str, Any]) -> dict[str, Any]:
    """Rewrite an OpenAI-style chat completion body into an Anthropic body."""
    system, messages = convert_messages(openai_body.get("messages", []))
    body: dict[str, Any] = {
        "model": openai_body["model"],
        "messages": messages,
        "max_tokens": int(openai_body.get("max_tokens") or 4096),
        "stream": True,
    }
    if system:
        body["system"] = system
    if "temperature" in openai_body and openai_body["temperature"] is not None:
        body["temperature"] = openai_body["temperature"]
    return body


def strip_think_blocks(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)


class ThinkBlockFilter:
    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        out = []
        while self._buf:
            if self._in_think:
                close = self._buf.find("</think>")
                if close == -1:
                    if len(self._buf) > 8 and "</think>"[:1] not in self._buf[-8:]:
                        self._buf = self._buf[-8:]
                    break
                self._buf = self._buf[close + 8:]
                self._in_think = False
            else:
                open_idx = self._buf.find("<think>")
                if open_idx == -1:
                    maybe = self._buf.rfind("<")
                    if maybe != -1 and "<think>".startswith(self._buf[maybe:]):
                        out.append(self._buf[:maybe])
                        self._buf = self._buf[maybe:]
                        break
                    out.append(self._buf)
                    self._buf = ""
                else:
                    out.append(self._buf[:open_idx])
                    self._buf = self._buf[open_idx + 7:]
                    self._in_think = True
        return "".join(out)


def _wrap_text_chunk(text: str) -> bytes:
    """Encode a text fragment as an OpenAI-style streaming chunk."""
    payload = {"choices": [{"delta": {"content": text}, "index": 0}]}
    return f"data: {json.dumps(payload)}\n\n".encode()


async def complete_anthropic(openai_body: dict[str, Any]) -> str:
    """Non-streaming Anthropic completion. Returns the concatenated text."""
    body = build_anthropic_body(openai_body)
    body["stream"] = False
    headers = {
        "x-api-key": config.ANTHROPIC_API_KEY or "",
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=config.LLM_STREAM_TIMEOUT) as client:
        r = await client.post(ANTHROPIC_URL, headers=headers, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:500]}")
    data = r.json()
    out = "".join(
        block.get("text", "")
        for block in data.get("content", [])
        if block.get("type") == "text"
    )
    return strip_think_blocks(out).strip()


async def stream_anthropic(openai_body: dict[str, Any]) -> AsyncIterator[bytes]:
    """Connect to api.anthropic.com and re-emit chunks in OpenAI SSE format.

    Yields raw SSE bytes ready to forward to the client. Surface upstream
    errors as ``event: error`` blocks (same shape as the orchestrator path).
    """
    if not config.ANTHROPIC_API_KEY:
        err = {"status": 503, "body": "ANTHROPIC_API_KEY not configured"}
        yield f"event: error\ndata: {json.dumps(err)}\n\n".encode()
        return

    body = build_anthropic_body(openai_body)
    think_filter = ThinkBlockFilter()
    headers = {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=config.LLM_STREAM_TIMEOUT) as client:
            async with client.stream("POST", ANTHROPIC_URL, json=body, headers=headers) as resp:
                if resp.status_code >= 400:
                    err_text = await resp.aread()
                    err = {
                        "status": resp.status_code,
                        "body": err_text.decode("utf-8", errors="replace")[:2000],
                    }
                    yield f"event: error\ndata: {json.dumps(err)}\n\n".encode()
                    return
                event_name = ""
                async for raw in resp.aiter_lines():
                    line = raw.rstrip("\r")
                    if not line:
                        event_name = ""
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].lstrip()
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    ev_type = parsed.get("type") or event_name
                    if ev_type == "content_block_delta":
                        delta = parsed.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            text = delta.get("text") or ""
                            if text:
                                filtered = think_filter.feed(text)
                                if filtered:
                                    yield _wrap_text_chunk(filtered)
                    elif ev_type == "message_stop":
                        yield b"data: [DONE]\n\n"
                        return
                    elif ev_type == "error":
                        err = parsed.get("error") or parsed
                        msg = err.get("message") if isinstance(err, dict) else str(err)
                        out = {"status": 502, "body": str(msg or "anthropic stream error")}
                        yield f"event: error\ndata: {json.dumps(out)}\n\n".encode()
                        return
                # stream ended without explicit message_stop — terminate cleanly
                yield b"data: [DONE]\n\n"
    except httpx.HTTPError as e:
        log.exception("anthropic stream failed")
        err = {"status": 502, "body": f"anthropic unreachable: {e}"}
        yield f"event: error\ndata: {json.dumps(err)}\n\n".encode()

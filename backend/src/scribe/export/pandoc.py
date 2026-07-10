from __future__ import annotations

import asyncio
import logging
import re
import shutil

from fastapi import HTTPException

log = logging.getLogger(__name__)


def safe_filename(slug: str, fmt: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]", "-", slug).strip("-") or "manuscript"
    return f"{base}.{fmt}"


async def pandoc(markdown: str, target: str, *, title: str, author: str | None) -> bytes:
    if shutil.which("pandoc") is None:
        raise HTTPException(
            503,
            "pandoc is not available in this environment. Pandoc is bundled in the production image; this looks like a dev backend without it installed.",
        )
    args = ["pandoc", "-f", "markdown", "-t", target, "--standalone"]
    args += ["--metadata", f"title={title}"]
    if author:
        args += ["--metadata", f"author={author}"]
    if target == "epub3":
        args += ["--toc", "--toc-depth=1"]
    elif target == "html5":
        args += ["--toc", "--toc-depth=2"]
    log.info("pandoc args: %s", args)
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(markdown.encode("utf-8"))
    if proc.returncode != 0:
        raise HTTPException(500, f"pandoc failed ({proc.returncode}): {err.decode('utf-8', errors='replace')[:1000]}")
    return out

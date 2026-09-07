"""Tiny internal HTTP endpoint for CLIP text embeddings (DESIGN §12.5), the one ML-over-HTTP exception."""
from __future__ import annotations

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .constants import CLIP_MODEL_TAG


async def health(_: Request) -> JSONResponse:
    from .models.clip import is_available
    return JSONResponse({"ok": True, "clip": is_available()})


async def embed_text(request: Request) -> JSONResponse:
    body = await request.json()
    text = (body or {}).get("text")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"title": "text required", "status": 400}, status_code=400)
    try:
        from .models.clip import clip
        vec = clip().embed_text([text.strip()])[0]
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"title": "clip unavailable", "status": 503, "detail": str(e)}, status_code=503)
    return JSONResponse({"embedding": [float(x) for x in vec], "model": CLIP_MODEL_TAG})


app = Starlette(routes=[Route("/health", health), Route("/embed-text", embed_text, methods=["POST"])])

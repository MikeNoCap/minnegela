"""Phase 0 helper: run faces + CLIP over a local folder and write an HTML contact sheet. No database."""
from __future__ import annotations

import base64
import html
import io
import logging
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .calibrate import STATS_MIN_N, robust_stats
from .models.clip import clip
from .models.faces import faces

log = logging.getLogger(__name__)
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


def analyze_folder(folder: str, out: str, limit: int = 500) -> None:
    paths = sorted(p for p in Path(folder).rglob("*") if p.suffix.lower() in EXTS)[:limit]
    c, f = clip(), faces()
    rows = []
    pending: list[tuple] = []
    for p in paths:
        try:
            im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
            im.thumbnail((1600, 1600))
        except Exception as e:  # noqa: BLE001
            log.warning("skip %s: %s", p, e)
            continue
        emb = c.embed_images([im])[0]
        dets = f.detect(im)
        thumb = im.copy()
        thumb.thumbnail((320, 320))
        buf = io.BytesIO()
        thumb.save(buf, "JPEG", quality=70)
        pending.append((p.name, base64.b64encode(buf.getvalue()).decode(), emb, dets))
    # calibrate against the folder itself when it is big enough (mirrors the per-group statistics)
    stats = robust_stats(c.raw_scores(np.stack([e for _, _, e, _ in pending]))) if len(pending) >= STATS_MIN_N else None
    for name, b64, emb, dets in pending:
        tr = c.tag(emb, stats)
        rows.append((name, b64, tr.tags, dets, tr.utility))
        log.info("%s: %d faces, %s", name, len(dets), tr.tags[0]["tag"] if tr.tags else "-")
    parts = ["<!doctype html><meta charset=utf-8><title>analyze-folder</title><style>body{font:13px sans-serif;display:grid;grid-template-columns:repeat(auto-fill,340px);gap:10px}figure{margin:0}img{max-width:320px}.u{opacity:.5}</style>"]
    for name, b64, tags, dets, util in rows:
        flags = "; ".join(f"{d.det_score:.2f} {','.join(d.quality_flags) or 'ok'}" for d in dets)
        parts.append(f"<figure class='{'u' if util else ''}'><img src='data:image/jpeg;base64,{b64}'><figcaption><b>{html.escape(name)}</b><br>"
                     f"{html.escape(', '.join(f'{t['tag']} {t['score']:.2f}' for t in tags))}<br>faces: {len(dets)} {html.escape(flags)}</figcaption></figure>")
    Path(out).write_text("".join(parts), encoding="utf-8")
    log.info("wrote %s (%d images)", out, len(rows))

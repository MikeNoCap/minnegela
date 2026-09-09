"""`retag` job: recompute the group's tag statistics and rewrite `blobs.tags` / `is_utility` from the
stored CLIP embeddings (DESIGN §6.3). No image pass: only the text tower and a matrix product, so a
whole library re-tags in seconds. Never touches faces, so it is safe to run as often as needed.

Debounced per group (dedupe key) from analyze; the job exits early when the statistics are fresh
unless `force` is set (CLI, vocabulary bump)."""
from __future__ import annotations

import json
import logging

import numpy as np

from .. import db, queue, tagstats
from ..calibrate import STATS_MIN_N, tag_result
from ..db import vec
from ..models.clip import clip
from ..vocab import VOCAB_VERSION

log = logging.getLogger(__name__)

STALE_FRACTION = 0.10   # recompute when the library grew/shrank by more than this since the last stats
BATCH = 500

# Mirror of apps/media-worker/src/metadata.ts looksLikeScreenshot, so a retag never clears a
# metadata-detected screenshot flag.
PHONE_SCREENS = {
    "1080x1920", "1080x2340", "1080x2400", "1170x2532", "1179x2556", "1206x2622", "1242x2688", "1284x2778", "1290x2796",
    "1320x2868", "750x1334", "828x1792", "1125x2436", "1440x3120", "1440x3200", "1440x2560", "1080x2280", "1080x2220",
    "720x1280", "1536x2048", "2048x2732", "1668x2388", "1640x2360", "1920x1080", "2560x1440", "3840x2160", "2880x1800",
    "3024x1964", "3456x2234", "1366x768", "1280x800",
}


def metadata_utility(row: dict) -> bool:
    if row.get("duration_ms") is not None:
        return False
    no_camera = not row.get("camera_make") and not row.get("camera_model")
    if (row.get("mime") or "") == "image/png" and no_camera:
        return True
    w, h = row.get("width"), row.get("height")
    if no_camera and w and h and (f"{w}x{h}" in PHONE_SCREENS or f"{h}x{w}" in PHONE_SCREENS):
        return True
    sw = (row.get("exif") or {}).get("Software") if isinstance(row.get("exif"), dict) else None
    return isinstance(sw, str) and any(k in sw.lower() for k in ("screenshot", "snipping", "screen capture"))


def run_retag(payload: dict) -> dict:
    group_id = payload["groupId"]
    force = bool(payload.get("force"))
    c = clip()
    with db.connect() as conn, conn.transaction():
        n_blobs = conn.execute("select count(*) as n from blobs where group_id = %s and clip_emb is not null", (group_id,)).fetchone()["n"]
        if n_blobs < STATS_MIN_N:
            return {"skipped": f"only {n_blobs} analysed blobs (< {STATS_MIN_N})"}
        old = tagstats.load(conn, group_id)
        if not force and old is not None and abs(n_blobs - old.n) <= STALE_FRACTION * old.n:
            return {"skipped": "stats fresh", "n": old.n}
        stats = tagstats.compute(conn, group_id, c.vocab_embs)
        if stats is None:
            return {"skipped": "no embeddings"}
        tagstats.save(conn, group_id, stats)

        rewritten = utility_changed = 0
        last = None
        while True:
            rows = conn.execute(
                "select id, clip_emb, is_utility, quality, mime, width, height, duration_ms, camera_make, camera_model, exif from blobs "
                "where group_id = %s and clip_emb is not null and (%s::uuid is null or id > %s::uuid) order by id limit %s",
                (group_id, last, last, BATCH),
            ).fetchall()
            if not rows:
                break
            embs = np.stack([vec(r["clip_emb"]) for r in rows])
            raw = c.raw_scores(embs)
            updates = []
            for r, rr in zip(rows, raw):
                res = tag_result(rr, stats)
                utility = res.utility or metadata_utility(r)
                q = dict(r["quality"] or {})
                q["aesthetic"] = res.aesthetic
                if utility != bool(r["is_utility"]):
                    utility_changed += 1
                updates.append((json.dumps(res.tags), json.dumps(q), utility, r["id"]))
            conn.cursor().executemany("update blobs set tags = %s::jsonb, quality = %s::jsonb, is_utility = %s where id = %s", updates)
            rewritten += len(rows)
            last = rows[-1]["id"]

        queue.enqueue(conn, "titles", {"groupId": group_id}, run_after_seconds=5)
        # moment labels and (if utility flags moved) event membership depend on tags: one full pass
        queue.enqueue(conn, "recluster", {"groupId": group_id, "full": True}, run_after_seconds=30)
    log.info("retag %s: %d blobs, %d utility flags changed, stats n=%d v%d", group_id, rewritten, utility_changed, stats.n, VOCAB_VERSION)
    return {"rewritten": rewritten, "utilityChanged": utility_changed, "n": stats.n, "vocabVersion": VOCAB_VERSION}

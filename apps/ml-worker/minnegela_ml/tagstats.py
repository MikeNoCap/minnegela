"""Per-group tag statistics (ml.tag_stats): load/save/compute, plus a small in-process cache so the
analyze batch does not hit the table for every blob."""
from __future__ import annotations

import threading
import time

import numpy as np

from .calibrate import TagStats, robust_stats
from .db import vec
from .vocab import KEYS, VOCAB_VERSION

_CACHE_TTL = 600.0
_cache: dict[str, tuple[float, TagStats | None]] = {}
_lock = threading.Lock()


def load(conn, group_id: str) -> TagStats | None:
    rows = conn.execute(
        "select tag, center, scale, n from ml.tag_stats where group_id = %s and vocab_version = %s",
        (group_id, VOCAB_VERSION),
    ).fetchall()
    by = {r["tag"]: r for r in rows}
    if any(k not in by for k in KEYS):
        return None
    center = np.asarray([by[k]["center"] for k in KEYS], dtype=np.float32)
    scale = np.asarray([by[k]["scale"] for k in KEYS], dtype=np.float32)
    return TagStats(center=center, scale=scale, n=int(by[KEYS[0]]["n"]), version=VOCAB_VERSION)


def save(conn, group_id: str, stats: TagStats) -> None:
    conn.execute("delete from ml.tag_stats where group_id = %s and vocab_version = %s", (group_id, VOCAB_VERSION))
    conn.cursor().executemany(
        "insert into ml.tag_stats (group_id, vocab_version, tag, center, scale, n) values (%s, %s, %s, %s, %s, %s)",
        [(group_id, VOCAB_VERSION, k, float(stats.center[i]), float(stats.scale[i]), stats.n) for i, k in enumerate(KEYS)],
    )
    with _lock:
        _cache[group_id] = (time.monotonic(), stats)


def compute(conn, group_id: str, text_embs: np.ndarray) -> TagStats | None:
    """Robust per-tag statistics over every analysed blob of the group. None when the group is too small."""
    embs = [vec(r["clip_emb"]) for r in conn.execute("select clip_emb from blobs where group_id = %s and clip_emb is not null", (group_id,))]
    if not embs:
        return None
    raw = np.stack(embs) @ text_embs.T
    return robust_stats(raw)


def cached(conn, group_id: str) -> TagStats | None:
    with _lock:
        hit = _cache.get(group_id)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL:
            return hit[1]
    stats = load(conn, group_id)
    with _lock:
        _cache[group_id] = (time.monotonic(), stats)
    return stats


def invalidate(group_id: str | None = None) -> None:
    with _lock:
        if group_id is None:
            _cache.clear()
        else:
            _cache.pop(group_id, None)

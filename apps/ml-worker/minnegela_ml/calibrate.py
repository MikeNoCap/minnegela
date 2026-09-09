"""Calibrated zero-shot tags (DESIGN §6.3).

Raw CLIP cosine is not comparable across prompts: "a screenshot" or "a meme" sit at ~0.21 on *every*
image while "frisbee golf" peaks at ~0.28 only when there is one, so raw top-k is dominated by a handful
of attractor prompts. Fix: per-tag robust z-scores over the group's own library.

    z_k = (cos(img, T_k) - median_k) / (1.4826 * MAD_k)

median/MAD are taken over every analysed blob in the group (ml.tag_stats, recomputed by the `retag`
job). A robust centre matters: a tag that is genuinely common in one library (30 % of the photos in the
same studio) keeps its centre in the "absent" mode, so the present mode still scores high.

`score` is a squashed z in [0, 1] so the thresholds in packages/shared (TAGS.present = 0.6) read like
probabilities: z 2.25 -> 0.5, z 2.5 -> 0.6, z 3 -> 0.77, z 3.6 -> 0.9. Checked on the first real library:
at z 2-2.5 'frisbee golf' still fires on plain forest paths, at z >= 2.5 the hits are real; utility tags were
all correct from z 2.5 up. With ~200 tags per-image tags stay a little noisy by design; consumers vote
across an event (coverage >= 0.4) before trusting a tag.

Before a group has enough blobs for statistics (STATS_MIN_N), each image is normalised across tags
instead; weaker, but it already removes the per-image bias.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .vocab import CAMERA_ANCHOR, CAT_OF, INDEX, KEYS, TAG_PRESENT, TAGS_TOP, UTILITY_KEYS, UTILITY_SCORE, VOCAB_VERSION

STATS_MIN_N = 40        # blobs needed before per-tag statistics are trusted
SCALE_FLOOR = 0.008     # cosine units; keeps a constant-ish prompt from exploding
Z_MID, Z_SLOPE = 2.25, 1.6
TAGS_MAX = 16


@dataclass
class TagStats:
    center: np.ndarray    # (n_keys,) median raw cosine per tag
    scale: np.ndarray     # (n_keys,) robust std per tag
    n: int
    version: int = VOCAB_VERSION

    def usable(self) -> bool:
        return self.version == VOCAB_VERSION and self.n >= STATS_MIN_N and self.center.shape == (len(KEYS),)


@dataclass
class TagResult:
    tags: list[dict]      # [{tag, cat, score, z}], best first
    utility: bool
    aesthetic: float      # cos('beautiful photo') - cos('accidental photo')


def robust_stats(raw: np.ndarray) -> TagStats:
    """raw: (n_images, n_keys) cosine matrix."""
    med = np.median(raw, axis=0)
    mad = np.median(np.abs(raw - med), axis=0) * 1.4826
    return TagStats(center=med.astype(np.float32), scale=np.maximum(mad, SCALE_FLOOR).astype(np.float32), n=int(raw.shape[0]))


def zscores(raw: np.ndarray, stats: TagStats | None) -> np.ndarray:
    """raw: (n_keys,) or (n, n_keys)."""
    if stats is not None and stats.usable():
        return (raw - stats.center) / stats.scale
    # fallback: per-image normalisation across the vocabulary
    mu = raw.mean(axis=-1, keepdims=True)
    sd = np.maximum(raw.std(axis=-1, keepdims=True), SCALE_FLOOR)
    return (raw - mu) / sd


def score_from_z(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-Z_SLOPE * (z - Z_MID)))


_I_CAMERA = INDEX[CAMERA_ANCHOR]
_I_GOOD = INDEX["beautiful photo"]
_I_BAD = INDEX["accidental photo"]
_UTIL_IDX = np.asarray([INDEX[k] for k in UTILITY_KEYS])
_SURFACED = np.asarray([CAT_OF[k] != "quality" for k in KEYS])


def tag_result(raw: np.ndarray, stats: TagStats | None) -> TagResult:
    """One image (or the mean embedding of a video): raw (n_keys,) cosines -> stored tags + flags."""
    z = zscores(raw, stats)
    score = score_from_z(z)
    order = np.argsort(-score)
    tags: list[dict] = []
    for i in order:
        i = int(i)
        if not _SURFACED[i]:
            continue
        if len(tags) >= TAGS_TOP and score[i] < TAG_PRESENT:
            break
        if len(tags) >= TAGS_MAX:
            break
        tags.append({"tag": KEYS[i], "cat": CAT_OF[KEYS[i]], "score": round(float(score[i]), 4), "z": round(float(z[i]), 2)})
    best_u = int(_UTIL_IDX[np.argmax(score[_UTIL_IDX])])
    utility = bool(score[best_u] >= UTILITY_SCORE and raw[best_u] >= raw[_I_CAMERA])
    return TagResult(tags=tags, utility=utility, aesthetic=round(float(raw[_I_GOOD] - raw[_I_BAD]), 4))


def is_utility(tags: list[dict]) -> bool:
    """Stored-tags view of the utility rule (no raw anchor available): used by the spike sheet only."""
    return any(t.get("cat") == "utility" and t["score"] >= UTILITY_SCORE for t in tags)

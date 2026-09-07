"""Pure identity-matching logic (DESIGN §5.3-5.4), separated from the DB so it is unit-testable."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .constants import FACE_MATCH

TIER_RANK = {"confirmed": 3, "high": 2, "probable": 1, "low": 0}


def compute_prototypes(embs: np.ndarray, seed: int = 0) -> np.ndarray:
    """k-means centroids (k = min(12, ceil(n/8))) over confirmed face embeddings, re-normalized."""
    n = embs.shape[0]
    if n == 0:
        return np.zeros((0, embs.shape[1] if embs.ndim == 2 else 512), dtype=np.float32)
    k = max(1, min(FACE_MATCH["prototypes_max"], math.ceil(n / FACE_MATCH["prototypes_per_faces"])))
    if k == 1 or n <= k:
        cents = embs.mean(axis=0, keepdims=True) if k == 1 else embs.copy()
    else:
        from sklearn.cluster import KMeans
        km = KMeans(n_clusters=k, n_init=4, random_state=seed).fit(embs)
        cents = km.cluster_centers_
    cents = cents / np.clip(np.linalg.norm(cents, axis=1, keepdims=True), 1e-9, None)
    return cents.astype(np.float32)


@dataclass
class Candidate:
    person_id: int | None
    score: float
    margin: float
    tier: str | None       # high | probable | low | None


def cap_tier(tier: str | None, quality_flags: list[str] | tuple[str, ...]) -> str | None:
    """Quality flags lower the maximum tier a face can receive (§5.4)."""
    if tier is None:
        return None
    if "too_small" in quality_flags:
        return "low"
    if "profile" in quality_flags or "low_quality" in quality_flags or "low_confidence" in quality_flags:
        return "probable" if TIER_RANK[tier] > TIER_RANK["probable"] else tier
    return tier


def match_face(emb: np.ndarray, prototypes: dict[int, np.ndarray], *, rejected: set[int] = frozenset(),
               context_persons: set[int] = frozenset(), quality_flags: list[str] | tuple[str, ...] = ()) -> Candidate:
    """Max-over-prototypes cosine per person, top-2 margin rule, context boost, quality caps."""
    fm = FACE_MATCH
    scores: list[tuple[float, int]] = []
    for pid, protos in prototypes.items():
        if pid in rejected or protos.shape[0] == 0:
            continue
        s = float((protos @ emb).max())
        scores.append((s, pid))
    if not scores:
        return Candidate(None, 0.0, 0.0, None)
    scores.sort(reverse=True)
    best_s, best = scores[0]
    second_s = scores[1][0] if len(scores) > 1 else 0.0
    margin = best_s - second_s
    boost = fm["context_boost"] if best in context_persons else 0.0
    tier: str | None
    if best_s >= fm["high"]["score"] - boost and margin >= fm["high"]["margin"]:
        tier = "high"
    elif best_s >= fm["probable"]["score"] - boost and margin >= fm["probable"]["margin"]:
        tier = "probable"
    elif best_s >= fm["low"]["score"] - boost:
        tier = "low"
    else:
        tier = None
    tier = cap_tier(tier, quality_flags)
    return Candidate(best if tier else None, best_s, margin, tier)


def cluster_unknown(embs: np.ndarray, min_size: int | None = None) -> list[list[int]]:
    """Agglomerative clustering (average linkage, cosine distance threshold) over unassigned faces.
    Returns index lists for clusters with ≥ min_size members."""
    n = embs.shape[0]
    min_size = min_size or FACE_MATCH["unknown_cluster_min_faces"]
    if n < min_size:
        return []
    from sklearn.cluster import AgglomerativeClustering
    ac = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average",
                                 distance_threshold=FACE_MATCH["unknown_cluster_distance"]).fit(embs)
    groups: dict[int, list[int]] = {}
    for i, lb in enumerate(ac.labels_):
        groups.setdefault(int(lb), []).append(i)
    return [g for g in groups.values() if len(g) >= min_size]

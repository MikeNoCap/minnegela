"""Thresholds mirrored from packages/shared/src/constants.ts. Keep the two files in sync; the
TypeScript file is canonical and the spike tunes numbers there first."""

FACE_MATCH = {
    "high": {"score": 0.62, "margin": 0.10},
    "probable": {"score": 0.50, "margin": 0.06},
    "low": {"score": 0.42},
    "context_boost": 0.05,
    "context_boost_min_confirmed": 3,
    "min_face_px": 32,
    "min_det_score": 0.6,
    "max_yaw_deg": 60,
    "unknown_cluster_distance": 0.45,
    "unknown_cluster_min_faces": 4,
    "prototypes_max": 12,
    "prototypes_per_faces": 8,
    "blur_threshold": 60.0,  # Laplacian variance on the 112 px crop; calibrated in the spike
}

WBS = {
    "window": 8,
    "tau_min": 20.0,
    "tau_max": 120.0,
    "tau_median_multiplier": 4.0,
    "hard_gap_minutes": 240.0,
    "dist_scale_m": 800.0,
    "same_place_m": 300.0,
    "travel_max_kmh": 90.0,
    "travel_max_minutes": 30.0,
    "weights": {"gap": 0.45, "dist": 0.20, "people": 0.15, "visual": 0.10, "contrib": 0.10},
    "cut_threshold": 0.5,
    "adjacent_merge_band": (0.5, 0.6),
    "min_event_assets": 3,
    "min_event_minutes": 10.0,
    "max_event_hours": 18.0,
    "concurrent": {"min_gps_assets": 6, "eps_m": 500.0, "min_samples": 3, "min_span_minutes": 30.0},
    "moments": {"tau_minutes": 20.0, "eps_m": 150.0, "threshold": 0.5, "tag_coverage": 0.4, "tag_score": 0.6},
    "membership_weights": {"interior": 0.35, "geo": 0.25, "people": 0.20, "visual": 0.10, "support": 0.10},
    "tiers": {"confirmed": 0.85, "probable": 0.6},
    "event_confident_copy": 0.75,
    "recluster_debounce_seconds": 60,
    "recluster_pad_hours": 6,
    "id_reuse_jaccard": 0.5,
    "algo_version": 1,
}

# Tag calibration (§6.3). The vocabulary itself lives in vocab.py; these mirror TAGS in shared/constants.ts.
TAGS = {"present": 0.6, "top": 8, "utility": 0.6, "vocab_version": 3}

CLIP_MODEL = "ViT-B-16"
CLIP_PRETRAINED = "laion2b_s34b_b88k"
CLIP_MODEL_TAG = "openclip:ViT-B-16/laion2b_s34b_b88k"
FACE_MODEL_TAG = "insightface:buffalo_l"


def storage_key_face_crop(group_id: str, face_id: str) -> str:
    return f"groups/{group_id}/face/{face_id}.jpg"

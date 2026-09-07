"""InsightFace SCRFD detector + ArcFace embeddings (buffalo_l), quality gating (DESIGN §5.1-5.2)."""
from __future__ import annotations

import io
import logging
import math
import threading
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from ..config import settings
from ..constants import FACE_MATCH, FACE_MODEL_TAG
from . import ModelUnavailable

log = logging.getLogger(__name__)
_lock = threading.Lock()
_instance: "Faces | None" = None


@dataclass
class DetectedFace:
    box: dict            # {x, y, w, h} in input pixels
    landmarks: list       # 5 x [x, y]
    det_score: float
    emb: np.ndarray       # 512-d, L2-normalized
    quality_flags: list[str] = field(default_factory=list)
    crop_jpeg: bytes | None = None


def yaw_from_landmarks(lm: np.ndarray) -> float:
    """Rough yaw in degrees from the 5-point layout: nose position between the eyes.
    0 = frontal, ±90 = full profile. Sign is irrelevant for gating."""
    le, re, nose = lm[0], lm[1], lm[2]
    eye_dist = max(float(np.linalg.norm(re - le)), 1e-6)
    mid = (le + re) / 2
    # projection of nose offset onto the eye axis, normalized by eye distance
    axis = (re - le) / eye_dist
    off = float(np.dot(nose - mid, axis)) / eye_dist
    return float(np.clip(off * 2.0, -1, 1)) * 90.0


def laplacian_variance(gray: np.ndarray) -> float:
    g = gray.astype(np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var()) if lap.size else 0.0


def quality_flags(box_w: float, box_h: float, det_score: float, landmarks: np.ndarray, crop_gray: np.ndarray | None) -> list[str]:
    flags: list[str] = []
    if min(box_w, box_h) < FACE_MATCH["min_face_px"]:
        flags.append("too_small")
    if det_score < FACE_MATCH["min_det_score"]:
        flags.append("low_confidence")
    if abs(yaw_from_landmarks(np.asarray(landmarks, dtype=np.float32))) > FACE_MATCH["max_yaw_deg"]:
        flags.append("profile")
    if crop_gray is not None and laplacian_variance(crop_gray) < FACE_MATCH["blur_threshold"]:
        flags.append("low_quality")
    return flags


class Faces:
    model_tag = FACE_MODEL_TAG

    def __init__(self) -> None:
        try:
            from insightface.app import FaceAnalysis
        except ImportError as e:  # pragma: no cover
            raise ModelUnavailable("insightface/onnxruntime not installed; run `uv sync --extra ml`") from e
        use_gpu = settings.ml_device == "cuda"
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
        self.app = FaceAnalysis(name="buffalo_l", root=settings.model_dir, providers=providers, allowed_modules=["detection", "recognition"])
        self.app.prepare(ctx_id=0 if use_gpu else -1, det_size=(settings.ml_face_det_size, settings.ml_face_det_size))

    def detect(self, image: Image.Image, crop_px: int = 160) -> list[DetectedFace]:
        rgb = image.convert("RGB")
        arr = np.asarray(rgb)[:, :, ::-1]  # BGR for insightface
        found = self.app.get(arr)
        out: list[DetectedFace] = []
        for f in found:
            x1, y1, x2, y2 = [float(v) for v in f.bbox]
            w, h = x2 - x1, y2 - y1
            lm = np.asarray(f.kps, dtype=np.float32)
            emb = np.asarray(f.normed_embedding, dtype=np.float32)
            # crop with 20 % margin for the UI and for blur measurement
            m = 0.2
            cx1, cy1 = max(0, int(x1 - w * m)), max(0, int(y1 - h * m))
            cx2, cy2 = min(rgb.width, int(x2 + w * m)), min(rgb.height, int(y2 + h * m))
            crop = rgb.crop((cx1, cy1, cx2, cy2))
            gray = np.asarray(crop.convert("L").resize((112, 112)))
            flags = quality_flags(w, h, float(f.det_score), lm, gray)
            crop.thumbnail((crop_px, crop_px))
            buf = io.BytesIO()
            crop.save(buf, "JPEG", quality=85)
            out.append(DetectedFace(
                box={"x": round(x1, 1), "y": round(y1, 1), "w": round(w, 1), "h": round(h, 1)},
                landmarks=[[round(float(a), 1), round(float(b), 1)] for a, b in lm],
                det_score=float(f.det_score), emb=emb, quality_flags=flags, crop_jpeg=buf.getvalue(),
            ))
        return out


def faces() -> Faces:
    global _instance
    with _lock:
        if _instance is None:
            _instance = Faces()
        return _instance

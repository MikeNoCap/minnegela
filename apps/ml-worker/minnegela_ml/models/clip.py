"""OpenCLIP ViT-B/16 (laion2b_s34b_b88k), fp32 (DESIGN §6). Lazy-loaded; one instance per process."""
from __future__ import annotations

import logging
import threading
from typing import Sequence

import numpy as np
from PIL import Image

from ..config import settings
from ..constants import CLIP_MODEL, CLIP_MODEL_TAG, CLIP_PRETRAINED, UTILITY_TAG_THRESHOLD, UTILITY_TAGS, ZERO_SHOT_PROMPTS
from . import ModelUnavailable

log = logging.getLogger(__name__)
_lock = threading.Lock()
_instance: "Clip | None" = None


def is_available() -> bool:
    try:
        import open_clip  # noqa: F401
        import torch  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


class Clip:
    model_tag = CLIP_MODEL_TAG

    def __init__(self) -> None:
        try:
            import open_clip
            import torch
        except ImportError as e:  # pragma: no cover - exercised on the GPU box
            raise ModelUnavailable("open_clip/torch not installed; run `uv sync --extra ml` (GPU) or `--extra ml-cpu`") from e
        self.torch = torch
        self.device = "cuda" if settings.ml_device == "cuda" and torch.cuda.is_available() else "cpu"
        if settings.ml_device == "cuda" and self.device == "cpu":
            log.warning("ML_DEVICE=cuda but no CUDA device visible; falling back to CPU")
        model, _, preprocess = open_clip.create_model_and_transforms(CLIP_MODEL, pretrained=CLIP_PRETRAINED, cache_dir=settings.model_dir, device=self.device, precision="fp32")
        self.model = model.eval()
        self.preprocess = preprocess
        self.tokenizer = open_clip.get_tokenizer(CLIP_MODEL)
        self._prompt_embs = self.embed_text(list(ZERO_SHOT_PROMPTS))

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        return x / np.clip(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9, None)

    def embed_images(self, images: Sequence[Image.Image], batch_size: int = 32) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(images), batch_size):
                batch = self.torch.stack([self.preprocess(im.convert("RGB")) for im in images[i:i + batch_size]]).to(self.device)
                feats = self.model.encode_image(batch).float().cpu().numpy()
                out.append(feats)
        return self._norm(np.concatenate(out, axis=0)) if out else np.zeros((0, 512), dtype=np.float32)

    def embed_text(self, texts: Sequence[str]) -> np.ndarray:
        with self.torch.no_grad():
            toks = self.tokenizer(list(texts)).to(self.device)
            feats = self.model.encode_text(toks).float().cpu().numpy()
        return self._norm(feats)

    def zero_shot_tags(self, emb: np.ndarray, top: int = 5) -> list[dict]:
        """Cosine to each prompt; top-k as [{tag, score}]. No softmax: scores stay comparable across images."""
        return zero_shot_from_scores(emb @ self._prompt_embs.T, top)

    def quality_contrast(self, emb: np.ndarray) -> float:
        """cos('a beautiful photo') - cos('a blurry accidental photo'), for highlight selection (§6.4)."""
        i_good = ZERO_SHOT_PROMPTS.index("a beautiful photo")
        i_bad = ZERO_SHOT_PROMPTS.index("a blurry accidental photo")
        s = emb @ self._prompt_embs.T
        return float(s[i_good] - s[i_bad])


def zero_shot_from_scores(scores: np.ndarray, top: int = 5) -> list[dict]:
    idx = np.argsort(-scores)[:top]
    return [{"tag": ZERO_SHOT_PROMPTS[int(i)], "score": round(float(scores[int(i)]), 4)} for i in idx]


def is_utility(tags: list[dict]) -> bool:
    return any(t["tag"] in UTILITY_TAGS and t["score"] >= UTILITY_TAG_THRESHOLD for t in tags)


def clip() -> Clip:
    global _instance
    with _lock:
        if _instance is None:
            _instance = Clip()
        return _instance

"""OpenCLIP ViT-B/16 (laion2b_s34b_b88k), fp32 (DESIGN §6). Lazy-loaded; one instance per process.

Tags: raw cosine against the ensembled vocabulary prompts (vocab.py), calibrated per group by
calibrate.py. The text tower runs once per process for the vocabulary and on demand for search."""
from __future__ import annotations

import logging
import threading
from typing import Sequence

import numpy as np
from PIL import Image

from ..calibrate import TagResult, TagStats, tag_result
from ..config import settings
from ..constants import CLIP_MODEL, CLIP_MODEL_TAG, CLIP_PRETRAINED
from ..vocab import VOCAB
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
        self.vocab_embs = self._embed_vocab()

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        return x / np.clip(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9, None)

    def _embed_vocab(self) -> np.ndarray:
        """(n_keys, 512): each key is the normalised mean of its prompt embeddings (prompt ensembling)."""
        prompts = [p for t in VOCAB for p in t.prompts]
        flat = self.embed_text(prompts)
        out, i = [], 0
        for t in VOCAB:
            out.append(flat[i:i + len(t.prompts)].mean(axis=0))
            i += len(t.prompts)
        return self._norm(np.stack(out)).astype(np.float32)

    def embed_images(self, images: Sequence[Image.Image], batch_size: int = 32) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(images), batch_size):
                batch = self.torch.stack([self.preprocess(im.convert("RGB")) for im in images[i:i + batch_size]]).to(self.device)
                feats = self.model.encode_image(batch).float().cpu().numpy()
                out.append(feats)
        return self._norm(np.concatenate(out, axis=0)) if out else np.zeros((0, 512), dtype=np.float32)

    def embed_text(self, texts: Sequence[str], batch_size: int = 256) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(texts), batch_size):
                toks = self.tokenizer(list(texts[i:i + batch_size])).to(self.device)
                out.append(self.model.encode_text(toks).float().cpu().numpy())
        return self._norm(np.concatenate(out, axis=0)) if out else np.zeros((0, 512), dtype=np.float32)

    def raw_scores(self, emb: np.ndarray) -> np.ndarray:
        """Cosine of one embedding (512,) or many (n, 512) against every vocabulary key."""
        return emb @ self.vocab_embs.T

    def tag(self, emb: np.ndarray, stats: TagStats | None) -> TagResult:
        return tag_result(self.raw_scores(emb), stats)


def clip() -> Clip:
    global _instance
    with _lock:
        if _instance is None:
            _instance = Clip()
        return _instance

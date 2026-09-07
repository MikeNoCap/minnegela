"""`analyze` job: faces + CLIP + tags + quality for one blob (DESIGN §13.2). Batched by the worker."""
from __future__ import annotations

import datetime as dt
import io
import json
import logging
import uuid

import numpy as np
from PIL import Image, ImageOps

from .. import db, queue
from ..constants import CLIP_MODEL_TAG, FACE_MODEL_TAG, WBS, storage_key_face_crop
from ..models import ModelUnavailable
from ..models.clip import is_utility, clip
from ..models.faces import faces, laplacian_variance
from ..storage import storage

log = logging.getLogger(__name__)


def _load_image(path) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def quality_metrics(im: Image.Image) -> dict:
    g = np.asarray(im.convert("L").resize((512, int(512 * im.height / max(im.width, 1)) or 1)), dtype=np.float32)
    sharp = laplacian_variance(g)
    hist = np.histogram(g, bins=16, range=(0, 255))[0] / g.size
    return {
        "sharpness": round(sharp, 2),
        "exposure": round(float(g.mean()) / 255.0, 4),
        "contrast": round(float(g.std()) / 255.0, 4),
        "clipped_dark": round(float(hist[0]), 4),
        "clipped_bright": round(float(hist[-1]), 4),
    }


def analyze_blob(conn, payload: dict) -> dict:
    blob_id, group_id = payload["blobId"], payload["groupId"]
    blob = conn.execute(
        "select id, group_id, preview_key, is_utility, captured_at, duration_ms, mime, analyzed_at from blobs where id = %s",
        (blob_id,),
    ).fetchone()
    if blob is None:
        return {"skipped": "blob missing"}
    if blob["analyzed_at"] is not None and not payload.get("force"):
        return {"skipped": "already analyzed"}   # §13.4: never re-run ML, it would churn face ids
    if not blob["preview_key"]:
        raise RuntimeError("blob has no preview yet (derive must run first)")

    st = storage()
    keys = [blob["preview_key"]]
    frame_index = [-1]
    if blob["duration_ms"] is not None:
        for r in conn.execute("select storage_key, frame_index from derivatives where blob_id = %s and kind = 'frame' order by frame_index", (blob_id,)):
            keys.append(r["storage_key"])
            frame_index.append(r["frame_index"])
    images = [_load_image(st.get(k)) for k in keys]

    c, f = clip(), faces()
    embs = c.embed_images(images)
    mean = embs.mean(axis=0)
    mean = mean / max(float(np.linalg.norm(mean)), 1e-9)
    tags = c.zero_shot_tags(mean)
    utility = bool(blob["is_utility"]) or is_utility(tags)
    q = quality_metrics(images[0])
    q["aesthetic"] = round(c.quality_contrast(mean), 4)

    n_faces = 0
    for im, fi in zip(images, frame_index):
        for det in f.detect(im):
            face_id = str(uuid.uuid4())
            crop_key = storage_key_face_crop(group_id, face_id)
            if det.crop_jpeg:
                st.put_bytes(crop_key, det.crop_jpeg, "image/jpeg")
            conn.execute(
                "insert into faces (id, group_id, blob_id, frame_index, box, landmarks, det_score, quality_flags, crop_key) "
                "values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)",
                (face_id, group_id, blob_id, fi, json.dumps(det.box), json.dumps(det.landmarks), det.det_score, det.quality_flags, crop_key),
            )
            conn.execute("insert into ml.face_embeddings (face_id, emb, model) values (%s, %s, %s)", (face_id, det.emb, FACE_MODEL_TAG))
            n_faces += 1

    conn.execute(
        "update blobs set clip_emb = %s, clip_model = %s, tags = %s::jsonb, quality = %s::jsonb, n_faces = %s, "
        "is_utility = %s, analyzed_at = now() where id = %s",
        (mean.astype(np.float32), CLIP_MODEL_TAG, json.dumps(tags), json.dumps(q), n_faces, utility, blob_id),
    )
    if n_faces:
        queue.enqueue(conn, "identify", {"groupId": group_id, "blobId": blob_id})
    if not utility and blob["captured_at"] is not None:
        pad = dt.timedelta(hours=WBS["recluster_pad_hours"])
        t = blob["captured_at"]
        queue.enqueue(conn, "recluster", {"groupId": group_id, "from": (t - pad).isoformat(), "to": (t + pad).isoformat()},
                      run_after_seconds=WBS["recluster_debounce_seconds"])
    return {"faces": n_faces, "utility": utility, "tags": tags[:3]}


def analyze_batch(jobs: list[queue.Job]) -> None:
    """Prefetch every preview, then run the models one blob at a time (GPU stays busy, R2 never idles it)."""
    keys: list[str] = []
    with db.connect() as conn:
        ids = [j.payload["blobId"] for j in jobs]
        for r in conn.execute("select preview_key from blobs where id = any(%s::uuid[]) and preview_key is not null", (ids,)):
            keys.append(r["preview_key"])
    try:
        storage().prefetch(keys)
    except Exception as e:  # noqa: BLE001
        log.warning("prefetch failed: %s", e)
    try:
        clip(); faces()
    except ModelUnavailable as e:
        log.error("models unavailable: %s", e)
        with db.connect() as conn, conn.transaction():
            for j in jobs:
                queue.fail(conn, j.id, e)
        return
    for j in jobs:
        try:
            with db.connect() as conn, conn.transaction():
                out = analyze_blob(conn, j.payload)
                queue.complete(conn, j.id)
            log.info("analyze %s: %s", j.payload["blobId"], out)
        except Exception as e:  # noqa: BLE001
            log.exception("analyze %s failed", j.payload.get("blobId"))
            with db.connect() as conn, conn.transaction():
                queue.fail(conn, j.id, e)

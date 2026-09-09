"""`analyze` job: faces + CLIP + tags + quality for one blob (DESIGN §13.2). Batched by the worker.

Each blob goes through two stages so the GPU never waits on the network:
  compute  - decode, CLIP, face detection; face crops start uploading on the storage pool
  finalize - wait for the crops, write faces/embeddings/blob, enqueue identify/recluster, complete
The batch loop computes blob N+1 while blob N's uploads drain, and decodes a few blobs ahead.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageOps

from .. import db, queue, tagstats
from ..constants import CLIP_MODEL_TAG, FACE_MODEL_TAG, WBS, storage_key_face_crop
from ..models import ModelUnavailable
from ..models.clip import clip
from ..models.faces import DetectedFace, faces, laplacian_variance
from ..storage import storage
from ..calibrate import TagStats

log = logging.getLogger(__name__)

DECODE_AHEAD = 3   # blobs decoded on a thread while the GPU works on earlier ones (≈ 8 MB per image)
RETAG_DEBOUNCE_S = 900      # per-group tag statistics refresh once a burst of analysis has settled
IDENTIFY_DEBOUNCE_S = 300   # group-wide identify (unknown-face clustering) after a burst of new faces


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


@dataclass
class BlobInputs:
    """What compute needs from the DB: resolved once per blob, before any model runs."""
    blob_id: str
    group_id: str
    keys: list[str]
    frame_index: list[int]
    is_utility: bool
    captured_at: dt.datetime | None
    skipped: str | None = None
    stats: "TagStats | None" = None    # group tag statistics, resolved with the inputs


@dataclass
class FoundFace:
    face_id: str
    frame_index: int
    det: DetectedFace
    crop_key: str
    upload: Future[None] | None


@dataclass
class Computed:
    inputs: BlobInputs
    mean: np.ndarray | None = None
    tags: list[dict] = field(default_factory=list)
    utility: bool = False
    quality: dict = field(default_factory=dict)
    found: list[FoundFace] = field(default_factory=list)

    @property
    def skipped(self) -> str | None:
        return self.inputs.skipped


def load_inputs(conn, payload: dict) -> BlobInputs:
    blob_id, group_id = payload["blobId"], payload["groupId"]
    blob = conn.execute(
        "select id, group_id, preview_key, is_utility, captured_at, duration_ms, mime, analyzed_at from blobs where id = %s",
        (blob_id,),
    ).fetchone()
    if blob is None:
        return BlobInputs(blob_id, group_id, [], [], False, None, skipped="blob missing")
    if blob["analyzed_at"] is not None and not payload.get("force"):
        return BlobInputs(blob_id, group_id, [], [], False, None, skipped="already analyzed")   # §13.4: never re-run ML, it would churn face ids
    if not blob["preview_key"]:
        raise RuntimeError("blob has no preview yet (derive must run first)")
    keys = [blob["preview_key"]]
    frame_index = [-1]
    if blob["duration_ms"] is not None:
        for r in conn.execute("select storage_key, frame_index from derivatives where blob_id = %s and kind = 'frame' order by frame_index", (blob_id,)):
            keys.append(r["storage_key"])
            frame_index.append(r["frame_index"])
    return BlobInputs(blob_id, group_id, keys, frame_index, bool(blob["is_utility"]), blob["captured_at"], stats=tagstats.cached(conn, group_id))


def load_images(inputs: BlobInputs) -> list[Image.Image]:
    st = storage()
    return [_load_image(st.get(k)) for k in inputs.keys]


def compute(inputs: BlobInputs, images: list[Image.Image] | None = None) -> Computed:
    """Models only; no DB writes. Face crops start uploading here and are awaited in finalize()."""
    out = Computed(inputs)
    if inputs.skipped:
        return out
    images = images if images is not None else load_images(inputs)
    c, f, st = clip(), faces(), storage()
    embs = c.embed_images(images)
    mean = embs.mean(axis=0)
    out.mean = mean / max(float(np.linalg.norm(mean)), 1e-9)
    tr = c.tag(out.mean, inputs.stats)
    out.tags = tr.tags
    out.utility = inputs.is_utility or tr.utility
    out.quality = quality_metrics(images[0])
    out.quality["aesthetic"] = tr.aesthetic
    for im, fi in zip(images, inputs.frame_index):
        for det in f.detect(im):
            face_id = str(uuid.uuid4())
            crop_key = storage_key_face_crop(inputs.group_id, face_id)
            upload = st.put_bytes_async(crop_key, det.crop_jpeg, "image/jpeg") if det.crop_jpeg else None
            out.found.append(FoundFace(face_id, fi, det, crop_key, upload))
    return out


def finalize(conn, c: Computed) -> dict:
    """Persist a computed blob inside the caller's transaction. Waits for crop uploads first so a
    failed upload fails the job before anything references the key."""
    if c.skipped:
        return {"skipped": c.skipped}
    inp = c.inputs
    for ff in c.found:
        if ff.upload is not None:
            ff.upload.result()
    for ff in c.found:
        det = ff.det
        conn.execute(
            "insert into faces (id, group_id, blob_id, frame_index, box, landmarks, det_score, quality_flags, crop_key) "
            "values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)",
            (ff.face_id, inp.group_id, inp.blob_id, ff.frame_index, json.dumps(det.box), json.dumps(det.landmarks), det.det_score, det.quality_flags, ff.crop_key),
        )
        conn.execute("insert into ml.face_embeddings (face_id, emb, model) values (%s, %s, %s)", (ff.face_id, det.emb, FACE_MODEL_TAG))
    n_faces = len(c.found)
    conn.execute(
        "update blobs set clip_emb = %s, clip_model = %s, tags = %s::jsonb, quality = %s::jsonb, n_faces = %s, "
        "is_utility = %s, analyzed_at = now() where id = %s",
        (c.mean.astype(np.float32), CLIP_MODEL_TAG, json.dumps(c.tags), json.dumps(c.quality), n_faces, c.utility, inp.blob_id),
    )
    if n_faces:
        queue.enqueue(conn, "identify", {"groupId": inp.group_id, "blobId": inp.blob_id})
        # group-wide pass (re-matching + unknown-face clustering) once the burst settles; dedupe key coalesces
        queue.enqueue(conn, "identify", {"groupId": inp.group_id}, run_after_seconds=IDENTIFY_DEBOUNCE_S)
    queue.enqueue(conn, "retag", {"groupId": inp.group_id}, run_after_seconds=RETAG_DEBOUNCE_S)
    if not c.utility and inp.captured_at is not None:
        pad = dt.timedelta(hours=WBS["recluster_pad_hours"])
        t = inp.captured_at
        queue.enqueue(conn, "recluster", {"groupId": inp.group_id, "from": (t - pad).isoformat(), "to": (t + pad).isoformat()},
                      run_after_seconds=WBS["recluster_debounce_seconds"])
    return {"faces": n_faces, "utility": c.utility, "tags": c.tags[:3]}


def analyze_blob(conn, payload: dict) -> dict:
    """Single-blob convenience (CLI, tests): compute then finalize on one connection."""
    return finalize(conn, compute(load_inputs(conn, payload)))


def _finish(job: queue.Job, c: Computed) -> None:
    try:
        with db.connect() as conn, conn.transaction():
            out = finalize(conn, c)
            queue.complete(conn, job.id)
        log.info("analyze %s: %s", c.inputs.blob_id, out)
    except Exception as e:  # noqa: BLE001
        log.exception("analyze %s failed", c.inputs.blob_id)
        with db.connect() as conn, conn.transaction():
            queue.fail(conn, job.id, e)


def _fail(job: queue.Job, e: Exception) -> None:
    log.exception("analyze %s failed", job.payload.get("blobId"))
    with db.connect() as conn, conn.transaction():
        queue.fail(conn, job.id, e)


def analyze_batch(jobs: list[queue.Job]) -> None:
    """Prefetch every preview, then pipeline: decode ahead on a thread, models on the GPU, and each
    blob's uploads + DB commit overlapped with the next blob's compute."""
    inputs: list[BlobInputs | Exception] = []
    with db.connect() as conn:
        for j in jobs:
            try:
                inputs.append(load_inputs(conn, j.payload))
            except Exception as e:  # noqa: BLE001
                inputs.append(e)
    try:
        storage().prefetch([k for i in inputs if isinstance(i, BlobInputs) for k in i.keys])
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

    decoded: dict[int, Future[list[Image.Image]]] = {}
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="decode") as dec:
        def decode_ahead(from_i: int) -> None:
            for k in range(from_i, min(from_i + DECODE_AHEAD, len(jobs))):
                inp = inputs[k]
                if k not in decoded and isinstance(inp, BlobInputs) and not inp.skipped:
                    decoded[k] = dec.submit(load_images, inp)

        pending: tuple[queue.Job, Computed] | None = None
        for i, (job, inp) in enumerate(zip(jobs, inputs)):
            decode_ahead(i)
            if isinstance(inp, Exception):
                _fail(job, inp)
                continue
            try:
                images = decoded.pop(i).result() if i in decoded else None
                c = compute(inp, images)
            except Exception as e:  # noqa: BLE001
                _fail(job, e)
                continue
            if pending is not None:
                _finish(*pending)       # previous blob's crops have been uploading while this one computed
            pending = (job, c)
        if pending is not None:
            _finish(*pending)

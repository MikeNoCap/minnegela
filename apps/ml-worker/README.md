# ml-worker

Python worker for everything neural (DESIGN §3.4): face detection and embeddings (InsightFace
SCRFD + ArcFace, `buffalo_l`), image and text embeddings (OpenCLIP ViT-B/16), identity matching,
unknown-face clustering, and event reconstruction with Windowed Boundary Segmentation (§9).

It consumes `analyze`, `identify` and `recluster` jobs from the shared Postgres `jobs` table
(same SKIP LOCKED contract as `packages/db/src/jobs.ts`) and exposes one tiny HTTP endpoint for
CLIP text embeddings that the API's semantic search calls.

## Layout

```
minnegela_ml/
  config.py      env (root .env is loaded in dev)
  db.py          psycopg pool, pgvector
  storage.py     S3 client + disk LRU cache + 16-way prefetch
  queue.py       claim / complete / fail / enqueue (debounced recluster)
  worker.py      loop: analyze in batches of ML_BATCH_SIZE, identify/recluster one at a time
  server.py      POST /embed-text, GET /health
  matching.py    prototypes, margin rule, quality caps, context boost, unknown clustering (pure)
  wbs.py         Windowed Boundary Segmentation (pure numpy, no DB)
  jobs/          analyze.py, identify.py, recluster.py (DB glue around the pure modules)
  models/        clip.py, faces.py (lazy; raise ModelUnavailable when deps/models are missing)
  constants.py   thresholds mirrored from packages/shared/src/constants.ts (that file is canonical)
  spike.py       `analyze-folder`: contact sheet for Phase 0 tuning, no DB
```

## Running

Development box (no GPU, models optional):

```sh
cd apps/ml-worker
uv sync                         # core deps only; enough for tests and for recluster/identify
uv run pytest -q                # WBS + matching unit tests, queue + recluster tests against Postgres
uv run minnegela-ml worker      # polls jobs; analyze jobs fail with "models unavailable" until ML deps exist
uv sync --extra ml-cpu          # CPU torch + insightface + onnxruntime, then ML_DEVICE=cpu works
uv run minnegela-ml check-models
```

GPU box (Pascal):

```sh
uv sync --extra ml              # torch 2.6 from the cu126 index, onnxruntime-gpu
ML_DEVICE=cuda uv run minnegela-ml worker
uv run minnegela-ml serve --port 4100        # text-embed endpoint for the API (ML_TEXT_EMBED_URL)
```

Or via compose (`infra/compose.yml`, service `ml-worker`, `devices: nvidia.com/gpu=all`).
Models download on first use into `MODEL_DIR` (`/models` volume in compose): InsightFace fetches
`buffalo_l` itself; OpenCLIP fetches `ViT-B-16/laion2b_s34b_b88k` from Hugging Face.

Manual runs:

```sh
uv run minnegela-ml recluster --group <uuid> --full
uv run minnegela-ml identify --group <uuid>
uv run minnegela-ml analyze-folder ~/Pictures/spike --out sheet.html   # Phase 0
```

## Environment

`DATABASE_URL_WORKER`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `WORKER_CACHE_DIR`, `WORKER_CACHE_GB`,
`ML_DEVICE` (`cuda`|`cpu`), `ML_BATCH_SIZE` (64), `MODEL_DIR`, `WORKER_ID`, `ML_SERVE_PORT` (4100).

## Thresholds

All numbers live in `minnegela_ml/constants.py`, a mirror of `packages/shared/src/constants.ts`.
Tune in the TypeScript file first (the spike's job, §24 Phase 0), then copy here.

## Notes

- `analyze` never re-runs on a blob with `analyzed_at` set (§13.4); pass `force: true` in the
  payload to override during the spike.
- Face embeddings are written only to `ml.face_embeddings`; the API role has no access to that schema.
- Prototypes exist only for non-member persons or members with `consent_faces_at` set.
- `recluster` applies `devices.clock_offset_s` when reading `blobs.captured_at`.

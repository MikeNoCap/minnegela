# @minnegela/media-worker

Node worker for the CPU-side media stages (docs/DESIGN.md §13.2). It consumes the Postgres `jobs` table with
`FOR UPDATE SKIP LOCKED` on the `minnegela_worker` role and talks to object storage through the S3 API.

| Job kind            | What it does |
|---------------------|--------------|
| `derive`            | Verify SHA-256 of an upload, merge exact duplicates, read EXIF (time rules of §8.2), make `preview1600` + `thumb320`, pHash, quality, screenshot/re-encode heuristics, move bytes to content-addressed keys, enqueue `analyze` + `dedupe`. Videos (`kind: original`) go through ffprobe/ffmpeg: poster, ≤ 8 frames, 720p transcode. |
| `dedupe`            | pHash neighbours within a day: re-encoded copies → `variant_of`; bursts → `near_dup_group_id`. |
| `titles`            | Rule-based titles (§9.10), place assignment/creation, cover choice, optional Nominatim reverse geocoding (`GEOCODE=1`). |
| `reconcile_staging` | Nightly: enqueue completed-but-underived staging objects, delete orphans older than 7 days. |
| `hard_delete`       | After the grace period: remove the asset, and the blob + objects when unreferenced; enqueue a recluster. |
| `export`            | GDPR export: zip of originals + `metadata.json` to `exports/{userId}/…` in the bucket. |

## Run

```sh
set -a; . ../../.env; set +a
pnpm dev            # tsx watch
pnpm start --once   # process what is queued, then exit
pnpm test           # needs Postgres + MinIO from the root .env
```

Environment: `DATABASE_URL_WORKER`, `S3_*`, `WORKER_CACHE_DIR`, `WORKER_CACHE_GB`, `WORKER_CONCURRENCY`, `FFMPEG_NVENC=1` on the
GPU box, `GEOCODE=1` to enable reverse geocoding, `LOG_LEVEL`.

Notes:

- Raw `sql` fragments must pass timestamps as ISO strings (`d.toISOString()`), never `Date` objects: the drizzle
  postgres-js driver forwards `Date` unserialized.
- A phone-made 1600 px JPEG preview is stored as-is; anything larger, non-JPEG, rotated, or an original is re-encoded.
- `blobs.sha256` is fixed at the first verified upload and is the content address for every derivative key.

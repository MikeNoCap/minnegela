#!/usr/bin/env bash
# Phase 2: move object storage from the local MinIO bucket to Cloudflare R2 (EU jurisdiction).
# 1. Create the bucket in the Cloudflare dashboard with jurisdiction = EU (cannot be changed later).
# 2. Create an API token scoped to that bucket, object read/write only.
# 3. Configure two rclone remotes: "minio" and "r2".
# 4. Stop the workers, run this script, flip S3_* in .env to the R2 values, start everything.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
COMPOSE="${COMPOSE:-podman compose -f infra/compose.yml}"
$COMPOSE stop media-worker ml-worker api
rclone sync "minio:${S3_BUCKET}" "r2:${S3_BUCKET}" --fast-list --transfers 32 --checkers 64 --stats 1m
rclone check "minio:${S3_BUCKET}" "r2:${S3_BUCKET}" --one-way --fast-list
echo "Objects copied and verified. Now set S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE=false/S3_JURISDICTION=eu in .env and run:"
echo "  $COMPOSE up -d api media-worker ml-worker"

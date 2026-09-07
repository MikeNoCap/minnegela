# Restore runbook

Test this quarterly. Last tested: never.

## What exists
- `BACKUP_DIR/pg/*.dump`: nightly `pg_dump -Fc`, 14 days.
- `BACKUP_DIR/media/`: rclone mirror of the bucket (R2 in production, MinIO in dev).
- restic repository: encrypted snapshots of both, if `RESTIC_REPOSITORY` is set.

## Database
```sh
podman compose -f infra/compose.yml up -d postgres
podman compose -f infra/compose.yml exec -T postgres pg_restore -U minnegela -d minnegela --clean --if-exists < BACKUP_DIR/pg/minnegela-YYYY-MM-DD.dump
pnpm db:migrate   # no-op if the dump is current
```

## Objects
Bucket lost or damaged: `rclone sync BACKUP_DIR/media r2:minnegela-media`.
R2 unavailable but the box is fine: start MinIO (`infra/compose.dev.yml`), `rclone sync BACKUP_DIR/media minio:minnegela-media`, flip `S3_ENDPOINT` in `.env` to MinIO, restart api and workers. URL signing follows the endpoint.

## From restic
`restic restore latest --target /srv/restore` then follow the two sections above from `/srv/restore`.

## Verify
- `GET /v1/groups/:g/status` shows queue depths at zero and storage counts matching the dump.
- Open three events from different months; thumbnails load; a search for a person returns results.

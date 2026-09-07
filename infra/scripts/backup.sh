#!/usr/bin/env bash
# Nightly: pg_dump (14 days kept), R2 -> local mirror (rclone), restic snapshot of both to BACKUP_REPO.
# Cron: 0 3 * * * /opt/minnegela/infra/scripts/backup.sh >> /var/log/minnegela-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
BACKUP_DIR="${BACKUP_DIR:-/srv/minnegela-backup}"
COMPOSE="${COMPOSE:-podman compose -f infra/compose.yml}"
mkdir -p "$BACKUP_DIR/pg" "$BACKUP_DIR/media"

# 1. Postgres dump
$COMPOSE exec -T postgres pg_dump -U minnegela -Fc minnegela > "$BACKUP_DIR/pg/minnegela-$(date +%F).dump"
find "$BACKUP_DIR/pg" -name '*.dump' -mtime +14 -delete

# 2. Bucket mirror (free egress on R2; MinIO in dev). Requires an rclone remote named "media".
rclone sync "media:${S3_BUCKET}" "$BACKUP_DIR/media" --fast-list --transfers 16 --checkers 32 --stats 1m

# 3. Encrypted snapshots to the external disk / second location
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup "$BACKUP_DIR" --tag minnegela
  restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
fi
echo "backup ok $(date -Is)"

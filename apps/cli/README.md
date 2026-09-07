# @minnegela/cli

`minnegela import <folder>` speaks the phone sync protocol (docs/DESIGN.md §13.1) so a folder of photos can be pushed
through the whole pipeline without the mobile app. Handy for Phase 0/1 and for backfilling from a camera or a laptop.

```sh
set -a; . ../../.env; set +a
pnpm start login http://localhost:4000 you@example.com        # paste the magic link the API logs
pnpm start import ~/Pictures/2025 --group <groupId> --dry-run  # see what would be sent
pnpm start import ~/Pictures/2025 --group <groupId>            # previews (what ML runs on)
pnpm start import ~/Pictures/2025 --group <groupId> --originals
```

What it does, per file: MD5 + size + EXIF time/GPS/dimensions → `POST /v1/groups/:g/sync/manifest` (batches of 200) →
for `want_preview`, a 1600 px q82 JPEG (EXIF kept; poster frame for videos) is `PUT` to the presigned URL →
`POST /v1/assets/:id/complete`. `--originals` adds `POST /sync/uploads` + PUT + complete for the original bytes.

State lives in `~/.config/minnegela/` (`credentials.json`, `devices.json`, `state-<hash>.json`), so re-runs skip
what was already synced and resume after failures. `--since`, `--ext jpg,heic,mp4`, `--concurrency`, `--token`,
`$MINNEGELA_TOKEN`, `$MINNEGELA_CONFIG_DIR` are available. HEIC previews need a libvips build with libheif; without it
the file is manifested but preview generation fails and is reported.

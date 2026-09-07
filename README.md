# Minnegela

A search engine for your friend group's memories. The unit of memory is the event, not the photo.

The full technical design lives in [docs/DESIGN.md](docs/DESIGN.md). This README covers running the code.

## Layout

```
apps/
  api/           Fastify + Drizzle + Better Auth. REST /v1.
  web/           Next.js browsing UI.
  media-worker/  Node: derive (thumbs, EXIF, pHash), dedupe, titles.
  ml-worker/     Python: analyze (faces + CLIP), identify, recluster (WBS), text-embed endpoint.
  cli/           Folder importer that speaks the phone sync protocol. For dev and Phase 0.
  mobile/        Expo app (Phase 1, not started).
packages/
  shared/        Zod schemas, API types, SearchQuery, job kinds, constants.
  db/            Drizzle schema, SQL migrations (triggers, RLS), withViewer, visibility builders, jobs queue.
infra/           compose files, Caddy, Postgres init, scripts.
spike/           Phase 0 scripts (throwaway).
```

## Local development

Requirements: Node 22+, pnpm, podman (or docker) with compose, uv (for the Python worker).

```sh
cp .env.example .env
pnpm install
pnpm infra:up                 # postgres (pgvector) + minio
pnpm db:migrate               # extensions, tables, triggers, RLS, roles
pnpm db:seed                  # dev user, group, six-branch visibility fixture
pnpm --filter @minnegela/api dev
pnpm --filter @minnegela/media-worker dev
cd apps/ml-worker && uv sync && uv run minnegela-ml worker   # needs models; --device cpu works
pnpm --filter @minnegela/web dev
```

Import a folder of photos through the same protocol the phone uses:

```sh
pnpm --filter @minnegela/cli start import ~/Pictures/2025 --group <groupId> --token <session token>
```

## Production

See `infra/compose.yml`. Object storage is Cloudflare R2 (EU jurisdiction); the compose stack runs Postgres, the API, the web app, both workers and Caddy on one box behind Tailscale.

## Status (2026-09-07)

Built and verified on a dev laptop against Postgres + MinIO in podman:

| Piece | State |
|---|---|
| `packages/db` | Schema from §11 as SQL migrations 0000–0003 (triggers for `person_ids`/`contributor_ids`, RLS with `api`/`worker` roles, `ml` schema for embeddings), Drizzle mirror, `withViewer` + `visibleEvents/visibleAssets`, jobs queue. 11 tests: the six-branch visibility fixture through RLS and through the explicit predicate. |
| `apps/api` | All §21 routes (49 paths), Better Auth magic link + bearer, presigned R2/MinIO URLs, deterministic search parser, CLIP text ranking via the ML worker. 25 tests incl. a visibility walk of every read route per member. |
| `apps/media-worker` | derive (photo + video), dedupe, titles, places, reconcile, hard delete, export. 22 tests. |
| `apps/cli` | Folder importer speaking the phone protocol; verified end to end (13 files → previews + originals → derive). |
| `apps/ml-worker` | Queue consumer, analyze/identify/recluster, WBS in numpy, text-embed endpoint. 22 tests (WBS, matching, queue, recluster against Postgres). Model code paths untested until the GPU box has drivers. |
| `apps/web` | Login, home river, search with chips, event page (moments, tiers, who-can-see, open/close, tags, split/merge/exclude), people, review queue, timeline, group/status. Builds; not yet exercised against live data. |
| `apps/mobile` | Not started (Phase 1 tasks 16–17). |

Next: run Phase 0 on the real server (NVIDIA driver, `uv sync --extra ml`, `minnegela-ml check-models`), import a real folder with the CLI, judge the events, tune `packages/shared/src/constants.ts`.

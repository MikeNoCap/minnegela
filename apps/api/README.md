# @minnegela/api

Fastify 5 + Drizzle + Better Auth. REST/JSON under `/v1`, OpenAPI at `/v1/openapi.json`, health at `/v1/health`.
Design: `docs/DESIGN.md` §12, §13.1, §15, §18, §21.

## Run

```sh
set -a; . ../../.env; set +a
pnpm dev            # tsx watch src/main.ts
pnpm test           # vitest against the real Postgres + MinIO from .env (skipped without DATABASE_URL_ADMIN)
```

Env (see `.env.example`): `DATABASE_URL` (api role, RLS), `BETTER_AUTH_SECRET`, `API_URL`, `WEB_URL`, `S3_*`, `ML_TEXT_EMBED_URL`, `MAIL_TRANSPORT=console|smtp`.

## Auth

Better Auth is mounted at `/v1/auth/*` (magic link + bearer plugins, Drizzle adapter over `users/sessions/accounts/verifications`, uuid ids).

- **Web**: `POST /v1/auth/sign-in/magic-link {email, name?, callbackURL}` → the link is logged (`MAIL_TRANSPORT=console`) → `GET /v1/auth/magic-link/verify?token=…` sets the `better-auth.session_token` cookie and 302s to `callbackURL`. `WEB_URL` is a trusted origin; CORS allows it with credentials. Cookies are host-scoped, so `localhost:3000` ↔ `localhost:4000` works in dev without extra config.
- **Mobile / CLI**: the verify response also carries `set-auth-token`; send it as `Authorization: Bearer <token>`. Raw session tokens (the `sessions.token` column) are accepted too.
- Every request resolves `request.user`; group routes build a `ViewerCtx {groupId, userId, personId}` from membership and run all queries inside `withViewer()` so RLS and the explicit `visibleEvents/visibleAssets` predicates both apply. Entity routes (`/v1/events/:id`, `/v1/media/:blobId`, `/v1/people/:id`, `/v1/places/:id`, `/v1/assets/:id`) locate the entity across the caller's groups; anything outside scope is **404, never 403**. 403 is used only for actions on entities the caller can see (owner-only, contributor-only).

## Routes

| Area | Routes |
|---|---|
| Account | `GET /me` → `{user, groups}` · `DELETE /me` (202, grace) · `POST /me/export` |
| Groups | `POST /groups` · `GET/PATCH /groups/:g` · `POST /groups/:g/invites` · `DELETE /groups/:g/invites/:code` · `POST /invites/:code/accept` · `GET /groups/:g/members` · `PATCH/DELETE /groups/:g/members/me` · `GET/POST /groups/:g/devices` · `GET /groups/:g/status` |
| Sync | `POST /groups/:g/sync/manifest` · `POST /groups/:g/sync/uploads` · `POST /assets/:id/complete` · `DELETE /assets/:id` · `PATCH /assets/:id` |
| Events | `GET /groups/:g/events` · `GET /groups/:g/timeline?day` · `GET /groups/:g/map?bbox&from&to` · `GET /events/:id` · `GET /events/:id/media` · `PATCH /events/:id` · `POST /events/:id/open|close` · `GET /events/:id/visibility` · `POST/DELETE /events/:id/tags[/:personId]` · `POST /events/:id/split|merge|exclude|include` |
| Search | `GET /groups/:g/search?q&mode` → `{parsed, mode, events?|media?}` |
| Media | `GET /media/:blobId` · `GET /media/:blobId/url?kind` · `POST /groups/:g/media/urls` (batch, invisible blobs silently omitted, one audit row per batch) |
| People | `GET /groups/:g/people` · `GET /people/:id` · `POST /groups/:g/people` · `PATCH /people/:id` · `POST /people/:id/enroll` · `GET /groups/:g/review` · `POST /groups/:g/review/clusters/:clusterId/dismiss` · `POST /faces/:id/label` · `GET /faces/:id/crop` (streamed) |
| Places | `GET /groups/:g/places` · `PATCH /places/:id` |
| Admin | `GET /groups/:g/jobs` · `POST /groups/:g/jobs/retry` · `POST /groups/:g/recluster` · `GET /groups/:g/audit` (owner) |

Pagination: opaque cursors (`nextCursor`). Errors: RFC 7807 `application/problem+json`.

## Storage

`src/storage.ts` wraps `@aws-sdk/client-s3` for MinIO (dev) and R2 (prod). GET URLs use hour-bucketed expiries (`ceil(now/1h)*1h + 1h`, cached per key) so grids stay browser-cacheable. PUT URLs are single-object, 15 minutes, content-type bound; `/sync/uploads` also binds the exact content length. The manifest's `want_preview` URL is not length-bound because the phone has not generated the preview yet.

## Search

`src/search/parser.ts` is deterministic: person names (longest first, `me`/`meg`, `person:<id>` tokens from the UI), seasons, chrono-node over a token-aligned Norwegian→English rewrite (`i mars` → March, `i fjor sommer` → last summer), bare years, then a trigram match of the leftover against visible event titles, and finally the remainder as CLIP text. Text embeddings come from `ML_TEXT_EMBED_URL` (`POST {text}` → `{embedding[512]}`) and are cached in `search_text_cache`; if the worker is down the search degrades to structured filters and says so in a chip.

## Tests

`test/visibility.test.ts` walks the six-branch fixture (`seedFixture` from `@minnegela/db`) through every read route for every member and checks writes (labels, tags, open/close, split, exclude) flip visibility as §18.3 says. `test/sync.test.ts` uploads to MinIO through a presigned URL. `test/auth.test.ts` runs the magic-link flow. `test/parser.test.ts` is pure.

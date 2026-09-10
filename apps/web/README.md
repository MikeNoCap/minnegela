# @minnegela/web

The browsing surface (docs/DESIGN.md §17). Next.js App Router, React 19, Tailwind 4, TanStack Query, Better Auth client. No component library. MapLibre GL for the map (style URLs in `NEXT_PUBLIC_MAP_STYLE_LIGHT` / `_DARK`, OpenFreeMap by default).

## Run

```sh
pnpm --filter @minnegela/web dev      # http://localhost:3000, expects the API on NEXT_PUBLIC_API_URL
pnpm --filter @minnegela/web build    # standalone output; no API needed at build time
```

Env: `NEXT_PUBLIC_API_URL` (browser → API), `API_URL` (server-side, compose network). The API must allow `WEB_URL` as a CORS origin with credentials; the session cookie is set by the API domain.

## Routes

| Path | What |
|---|---|
| `/login` | magic-link sign-in; the API prints the link in dev |
| `/` | events river, people strip, "this week last year", loose-photo days collapsed |
| `/search?q=&mode=` | parsed chips (removable), events / photos toggle |
| `/events/[id]` | header with who-can-see line, open/close toggle, tag picker, merge, moments timeline with tiers and the "Also possibly" strip, split at seam, exclude selection |
| `/people`, `/people/[id]` | members / named / unnamed; person page with events, co-appearances, photos |
| `/review` | unnamed clusters (name / this-is / hide), low-confidence faces (yes / no), suggested splits |
| `/timeline?with=&mode=&day=` | the braid: people as strands, events as knots; follow one strand or the times several were together; loose-photo days expand inline; minimap to jump in time |
| `/group` | members, invite (owner), consent toggle, devices, queues, storage, audit (owner) |
| `/map` | MapLibre (worker served from `public/maplibre/`, copied by `scripts/copy-maplibre.mjs` on build): photo pins that stack by zoom, loose photos as dots, time scrubber with play, events in view listed |

## How it talks to the API

`src/lib/api.ts` wraps `fetch` with cookies; problem+json becomes `ApiError`; a 401 sends the browser to `/login`. `src/lib/urls.ts` batches every thumbnail request on a page into one `POST /v1/groups/:g/media/urls` and caches the presigned URLs for 50 minutes, just under the API's hour-bucketed signature window, so the browser cache keeps working. Face crops are plain `<img>` tags pointing at `GET /v1/faces/:id/crop` with credentials (never presigned).

Endpoint and response-shape assumptions are collected in `src/lib/types.ts` and `src/lib/hooks.ts`.

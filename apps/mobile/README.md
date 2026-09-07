# @minnegela/mobile

The phone app is a **sync client with a privacy dashboard**, not the browsing surface (docs/DESIGN.md §2.3, §16).
It indexes the camera roll into a local SQLite table, speaks the same manifest → presigned PUT → complete protocol
as `apps/cli`, and shows what is indexed, queued, excluded and visible to friends. Browsing happens in the web app.

## Build a dev client

Expo Go cannot run background tasks or the media library, so you need a development build once:

```sh
cd apps/mobile
npx eas login                                   # once
npx eas build --profile development --platform android   # or ios (needs an Apple developer account)
```

Install the resulting APK / IPA on the phone, then run the bundler from the monorepo:

```sh
pnpm --filter @minnegela/mobile start           # expo start --dev-client
```

Point the app at the API on the first screen (`http://<tailscale ip>:4000`); the default comes from
`EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WEB_URL` in `.env` if you export them before `expo start`.

## Sign-in

Email → 6-digit code (`/v1/auth/email-otp/*`) → bearer token in the keystore. First sign-in asks for a name
(`PATCH /v1/me`). Then: join or create a group, photo permission, face enrollment (3–5 selfies), sync policy.

## What the sync does

`src/sync/runner.ts` is one bounded, idempotent pass: enumerate new library assets → (weekly) reconcile deletions →
manifest ≤ 200 rows → previews (1600 px JPEG, background URLSession upload) → originals when the policy allows
(Wi-Fi + charging by default, video cap) → retry face enrollment until the server has analyzed the reference photos.
It runs on every app open with a 2-minute budget, from "Sync now" with a 5-minute budget, and from the OS background
task (`expo-background-task`, every ≥ 15 min when allowed) with a 25-second budget.

**What the platforms allow** (§16.4). iOS runs the background task only when the phone is idle and usually charging,
typically overnight; uploads handed to the background session continue after the app is suspended. Android runs it
through WorkManager at ≥ 15-minute intervals subject to Doze. The honest expectation shown in the app: *your library
syncs fastest while the app is open and the phone is on Wi-Fi and charging; we keep going in the background when the
phone lets us.*

Android has no cheap content hash for `content://` uris, so the manifest carries no `md5` there and the server's
SHA-256 (computed after upload) is the identity. iOS sends the md5 so AirDropped duplicates are skipped before upload.

## Layout

```
app/                    Expo Router: (onboarding)/sign-in, profile, group, permissions, enroll, policy; (tabs)/index, library, privacy, group
src/api                 fetch client + typed routes           src/auth      SecureStore session
src/db                  expo-sqlite local index (§16.2)       src/store     settings (zod) + app context
src/sync                rules, policy, manifest, hash (pure)  · runner (injectable) · adapters (expo) · background · useSync
test/                   vitest with in-memory fakes; no React Native runtime needed
```

`pnpm --filter @minnegela/mobile typecheck` and `pnpm --filter @minnegela/mobile test`.

import { z } from 'zod';

/** Persisted in sync_state under key `settings` as JSON. */
export const Settings = z.object({
  apiUrl: z.string().default(process.env.EXPO_PUBLIC_API_URL ?? ''),
  webUrl: z.string().default(process.env.EXPO_PUBLIC_WEB_URL ?? ''),
  groupId: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  policy: z.object({
    previewsOnCellular: z.boolean().default(true),
    originalsWifiCharging: z.boolean().default(true),
    includeVideos: z.boolean().default(true),
    videosMaxMb: z.number().default(500),
  }).prefault({}),
  rules: z.object({
    excludedAlbumIds: z.array(z.string()).default([]),
    excludeScreenshots: z.boolean().default(true),
    sinceDate: z.string().nullable().default(null),
  }).prefault({}),
  enrollment: z.object({
    pendingLocalIds: z.array(z.string()).default([]),
    doneAt: z.string().nullable().default(null),
    lastError: z.string().nullable().default(null),
  }).prefault({}),
  onboardingDone: z.boolean().default(false),
});
export type Settings = z.infer<typeof Settings>;
export const defaultSettings = (): Settings => Settings.parse({});
export function parseSettings(json: string | null): Settings {
  try { return Settings.parse(json ? JSON.parse(json) : {}); } catch { return defaultSettings(); }
}

import { z } from 'zod';
import { CaptureHint } from './provenance.js';

/** §13.1 ingest protocol. Sent by the phone (and the folder importer) in batches of ≤ 200. */
export const ManifestItem = z.object({
  localId: z.string().min(1).max(512),
  md5: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  size: z.number().int().nonnegative(),
  mime: z.string().min(3).max(100),
  createdAt: z.string().datetime({ offset: true }),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().nonnegative().optional() }).optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  dur: z.number().nonnegative().optional(),
  albums: z.array(z.string()).default([]),
  filename: z.string().max(512).optional(),
  isFavorite: z.boolean().default(false),
  /** Device path when the platform exposes one (Android file path, importer-relative path); provenance signal (§7.4). */
  path: z.string().max(1024).optional(),
  /** EXIF summary read on the device; lets the server grade provenance before any original arrives. */
  exif: CaptureHint.optional(),
  /** Platform screenshot flag (iOS media subtype). */
  isScreenshot: z.boolean().optional(),
  /** Optional client hints, reserved for on-device pre-filtering (§4.3). Ignored by the server today. */
  hints: z.record(z.string(), z.unknown()).optional(),
});
export type ManifestItem = z.infer<typeof ManifestItem>;

export const ManifestRequest = z.object({ deviceId: z.string().uuid(), assets: z.array(ManifestItem).min(1).max(200) });
export type ManifestRequest = z.infer<typeof ManifestRequest>;

export const UploadTarget = z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()), expiresAt: z.string().datetime(), key: z.string() });
export type UploadTarget = z.infer<typeof UploadTarget>;

export const ManifestAction = z.enum(['skip', 'want_preview', 'want_original']);
export const ManifestResponseItem = z.object({ localId: z.string(), assetId: z.string().uuid(), action: ManifestAction, upload: UploadTarget.optional() });
export const ManifestResponse = z.object({ results: z.array(ManifestResponseItem) });
export type ManifestResponse = z.infer<typeof ManifestResponse>;

export const UploadKind = z.enum(['preview', 'original']);
export const UploadsRequest = z.object({ items: z.array(z.object({ assetId: z.string().uuid(), kind: UploadKind, bytes: z.number().int().positive(), mime: z.string() })).min(1).max(200) });
export const UploadsResponse = z.object({ items: z.array(z.object({ assetId: z.string().uuid(), kind: UploadKind, upload: UploadTarget })) });

export const CompleteRequest = z.object({ kind: UploadKind, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() });
export type CompleteRequest = z.infer<typeof CompleteRequest>;

export const RegisterDeviceRequest = z.object({ platform: z.enum(['ios', 'android', 'cli', 'web']), name: z.string().min(1).max(200), pushToken: z.string().optional() });

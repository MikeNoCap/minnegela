import type { CaptureHint } from '@minnegela/shared';

/** §7.4 provenance signals the phone can read cheaply; the server grades them. Pure, testable without Expo. */

/** A real file path when the platform gives one (Android `file:///storage/emulated/0/DCIM/Camera/x.jpg`); null for ph:// and content:// handles. */
export function pathFrom(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith('file://')) return null;
  try { return decodeURIComponent(uri.slice('file://'.length)).slice(0, 1024); } catch { return uri.slice('file://'.length).slice(0, 1024); }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);

/**
 * EXIF summary from expo-media-library asset info. Android gives flat ExifInterface keys; iOS nests them
 * under `{TIFF}` and `{Exif}`. Returns null when there is nothing camera-like in it.
 */
export function exifHintFrom(exif: Record<string, unknown> | null | undefined): CaptureHint | null {
  if (!exif) return null;
  const tiff = (exif['{TIFF}'] ?? {}) as Record<string, unknown>;
  const ex = (exif['{Exif}'] ?? {}) as Record<string, unknown>;
  const hint: CaptureHint = {
    make: str(exif.Make) ?? str(tiff.Make),
    model: str(exif.Model) ?? str(tiff.Model),
    dateTimeOriginal: str(exif.DateTimeOriginal) ?? str(ex.DateTimeOriginal),
    offset: str(exif.OffsetTimeOriginal) ?? str(exif.OffsetTime) ?? str(ex.OffsetTimeOriginal) ?? str(ex.OffsetTime),
    software: str(exif.Software) ?? str(tiff.Software),
  };
  const out = Object.fromEntries(Object.entries(hint).filter(([, v]) => v !== undefined)) as CaptureHint;
  return Object.keys(out).length ? out : null;
}

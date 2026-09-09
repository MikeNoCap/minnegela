import type { LibraryAsset } from './types';

/**
 * Enrollment runs during onboarding, before the first library walk, so a picked reference photo
 * usually has no row in the local index yet (and on Android the picker often returns no MediaStore
 * id at all). Instead of matching, the pick is copied into app storage and indexed as its own row
 * under this prefix. The sync uploads it like any other asset; when the library walk later reaches
 * the same photo the server merges the two by content hash (§16.4), so nothing is lost or doubled.
 */
export const ENROLL_PREFIX = 'pick:';
export const isEnrollImport = (localId: string) => localId.startsWith(ENROLL_PREFIX);

export type PickedImage = {
  uri: string;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  width?: number;
  height?: number;
  exif?: Record<string, unknown> | null;
};

/** EXIF "YYYY:MM:DD HH:MM:SS" (local time, no zone) → ISO in the device zone; null if absent or malformed. */
export function exifDate(exif: Record<string, unknown> | null | undefined): string | null {
  if (!exif) return null;
  for (const key of ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime']) {
    const v = exif[key] ?? (exif['{Exif}'] as Record<string, unknown> | undefined)?.[key];
    const m = typeof v === 'string' ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v) : null;
    if (!m) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) return d.toISOString();
  }
  return null;
}

/** Pure: a picker result → index row. `uri` is the app-owned copy, `id` the content-derived local id. */
export function pickToLocalAsset(p: PickedImage, id: string, uri: string, size: number, fallbackCreatedAt: string): LibraryAsset {
  const filename = p.fileName || uri.split('/').pop() || 'reference.jpg';
  return {
    localId: id, md5: null, size, mime: p.mimeType || 'image/jpeg', filename, isVideo: false,
    createdAt: exifDate(p.exif) ?? fallbackCreatedAt, modifiedAt: fallbackCreatedAt,
    lat: null, lon: null, w: p.width || null, h: p.height || null, dur: null,
    albumIds: [], albumNames: [], isScreenshot: false, uri,
  };
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import type { ManifestItem, CaptureHint } from '@minnegela/shared';

export const IMAGE_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp' };
export const VIDEO_EXT: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm' };

export type ScannedFile = { rel: string; abs: string; size: number; mtime: Date; mime: string; isVideo: boolean };

/** Recursively list supported media files, sorted by relative path for stable batches. */
export async function walk(root: string, exts?: Set<string>): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function rec(dir: string) {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await rec(abs); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (exts && !exts.has(ext.slice(1))) continue;
      const mime = IMAGE_EXT[ext] ?? VIDEO_EXT[ext];
      if (!mime) continue;
      const s = await stat(abs);
      out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), abs, size: s.size, mtime: s.mtime, mime, isVideo: ext in VIDEO_EXT });
    }
  }
  await rec(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function hashFile(file: string, algo: 'md5' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export type Probe = { createdAt: Date; fromExif: boolean; gps?: { lat: number; lon: number }; w?: number; h?: number; exif?: CaptureHint };

/** Capture time and position for the manifest. Falls back to mtime when the file carries no date. */
export async function probeFile(f: ScannedFile): Promise<Probe> {
  let createdAt = f.mtime, fromExif = false, gps: Probe['gps'], w: number | undefined, h: number | undefined, exif: CaptureHint | undefined;
  if (!f.isVideo) {
    try {
      const ex = await exifr.parse(f.abs, { pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'ExifImageWidth', 'ExifImageHeight', 'Orientation', 'Make', 'Model', 'Software'], gps: true, reviveValues: true, translateValues: false });
      const raw = ex?.DateTimeOriginal ?? ex?.CreateDate;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
      if (ex && (str(ex.Make) || str(ex.Model) || raw instanceof Date)) {
        exif = { make: str(ex.Make), model: str(ex.Model), software: str(ex.Software), dateTimeOriginal: raw instanceof Date ? raw.toISOString() : undefined, offset: str(ex.OffsetTimeOriginal) };
      }
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        // exifr gives the wall clock as a local Date; honour an explicit EXIF offset when present
        const wall = Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate(), raw.getHours(), raw.getMinutes(), raw.getSeconds());
        const m = typeof ex?.OffsetTimeOriginal === 'string' && /^([+-])(\d{2}):(\d{2})$/.exec(ex.OffsetTimeOriginal);
        createdAt = m ? new Date(wall - (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000) : raw;
        fromExif = true;
      }
      // `pick` drops the GPS block, so read it separately
      const g = await exifr.gps(f.abs).catch(() => undefined);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) gps = { lat: g.latitude, lon: g.longitude };
      const swap = (ex?.Orientation ?? 1) >= 5;
      if (ex?.ExifImageWidth && ex?.ExifImageHeight) { w = swap ? ex.ExifImageHeight : ex.ExifImageWidth; h = swap ? ex.ExifImageWidth : ex.ExifImageHeight; }
    } catch { /* no EXIF */ }
    if (!w || !h) {
      try { const sharp = (await import('sharp')).default; const m = await sharp(f.abs).metadata(); const swap = (m.orientation ?? 1) >= 5; w = swap ? m.height : m.width; h = swap ? m.width : m.height; } catch { /* undecodable (HEIC without libheif) */ }
    }
  }
  return { createdAt, fromExif, gps, w, h, exif };
}

export function toManifestItem(f: ScannedFile, md5: string, p: Probe): ManifestItem {
  return {
    localId: f.rel, md5, size: f.size, mime: f.mime,
    createdAt: p.createdAt.toISOString(), modifiedAt: f.mtime.toISOString(),
    gps: p.gps, w: p.w, h: p.h,
    albums: f.rel.includes('/') ? [f.rel.split('/')[0]!] : [],
    filename: path.basename(f.rel), isFavorite: false,
    path: f.rel, exif: p.exif,
  };
}

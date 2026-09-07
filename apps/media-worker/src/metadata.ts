import exifr from 'exifr';
import sharp from 'sharp';

export type Metadata = {
  width: number;
  height: number;
  format: string;
  exif: Record<string, unknown> | null;
  capturedAt: Date | null;        // from EXIF only (with offset applied when present)
  capturedTz: string | null;      // "+02:00" style when EXIF carried an offset
  exifHasOffset: boolean;
  lat: number | null;
  lon: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  orientation: number;
};

const EXIF_PICK = ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime', 'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'Orientation', 'Software', 'ImageWidth', 'ImageHeight', 'GPSAltitude', 'GPSHPositioningError'];

/** Read dimensions and EXIF the way §8.2 wants them: absolute time when the file says so, otherwise "unknown". */
export async function readMetadata(input: Buffer | string): Promise<Metadata> {
  const meta = await sharp(input).metadata();
  const orientation = meta.orientation ?? 1;
  const swap = orientation >= 5;
  const width = swap ? meta.height! : meta.width!;
  const height = swap ? meta.width! : meta.height!;
  let ex: Record<string, unknown> | null = null;
  try {
    ex = (await exifr.parse(input, { pick: EXIF_PICK, gps: true, reviveValues: true, translateValues: true, xmp: false, icc: false, iptc: false })) ?? null;
  } catch {
    ex = null;
  }
  let lat: number | null = null, lon: number | null = null;
  try {
    const g = await exifr.gps(input);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) { lat = g.latitude; lon = g.longitude; }
  } catch { /* none */ }

  let capturedAt: Date | null = null, capturedTz: string | null = null, exifHasOffset = false;
  const raw = ex?.DateTimeOriginal ?? ex?.CreateDate;
  const offset = (ex?.OffsetTimeOriginal ?? ex?.OffsetTime) as string | undefined;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    // exifr revives "YYYY:MM:DD HH:MM:SS" as a local-time Date. Recover the wall-clock digits and apply the EXIF offset.
    const wall = Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate(), raw.getHours(), raw.getMinutes(), raw.getSeconds());
    const m = offset && /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      const offMin = sign * (Number(m[2]) * 60 + Number(m[3]));
      capturedAt = new Date(wall - offMin * 60_000);
      capturedTz = offset!;
      exifHasOffset = true;
    } else {
      // no offset: treat the wall clock as UTC for now; derive.ts refines it with GPS or the asset's OS timestamp
      capturedAt = new Date(wall);
    }
  }
  const clean: Record<string, unknown> | null = ex ? Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])) : null;
  return {
    width, height, format: meta.format ?? 'unknown', exif: clean, capturedAt, capturedTz, exifHasOffset, lat, lon,
    cameraMake: typeof ex?.Make === 'string' ? ex.Make.trim() : null,
    cameraModel: typeof ex?.Model === 'string' ? ex.Model.trim() : null,
    orientation,
  };
}

const PHONE_SCREENS = new Set(['1080x1920', '1080x2340', '1080x2400', '1170x2532', '1179x2556', '1206x2622', '1242x2688', '1284x2778', '1290x2796', '1320x2868', '750x1334', '828x1792', '1125x2436', '1440x3120', '1440x3200', '1440x2560', '1080x2280', '1080x2220', '720x1280', '1536x2048', '2048x2732', '1668x2388', '1640x2360', '1920x1080', '2560x1440', '3840x2160', '2880x1800', '3024x1964', '3456x2234', '1366x768', '1280x800']);

/** §6.3 belt-and-braces screenshot detection from metadata alone. */
export function looksLikeScreenshot(m: Metadata): boolean {
  const dims = `${m.width}x${m.height}`;
  const flipped = `${m.height}x${m.width}`;
  const noCamera = !m.cameraMake && !m.cameraModel;
  if (m.format === 'png' && noCamera) return true;
  if (noCamera && (PHONE_SCREENS.has(dims) || PHONE_SCREENS.has(flipped))) return true;
  const sw = typeof m.exif?.Software === 'string' ? (m.exif.Software as string).toLowerCase() : '';
  if (/screenshot|snipping|screen capture/.test(sw)) return true;
  return false;
}

/** §7.4 messenger re-encode signature: JPEG with no camera and no EXIF date, downscaled to messenger sizes. */
export function looksReencoded(m: Metadata): boolean {
  if (m.format !== 'jpeg') return false;
  if (m.cameraMake || m.cameraModel || m.capturedAt) return false;
  const long = Math.max(m.width, m.height);
  return long <= 1600 || long === 1280 || long === 2048;
}

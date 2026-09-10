import { z } from 'zod';

/**
 * §7.4 provenance. Where a file on the phone came from decides how much its metadata is worth:
 *
 *   camera      the phone's own camera wrote it → OS creation time is the capture time, GPS is real
 *   received    saved from a messenger / browser / download → the time is the download time, no GPS
 *   screenshot  utility media (§6.3)
 *   edited      an editor re-saved it (EXIF may or may not survive)
 *   unknown     nothing to go on; treated like received (untrusted) until an original with EXIF arrives
 *
 * Only `camera` media votes on event boundaries and grants presence (§18.3). Everything else is placed
 * next to trusted media it can be anchored to, or stays with its owner.
 */
export const ORIGINS = ['camera', 'received', 'screenshot', 'edited', 'unknown'] as const;
export type Origin = (typeof ORIGINS)[number];

/** EXIF summary the phone can read without uploading the original (expo-media-library asset info). */
export const CaptureHint = z.object({
  make: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  /** "YYYY:MM:DD HH:MM:SS" as EXIF writes it, or ISO 8601 */
  dateTimeOriginal: z.string().max(40).optional(),
  /** "+02:00" */
  offset: z.string().max(10).optional(),
  software: z.string().max(100).optional(),
});
export type CaptureHint = z.infer<typeof CaptureHint>;

export type ProvenanceInput = {
  filename?: string | null;
  albums?: readonly string[] | null;
  /** Device path when known, e.g. /storage/emulated/0/DCIM/Camera/IMG_1.jpg */
  path?: string | null;
  mime: string;
  hasGps: boolean;
  /** Platform screenshot flag (iOS media subtype) */
  isScreenshot?: boolean;
  exif?: CaptureHint | null;
};

const SCREENSHOT_ALBUM = /^screenshots?$/i;
const SCREENSHOT_NAME = /^(screenshot|screen[-_ ]?(shot|record|recording|capture)|scr_)/i;
const SCREENSHOT_PATH = /\/screenshots?\//i;

const RECEIVED_ALBUM = /^(snapchat|whatsapp( images| video| documents| animated gifs| stickers)?|downloads?|messages|telegram(x)?( images| video)?|messenger|instagram|chatgpt|signal|discord|facebook|tiktok|clipped images|slack|teams|viber|line|reddit|pinterest|twitter|x|bereal|threads|gmail|mail|browser|chrome|firefox|bluetooth|nearby share|quick share|shareit|received|saved|vipps|finn\.no|finn)$/i;
const RECEIVED_PATH = /\/(downloads?|bluetooth|whatsapp|telegram|snapchat|messenger|instagram|signal|chatgpt|pictures\/(messages|received|saved))\//i;
const RECEIVED_NAME: RegExp[] = [
  /^snapchat-/i,                      // Snapchat saves (Android)
  /-WA\d{4}/,                         // IMG-20240101-WA0001.jpg (WhatsApp)
  /^image-?\d/i, /^images? ?\(\d+\)/i, // browser downloads
  /^snapinsta/i, /^instagram post/i, /^fb_img/i, /^received_/i, /^unnamed/i, /^chatgpt-/i, /^tmp_/i,
  /^photo_\d{4}-\d{2}-\d{2}_/i, /^video_\d{4}-\d{2}-\d{2}_/i, /^document_/i,   // Telegram
  /^[0-9a-f]{16,}\.\w+$/i,            // hex blob names (Messenger, Discord, Signal)
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i,   // uuid names
  /^(msg|attachment|download)[-_]?\d*/i,
];
/** A phone camera never writes these containers. */
const NON_CAMERA_EXT = /\.(webp|avif|gif|svg|bmp)$/i;

const EDITED_ALBUM = /^(edited|lightroom|snapseed|vsco|photoroom|picsart|canva|photoshop express|remini|lensa|facetune|capcut|inshot)$/i;
const EDITED_NAME = /^(lv_|edited|photoroom|snapseed|vsco|picsart|canva|lensa|remini|capcut|inshot)/i;
const EDITED_SOFTWARE = /(lightroom|snapseed|vsco|photoshop|picsart|gimp|canva|photoroom|facetune|capcut|inshot|remini|lensa)/i;

const CAMERA_ALBUM = /^(camera|dcim|open ?camera|raw|camera roll)$/i;
const CAMERA_PATH = /\/DCIM\/(camera|100[a-z0-9_]+|open ?camera)\//i;
/** Names the platform camera apps write. iOS `IMG_1234.JPG` is *not* here: Photos renames every import that way. */
const CAMERA_NAME: RegExp[] = [
  /^IMG_\d{8}_\d{6,}/, /^VID_\d{8}_\d{6,}/, /^PXL_\d{8}_\d{6,}/, /^MVIMG_\d{8}/, /^PANO_\d{8}/, /^BURST\d/,
  /^DSC[_F]?\d/i, /^P\d{7}\./, /^DJI_\d/, /^GOPR\d/, /^GX\d{6}/, /^\d{8}_\d{6}\.(jpg|jpeg|heic|mp4|mov)$/i,
];

const nonEmpty = (s: string | undefined | null): s is string => typeof s === 'string' && s.trim().length > 0;

/** Classify one library asset from the signals the phone (or the folder importer) can provide cheaply. */
export function classifyOrigin(s: ProvenanceInput): Origin {
  const name = s.filename ?? '';
  const albums = (s.albums ?? []).map((a) => a.trim());
  const path = s.path ?? '';
  const ex = s.exif ?? null;
  const hasCameraExif = !!ex && (nonEmpty(ex.make) || nonEmpty(ex.model) || nonEmpty(ex.dateTimeOriginal));

  if (s.isScreenshot || SCREENSHOT_NAME.test(name) || albums.some((a) => SCREENSHOT_ALBUM.test(a)) || SCREENSHOT_PATH.test(path)) return 'screenshot';
  if (s.mime === 'image/png' && !hasCameraExif && !s.hasGps) return 'screenshot';

  if (albums.some((a) => RECEIVED_ALBUM.test(a)) || RECEIVED_PATH.test(path) || RECEIVED_NAME.some((re) => re.test(name)) || NON_CAMERA_EXT.test(name)) return 'received';

  if (albums.some((a) => EDITED_ALBUM.test(a)) || EDITED_NAME.test(name) || (ex && nonEmpty(ex.software) && EDITED_SOFTWARE.test(ex.software))) return 'edited';

  if (albums.some((a) => CAMERA_ALBUM.test(a)) || CAMERA_PATH.test(path) || hasCameraExif || s.hasGps || CAMERA_NAME.some((re) => re.test(name))) return 'camera';

  return 'unknown';
}

/** Whether media of this origin may vote on boundaries and count as presence. */
export const isTrustedOrigin = (o: Origin): boolean => o === 'camera';

import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FS from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import { PREVIEW } from '@minnegela/shared';
import type { UploadTarget } from '@minnegela/shared';
import type { LocalAsset } from '@/db/types';
import type { Library, LibraryAsset, Uploader, PreparedUpload } from './types';
import type { Conditions } from './policy';
import { Sha256, base64ToBytes } from './hash';

const mimeFor = (filename: string, isVideo: boolean): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (isVideo) return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif', dng: 'image/x-adobe-dng' } as Record<string, string>)[ext] ?? 'image/jpeg';
};

/** Album id → name map, refreshed at most every 10 minutes (albums rarely change). */
let albumCache: { at: number; byId: Map<string, string> } | null = null;
export async function albumMap(): Promise<Map<string, string>> {
  if (albumCache && Date.now() - albumCache.at < 600_000) return albumCache.byId;
  const byId = new Map<string, string>();
  try {
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
    for (const a of albums) byId.set(a.id, a.title);
  } catch { /* limited access on iOS may refuse */ }
  albumCache = { at: Date.now(), byId };
  return byId;
}

/** expo-media-library (legacy paged API) as a Library. */
export const mediaLibrary: Library = {
  async page({ after, first, includeVideos }) {
    const albums = await albumMap();
    // Walk by modification time, not creation time: on Android creationTime is MediaStore's
    // DATE_TAKEN, which is 0 for anything saved without EXIF dates (Snapchat, WhatsApp, downloads),
    // and `createdAfter` filters on that same column. modificationTime is always set.
    const res = await MediaLibrary.getAssetsAsync({
      first,
      after: after ?? undefined,
      mediaType: includeVideos ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] : [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.modificationTime, false]],
    });
    const assets: LibraryAsset[] = [];
    for (const a of res.assets) {
      // getAssetInfoAsync gives GPS, local uri and (iOS) EXIF; it is a few ms per asset.
      let info: MediaLibrary.AssetInfo | null = null;
      try { info = await MediaLibrary.getAssetInfoAsync(a, { shouldDownloadFromNetwork: false }); } catch { info = null; }
      const isVideo = a.mediaType === 'video';
      const created = new Date(a.creationTime || a.modificationTime || Date.now());
      const modified = new Date(a.modificationTime || a.creationTime || Date.now());
      assets.push({
        localId: a.id,
        md5: null,
        size: 0,   // filled by md5()/getInfoAsync at manifest time
        mime: mimeFor(a.filename, isVideo),
        filename: a.filename,
        isVideo,
        createdAt: created.toISOString(),
        modifiedAt: modified.toISOString(),
        lat: info?.location?.latitude ?? null,
        lon: info?.location?.longitude ?? null,
        w: a.width || null,
        h: a.height || null,
        dur: isVideo ? a.duration || null : null,
        albumIds: a.albumId ? [a.albumId] : [],
        albumNames: a.albumId ? [albums.get(a.albumId) ?? a.albumId] : [],
        isScreenshot: (a.mediaSubtypes ?? []).includes('screenshot'),
        uri: info?.localUri ?? a.uri,
      });
    }
    return { assets, endCursor: res.endCursor ?? null, hasNextPage: res.hasNextPage };
  },
  async allIds() {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const res = await MediaLibrary.getAssetsAsync({ first: 1000, after, mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] });
      ids.push(...res.assets.map((a) => a.id));
      if (!res.hasNextPage) return ids;
      after = res.endCursor;
    }
  },
  async md5(a) {
    // iOS: expo-file-system can hash the exported file. Android content:// uris cannot be hashed
    // without a copy; the server's SHA-256 is canonical anyway (§16.4).
    if (Platform.OS !== 'ios') return null;
    try {
      const info = await FS.getInfoAsync(a.uri, { md5: true });
      return info.exists ? (info.md5 ?? null) : null;
    } catch { return null; }
  },
};

async function fileSize(uri: string): Promise<number> {
  const info = await FS.getInfoAsync(uri);
  return info.exists ? info.size ?? 0 : 0;
}

/** Stream a file through SHA-256 in 3 MB base64 chunks (base64 length must stay a multiple of 4). */
export async function sha256File(uri: string, size: number): Promise<string> {
  const h = new Sha256();
  const CHUNK = 3 * 1024 * 1024;
  for (let pos = 0; pos < size; pos += CHUNK) {
    const b64 = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64, position: pos, length: Math.min(CHUNK, size - pos) });
    h.update(base64ToBytes(b64));
  }
  return h.hex();
}

const cacheDir = () => `${FS.cacheDirectory ?? ''}minnegela/`;
async function ensureCache() { try { await FS.makeDirectoryAsync(cacheDir(), { intermediates: true }); } catch { /* exists */ } }

/** Previews and originals via expo-image-manipulator / expo-video-thumbnails / background URLSession uploads. */
export const expoUploader: Uploader = {
  async preparePreview(a: LocalAsset): Promise<PreparedUpload> {
    await ensureCache();
    let sourceUri = a.uri;
    if (a.isVideo) {
      const { uri } = await VideoThumbnails.getThumbnailAsync(a.uri, { time: 0, quality: 1 });
      sourceUri = uri;
    }
    const long = Math.max(a.w ?? 0, a.h ?? 0);
    const resize = long > PREVIEW.longEdgePx ? ((a.w ?? 0) >= (a.h ?? 0) ? { width: PREVIEW.longEdgePx } : { height: PREVIEW.longEdgePx }) : null;
    const out = await ImageManipulator.manipulateAsync(sourceUri, resize ? [{ resize }] : [], { compress: PREVIEW.jpegQuality / 100, format: ImageManipulator.SaveFormat.JPEG });
    const bytes = await fileSize(out.uri);
    const sha256 = await sha256File(out.uri, bytes);
    return { fileUri: out.uri, bytes, sha256, mime: 'image/jpeg', cleanup: async () => { try { await FS.deleteAsync(out.uri, { idempotent: true }); } catch { /* ignore */ } } };
  },
  async prepareOriginal(a: LocalAsset): Promise<PreparedUpload> {
    let uri = a.uri;
    let cleanup = async () => {};
    if (!uri.startsWith('file://')) {
      // ph:// and content:// need a file copy for the background uploader.
      await ensureCache();
      const dest = `${cacheDir()}orig-${a.localId.replace(/[^a-zA-Z0-9]/g, '_')}-${a.filename}`;
      await FS.copyAsync({ from: uri, to: dest });
      uri = dest;
      cleanup = async () => { try { await FS.deleteAsync(dest, { idempotent: true }); } catch { /* ignore */ } };
    }
    const bytes = await fileSize(uri);
    const sha256 = await sha256File(uri, bytes);
    return { fileUri: uri, bytes, sha256, mime: a.mime, cleanup };
  },
  async put(target: UploadTarget, file: PreparedUpload) {
    // Content-Length is set by the uploader from the file; the presigned headers may carry it too and
    // the signature covers the bound length, so strip our copy to avoid a duplicate header.
    const headers = Object.fromEntries(Object.entries(target.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
    const res = await FS.uploadAsync(target.url, file.fileUri, {
      httpMethod: 'PUT',
      headers,
      uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
      sessionType: FS.FileSystemSessionType.BACKGROUND,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`upload failed: ${res.status} ${res.body.slice(0, 200)}`);
  },
};

export async function currentConditions(): Promise<Conditions> {
  const [net, batt] = await Promise.all([Network.getNetworkStateAsync().catch(() => null), Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN)]);
  return {
    online: !!net?.isConnected && (net.isInternetReachable ?? true),
    wifi: net?.type === Network.NetworkStateType.WIFI || net?.type === Network.NetworkStateType.ETHERNET,
    charging: batt === Battery.BatteryState.CHARGING || batt === Battery.BatteryState.FULL,
  };
}

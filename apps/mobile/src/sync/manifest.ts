import { ManifestItem } from '@minnegela/shared';
import type { LocalAsset, LocalState } from '@/db/types';

/** Local row → wire item (validated against the shared schema so a bad row never reaches the API). */
export function toManifestItem(a: LocalAsset, md5?: string | null): ManifestItem {
  return ManifestItem.parse({
    localId: a.localId,
    md5: md5 ?? a.md5 ?? undefined,
    size: a.size,
    mime: a.mime,
    createdAt: a.createdAt,
    modifiedAt: a.modifiedAt ?? undefined,
    gps: a.lat !== null && a.lon !== null ? { lat: a.lat, lon: a.lon } : undefined,
    w: a.w ?? undefined,
    h: a.h ?? undefined,
    dur: a.dur ?? undefined,
    albums: a.albumNames,
    filename: a.filename,
    isFavorite: false,
  });
}

/** §16.3: what the server's answer means for the local row. */
export function stateForAction(action: 'skip' | 'want_preview' | 'want_original'): LocalState {
  switch (action) {
    case 'skip': return 'skipped';
    case 'want_preview': return 'manifested';
    case 'want_original': return 'preview_uploaded';
  }
}

import { describe, it, expect } from 'vitest';
import { ManifestItem } from '@minnegela/shared';
import { toManifestItem, stateForAction } from '@/sync/manifest';
import type { LocalAsset } from '@/db/types';

const row: LocalAsset = {
  localId: 'ph-1', md5: null, size: 2_345_678, mime: 'image/heic', filename: 'IMG_0007.HEIC', isVideo: false,
  createdAt: '2026-03-14T21:30:00.000+01:00', modifiedAt: null, lat: 59.9227, lon: 10.759, w: 4032, h: 3024, dur: null,
  albumIds: ['x'], albumNames: ['Party'], isScreenshot: false, uri: 'ph://1', serverAssetId: null, state: 'new', lastError: null, attempts: 0, updatedAt: '',
};

describe('manifest mapping (§13.1)', () => {
  it('produces an item that satisfies the shared schema, with gps and albums', () => {
    const item = toManifestItem(row, 'c'.repeat(32));
    expect(ManifestItem.safeParse(item).success).toBe(true);
    expect(item).toMatchObject({ localId: 'ph-1', md5: 'c'.repeat(32), size: 2_345_678, gps: { lat: 59.9227, lon: 10.759 }, albums: ['Party'], w: 4032 });
  });
  it('omits md5 on Android-style rows and gps when missing', () => {
    const item = toManifestItem({ ...row, lat: null, lon: null }, null);
    expect(item.md5).toBeUndefined(); expect(item.gps).toBeUndefined();
  });
  it('videos carry duration', () => expect(toManifestItem({ ...row, isVideo: true, dur: 9.4, mime: 'video/quicktime' }).dur).toBe(9.4));
  it('maps server actions to local states', () => {
    expect(stateForAction('skip')).toBe('skipped');
    expect(stateForAction('want_preview')).toBe('manifested');
    expect(stateForAction('want_original')).toBe('preview_uploaded');
  });
});

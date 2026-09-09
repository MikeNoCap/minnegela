import { describe, it, expect } from 'vitest';
import { exifDate, pickToLocalAsset, ENROLL_PREFIX, isEnrollImport } from '@/sync/enrollPick';
import { runSync, SYNC_KEYS } from '@/sync/runner';
import { makeDeps, FakeLibrary, asset } from './fakes';

describe('enrollment imports (picks before the first library walk)', () => {
  it('reads the capture date from EXIF in any of the usual shapes', () => {
    const d = new Date(2026, 6, 4, 21, 15, 30).toISOString();
    expect(exifDate({ DateTimeOriginal: '2026:07:04 21:15:30' })).toBe(d);
    expect(exifDate({ '{Exif}': { DateTimeOriginal: '2026:07:04 21:15:30' } })).toBe(d);
    expect(exifDate({ DateTime: '2026:07:04 21:15:30' })).toBe(d);
    expect(exifDate({ DateTimeOriginal: '0000:00:00 00:00:00' })).toBeNull();
    expect(exifDate(null)).toBeNull();
  });

  it('builds an index row from a picker result, falling back to the file date', () => {
    const row = pickToLocalAsset({ uri: 'file:///cache/x.jpg', fileName: 'IMG_1.jpg', mimeType: 'image/jpeg', width: 3000, height: 4000 }, 'pick:abc', 'file:///doc/abc.jpg', 1234, '2026-09-01T10:00:00.000Z');
    expect(row).toMatchObject({ localId: 'pick:abc', uri: 'file:///doc/abc.jpg', size: 1234, filename: 'IMG_1.jpg', w: 3000, h: 4000, createdAt: '2026-09-01T10:00:00.000Z', isVideo: false });
    expect(isEnrollImport(row.localId)).toBe(true);
  });

  it('an imported pick is uploaded first and enrolled without being in the library; reconcile never deletes it', async () => {
    const lib = new FakeLibrary([asset(1)]);
    const { deps, db, api, settings } = makeDeps({ library: lib, settings: { enrollment: { pendingLocalIds: [`${ENROLL_PREFIX}abc`], doneAt: null, lastError: null } } });
    await db.upsertLocal([{ ...pickToLocalAsset({ uri: 'file:///c.jpg', fileName: 'me.jpg' }, `${ENROLL_PREFIX}abc`, 'file:///doc/abc.jpg', 500, '2026-09-01T10:00:00.000Z'), state: 'new' }]);
    await db.setSyncState(SYNC_KEYS.lastReconcile, '0');
    const s = await runSync(deps, { budgetMs: 10_000, maxItems: 100 });
    expect(api.manifests[0]!.assets[0]!.localId).toBe(`${ENROLL_PREFIX}abc`);
    expect(s.enrolled).toBe(true);
    expect(api.enrolls).toEqual([{ personId: 7, assetIds: [`srv-${ENROLL_PREFIX}abc`] }]);
    expect(settings().enrollment.pendingLocalIds).toEqual([]);
    expect(api.deleted).toEqual([]);
    expect((await db.get(`${ENROLL_PREFIX}abc`))!.state).toBe('original_uploaded');
  });
});

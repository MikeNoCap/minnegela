import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ManifestItem } from '@minnegela/shared';
import { walk, hashFile, probeFile, toManifestItem } from '../src/scan.js';
import { makePreview } from '../src/preview.js';

let dir: string;
async function photo(w: number, h: number, exif?: Record<string, unknown>) {
  let s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 60 } } }).jpeg({ quality: 85 });
  if (exif) s = s.withExif(exif as never);
  return s.toBuffer();
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mn-cli-test-'));
  await mkdir(path.join(dir, '2025 trip'), { recursive: true });
  await writeFile(path.join(dir, '2025 trip', 'IMG_0001.jpg'), await photo(2400, 1800, { IFD0: { Make: 'Apple', Model: 'iPhone 15' }, IFD2: { DateTimeOriginal: '2025:06:12 14:05:00', OffsetTimeOriginal: '+02:00' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55.6761', GPSLongitudeRef: 'E', GPSLongitude: '12.5683' } }));
  await writeFile(path.join(dir, 'noexif.jpg'), await photo(1000, 1500));
  await writeFile(path.join(dir, 'notes.txt'), 'ignore me');
  await writeFile(path.join(dir, '.hidden.jpg'), await photo(10, 10));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('folder scan → manifest', () => {
  it('walks supported files only, with stable relative ids', async () => {
    const files = await walk(dir);
    expect(files.map((f) => f.rel)).toEqual(['2025 trip/IMG_0001.jpg', 'noexif.jpg']);
    expect(files[0]!.mime).toBe('image/jpeg');
    expect((await walk(dir, new Set(['png']))).length).toBe(0);
  });
  it('builds a valid ManifestItem from EXIF (time with offset, GPS, oriented dimensions, album from folder)', async () => {
    const [f] = await walk(dir);
    const md5 = await hashFile(f!.abs, 'md5');
    const item = toManifestItem(f!, md5, await probeFile(f!));
    expect(() => ManifestItem.parse(item)).not.toThrow();
    expect(item.createdAt).toBe('2025-06-12T12:05:00.000Z');
    expect(item.gps?.lat).toBeCloseTo(55.6761, 3);
    expect(item.w).toBe(2400); expect(item.h).toBe(1800);
    expect(item.albums).toEqual(['2025 trip']);
    expect(item.localId).toBe('2025 trip/IMG_0001.jpg');
    expect(md5).toMatch(/^[a-f0-9]{32}$/);
  });
  it('falls back to mtime and flags it when there is no EXIF date', async () => {
    const f = (await walk(dir)).find((x) => x.rel === 'noexif.jpg')!;
    const p = await probeFile(f);
    expect(p.fromExif).toBe(false);
    expect(p.createdAt.getTime()).toBe(f.mtime.getTime());
    expect(p.w).toBe(1000); expect(p.h).toBe(1500);
  });
});

describe('preview generator', () => {
  it('produces a ≤ 1600 px JPEG that keeps EXIF and never enlarges', async () => {
    const [big] = await walk(dir);
    const prev = await makePreview(big!.abs);
    const m = await sharp(prev).metadata();
    expect(m.format).toBe('jpeg'); expect(Math.max(m.width!, m.height!)).toBe(1600);
    expect(m.exif).toBeTruthy();
    const small = await makePreview(path.join(dir, 'noexif.jpg'));
    const ms = await sharp(small).metadata();
    expect(ms.height).toBe(1500);
  });
});

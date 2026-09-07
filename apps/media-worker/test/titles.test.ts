import { describe, it, expect } from 'vitest';
import { autoTitle, cleanTag } from '../src/jobs/titles.js';
import { resolveCapture } from '../src/jobs/derive.js';
import { classifyPair } from '../src/jobs/dedupe.js';
import { looksLikeScreenshot } from '../src/metadata.js';

const base = { startAt: new Date('2026-03-13T20:30:00Z'), endAt: new Date('2026-03-14T02:00:00Z'), tz: 'Europe/Oslo', participants: [], placeName: null, city: null, tags: [] };

describe('autoTitle rule order (§9.10)', () => {
  it('birthday beats everything', () => {
    expect(autoTitle({ ...base, participants: [{ name: 'Emma', birthday: '1995-03-14' }], placeName: 'Blå' })).toBe("Emma's birthday");
    expect(autoTitle({ ...base, participants: [{ name: 'Emma', birthday: '1995-07-01' }], placeName: 'Blå' })).not.toContain('birthday');
  });
  it('named place next', () => {
    expect(autoTitle({ ...base, placeName: 'Blå' })).toBe('Blå, Friday evening');
  });
  it('dominant tag with coverage', () => {
    const tags = Array.from({ length: 10 }, (_, i) => (i < 5 ? [{ tag: 'a beach', score: 0.7 }] : [{ tag: 'a beach', score: 0.3 }]));
    expect(autoTitle({ ...base, city: 'Oslo', tags })).toBe('Beach in Oslo');
    const weak = Array.from({ length: 10 }, (_, i) => (i < 3 ? [{ tag: 'a beach', score: 0.7 }] : []));
    expect(autoTitle({ ...base, city: 'Oslo', tags: weak })).toBe('Friday evening — Oslo');
  });
  it('fallback without city', () => {
    expect(autoTitle({ ...base, startAt: new Date('2026-03-14T02:30:00Z') })).toBe('Saturday night');
  });
  it('cleans tag prompts', () => {
    expect(cleanTag('a photo of food')).toBe('food');
    expect(cleanTag('a concert')).toBe('concert');
  });
});

describe('resolveCapture (§8.2)', () => {
  const up = new Date('2026-04-01T00:00:00Z');
  it('prefers EXIF with an explicit offset', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-14T20:30:00Z'), capturedTz: '+01:00', exifHasOffset: true }, new Date('2026-03-14T20:30:05Z'), up, false, false);
    expect(r.capturedAt.toISOString()).toBe('2026-03-14T20:30:00.000Z'); expect(r.tz).toBe('+01:00'); expect(r.uncertain).toBe(false);
  });
  it('uses the OS timestamp and infers the zone when EXIF has no offset', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-14T21:30:00Z'), capturedTz: null, exifHasOffset: false }, new Date('2026-03-14T20:30:00Z'), up, false, false);
    expect(r.capturedAt.toISOString()).toBe('2026-03-14T20:30:00.000Z'); expect(r.tz).toBe('+01:00'); expect(r.uncertain).toBe(false);
  });
  it('flags received media (no EXIF) as time-uncertain, but not screenshots or videos', () => {
    const none = { capturedAt: null, capturedTz: null, exifHasOffset: false };
    expect(resolveCapture(none, new Date('2026-03-14T20:30:00Z'), up, false, false).uncertain).toBe(true);
    expect(resolveCapture(none, new Date('2026-03-14T20:30:00Z'), up, true, false).uncertain).toBe(false);
    expect(resolveCapture(none, new Date('2026-03-14T20:30:00Z'), up, false, true).uncertain).toBe(false);
  });
  it('flags a > 24 h disagreement and stores the raw EXIF instant (clock offset is applied by recluster)', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-10T20:30:00Z'), capturedTz: '+01:00', exifHasOffset: true }, new Date('2026-03-14T20:30:00Z'), up, false, false);
    expect(r.uncertain).toBe(true); expect(r.capturedAt.toISOString()).toBe('2026-03-10T20:30:00.000Z');
  });
});

describe('classifyPair (§14)', () => {
  const row = (phash: string, o: Partial<Parameters<typeof classifyPair>[0]> = {}) => ({ id: 'x', phash, width: 4000, height: 3000, sizeBytes: 1000, capturedAt: new Date('2026-03-14T20:30:00Z'), exif: { DateTimeOriginal: 'x' }, nearDupGroupId: null, variantOf: null, ...o });
  const h = '1010'.repeat(16);
  const flip = (s: string, n: number) => s.slice(0, n).split('').map((c) => (c === '1' ? '0' : '1')).join('') + s.slice(n);
  it('re-encoded copy: tiny distance, same aspect, one side without EXIF', () => {
    expect(classifyPair(row(h), row(flip(h, 3), { width: 1280, height: 960, exif: null, capturedAt: new Date('2026-03-20T00:00:00Z') }), false)).toBe('reencoded');
  });
  it('burst: same owner, seconds apart, moderate distance', () => {
    expect(classifyPair(row(h), row(flip(h, 8), { capturedAt: new Date('2026-03-14T20:30:04Z') }), true)).toBe('burst');
    expect(classifyPair(row(h), row(flip(h, 8), { capturedAt: new Date('2026-03-14T20:30:04Z') }), false)).toBeNull();
  });
  it('unrelated', () => {
    expect(classifyPair(row(h), row(flip(h, 20)), true)).toBeNull();
  });
});

describe('looksLikeScreenshot', () => {
  const m = (o: Partial<Parameters<typeof looksLikeScreenshot>[0]>) => ({ width: 4000, height: 3000, format: 'jpeg', exif: null, capturedAt: null, capturedTz: null, exifHasOffset: false, lat: null, lon: null, cameraMake: null, cameraModel: null, orientation: 1, ...o });
  it('png without camera, phone screen sizes', () => {
    expect(looksLikeScreenshot(m({ format: 'png' }))).toBe(true);
    expect(looksLikeScreenshot(m({ width: 1179, height: 2556 }))).toBe(true);
    expect(looksLikeScreenshot(m({ width: 1179, height: 2556, cameraMake: 'Apple' }))).toBe(false);
    expect(looksLikeScreenshot(m({}))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { autoTitle, autoTitles, cleanTag, listNames, voteTags, dominantTag, interestScore, routineScore } from '../src/jobs/titles.js';
import { resolveCapture, bestOrigin } from '../src/jobs/derive.js';
import { classifyPair } from '../src/jobs/dedupe.js';
import { looksLikeScreenshot } from '../src/metadata.js';

const base = { startAt: new Date('2026-03-13T20:30:00Z'), endAt: new Date('2026-03-14T02:00:00Z'), tz: 'Europe/Oslo', participants: [], placeName: null, city: null, tags: [] };
const person = (name: string | null, birthday: string | null = null, userId: string | null = null) => ({ name, birthday, userId });
/** n assets, the first `present` of them carrying `tag` at a present score. */
const tagged = (n: number, present: number, tag: string, cat: string, score = 0.8) => Array.from({ length: n }, (_, i) => (i < present ? [{ tag, cat, score }] : [{ tag, cat, score: 0.3 }]));

describe('autoTitle rule order (§9.10)', () => {
  it('birthday beats everything', () => {
    expect(autoTitle({ ...base, participants: [person('Emma', '1995-03-14')], placeName: 'Blå' })).toBe("Emma's birthday");
    expect(autoTitle({ ...base, participants: [person('Emma', '1995-07-01')], placeName: 'Blå' })).not.toContain('birthday');
  });
  it('activity with names', () => {
    const tags = tagged(10, 5, 'frisbee golf', 'activity');
    expect(autoTitle({ ...base, tags, participants: [person('Mikkel'), person('Stefan'), person('Åsmul')] })).toBe('Frisbee golf with Mikkel, Stefan and Åsmul');
    expect(autoTitle({ ...base, tags, participants: [person('Mikkel'), person(null)] })).toBe('Frisbee golf with Mikkel');
  });
  it('activity beats scene, scene beats objects', () => {
    const tags = Array.from({ length: 10 }, () => [{ tag: 'beer', cat: 'drink', score: 0.9 }, { tag: 'beach', cat: 'scene', score: 0.8 }, { tag: 'swimming', cat: 'activity', score: 0.7 }]);
    expect(autoTitle({ ...base, tags, city: 'Oslo' })).toBe('Swimming in Oslo');
    const noActivity = tags.map((t) => t.filter((x) => x.cat !== 'activity'));
    expect(autoTitle({ ...base, tags: noActivity, city: 'Oslo' })).toBe('Beach — Oslo');
  });
  it('named place with names, then place alone', () => {
    expect(autoTitle({ ...base, placeName: 'Blå', participants: [person('Stefan')] })).toBe('Blå with Stefan');
    expect(autoTitle({ ...base, placeName: 'Blå' })).toBe('Blå, Friday evening');
  });
  it('needs coverage, not one lucky photo', () => {
    const weak = tagged(10, 3, 'beach', 'scene');
    expect(autoTitle({ ...base, city: 'Oslo', tags: weak })).toBe('Friday evening — Oslo');
  });
  it('mundane, people and utility tags never name an event', () => {
    const tags = Array.from({ length: 6 }, () => [{ tag: 'computer screen', cat: 'mundane', score: 0.95 }, { tag: 'selfie', cat: 'people', score: 0.9 }, { tag: 'screenshot', cat: 'utility', score: 0.9 }]);
    expect(autoTitle({ ...base, tags })).toBe('Friday evening');
  });
  it('names alone, then the fallback', () => {
    expect(autoTitle({ ...base, participants: [person('Stefan'), person('Åsmul')] })).toBe('Friday evening with Stefan and Åsmul');
    expect(autoTitle({ ...base, startAt: new Date('2026-03-14T02:30:00Z') })).toBe('Saturday night');
  });
  it('legacy prompt-style tags still work', () => {
    const tags = Array.from({ length: 10 }, (_, i) => (i < 5 ? [{ tag: 'a beach', score: 0.7 }] : [{ tag: 'a beach', score: 0.3 }]));
    expect(autoTitle({ ...base, city: 'Oslo', tags })).toBe('Beach in Oslo');
  });
  it('lists names', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 others');
    expect(listNames(['A', 'B', 'C', 'D', 'E'], 'nb')).toBe('A, B, C og 2 andre');
    expect(listNames(['A', 'B', 'C', 'D'], 'nb')).toBe('A, B, C og 1 annen');
    expect(cleanTag('a photo of food')).toBe('food');
  });
  it('speaks Norwegian with the same rule order', () => {
    const tags = tagged(10, 5, 'frisbee golf', 'activity');
    expect(autoTitle({ ...base, tags, participants: [person('Mikkel'), person('Stefan'), person('Åsmul')] }, 'nb')).toBe('Frisbeegolf med Mikkel, Stefan og Åsmul');
    expect(autoTitle({ ...base, participants: [person('Emma', '1995-03-14')], placeName: 'Blå' }, 'nb')).toBe('Emmas bursdag');
    expect(autoTitle({ ...base, participants: [person('Anders', '1995-03-14')] }, 'nb')).toBe("Anders' bursdag");
    expect(autoTitle({ ...base, placeName: 'Blå', participants: [person('Stefan')] }, 'nb')).toBe('Blå med Stefan');
    expect(autoTitle({ ...base, placeName: 'Blå' }, 'nb')).toBe('Blå, fredag kveld');
    expect(autoTitle({ ...base, participants: [person('Stefan'), person('Åsmul')] }, 'nb')).toBe('Fredag kveld med Stefan og Åsmul');
    expect(autoTitle({ ...base, startAt: new Date('2026-03-14T02:30:00Z') }, 'nb')).toBe('Lørdag natt');
    const legacy = Array.from({ length: 10 }, (_, i) => (i < 5 ? [{ tag: 'a beach', score: 0.7 }] : [{ tag: 'a beach', score: 0.3 }]));
    expect(autoTitle({ ...base, city: 'Oslo', tags: legacy }, 'nb')).toBe('Strand i Oslo');
    expect(autoTitles({ ...base, city: 'Oslo' })).toEqual({ nb: 'Fredag kveld — Oslo', en: 'Friday evening — Oslo' });
  });
});

describe('tag votes', () => {
  it('coverage counts each tag once per asset and ignores absent scores', () => {
    const votes = voteTags([[{ tag: 'beer', cat: 'drink', score: 0.9 }, { tag: 'beer', cat: 'drink', score: 0.8 }], [{ tag: 'beer', cat: 'drink', score: 0.2 }], []]);
    expect(votes).toEqual([{ tag: 'beer', cat: 'drink', coverage: 1 / 3, meanScore: 0.9 }]);
    expect(dominantTag(votes)).toBeNull();
    expect(dominantTag(votes, 0.3)?.tag).toBe('beer');
  });
});

describe('interest (§9.11)', () => {
  const ev = { nAssets: 12, nVideos: 0, hours: 2, others: 0, facesPerAsset: 0, contributors: 1, votes: [], placeNamed: false, routine: 0, manual: null as -1 | 1 | null };
  it('friends doing something specific rank high', () => {
    const s = interestScore({ ...ev, others: 2, facesPerAsset: 1.5, votes: [{ tag: 'frisbee golf', cat: 'activity', coverage: 0.7, meanScore: 0.8 }] });
    expect(s).toBeGreaterThan(0.55);
  });
  it('solo studio videos at a routine place fold away', () => {
    const s = interestScore({ ...ev, nAssets: 6, nVideos: 6, facesPerAsset: 1, routine: 0.8, votes: [{ tag: 'playing guitar', cat: 'activity', coverage: 1, meanScore: 0.9 }, { tag: 'computer screen', cat: 'mundane', coverage: 0.8, meanScore: 0.9 }] });
    expect(s).toBeLessThan(0.3);
  });
  it('a solo hike stays visible', () => {
    const s = interestScore({ ...ev, nAssets: 20, hours: 3, votes: [{ tag: 'hiking', cat: 'activity', coverage: 0.6, meanScore: 0.8 }] });
    expect(s).toBeGreaterThanOrEqual(0.3);
  });
  it('manual overrides win', () => {
    expect(interestScore({ ...ev, routine: 1, manual: 1 })).toBe(0.9);
    expect(interestScore({ ...ev, others: 3, facesPerAsset: 2, manual: -1 })).toBe(0.1);
  });
  it('routine grows with lonely repeat visits and reacts to feedback', () => {
    expect(routineScore({ nEvents: 1, avgOthers: 0, multiContribFraction: 0, demoted: 0, promoted: 0 })).toBe(0);
    expect(routineScore({ nEvents: 12, avgOthers: 0, multiContribFraction: 0, demoted: 0, promoted: 0 })).toBe(1);
    expect(routineScore({ nEvents: 12, avgOthers: 2, multiContribFraction: 0, demoted: 0, promoted: 0 })).toBe(0);
    expect(routineScore({ nEvents: 6, avgOthers: 0, multiContribFraction: 0, demoted: 3, promoted: 0 })).toBeGreaterThan(routineScore({ nEvents: 6, avgOthers: 0, multiContribFraction: 0, demoted: 0, promoted: 0 }));
    expect(routineScore({ nEvents: 12, avgOthers: 0, multiContribFraction: 0, demoted: 0, promoted: 6 })).toBeLessThan(1);
  });
});

describe('resolveCapture (§8.2)', () => {
  const up = new Date('2026-04-01T00:00:00Z');
  it('prefers EXIF with an explicit offset', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-14T20:30:00Z'), capturedTz: '+01:00', exifHasOffset: true }, new Date('2026-03-14T20:30:05Z'), up, 'received');
    expect(r.capturedAt.toISOString()).toBe('2026-03-14T20:30:00.000Z'); expect(r.tz).toBe('+01:00'); expect(r.uncertain).toBe(false);
  });
  it('uses the OS timestamp and infers the zone when EXIF has no offset', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-14T21:30:00Z'), capturedTz: null, exifHasOffset: false }, new Date('2026-03-14T20:30:00Z'), up, 'camera');
    expect(r.capturedAt.toISOString()).toBe('2026-03-14T20:30:00.000Z'); expect(r.tz).toBe('+01:00'); expect(r.uncertain).toBe(false);
  });
  it('without EXIF, trust follows provenance (§7.4): camera files are dated by the OS, everything else is uncertain', () => {
    const none = { capturedAt: null, capturedTz: null, exifHasOffset: false };
    const os = new Date('2026-03-14T20:30:00Z');
    expect(resolveCapture(none, os, up, 'camera').uncertain).toBe(false);
    expect(resolveCapture(none, os, up, 'received').uncertain).toBe(true);
    expect(resolveCapture(none, os, up, 'unknown').uncertain).toBe(true);
    expect(resolveCapture(none, os, up, 'screenshot').uncertain).toBe(true);
    expect(resolveCapture(none, null, up, 'camera').uncertain).toBe(true);   // nothing but the upload time
    // an EXIF wall clock without offset on a received file (AirDrop keeps EXIF) still dates it, but does not make it trusted
    expect(resolveCapture({ capturedAt: new Date('2026-03-14T21:30:00Z'), capturedTz: null, exifHasOffset: false }, os, up, 'received').uncertain).toBe(true);
  });
  it('bestOrigin: the best-graded copy of a blob decides', () => {
    expect(bestOrigin(['received', 'camera'])).toBe('camera');
    expect(bestOrigin(['screenshot', 'received'])).toBe('received');
    expect(bestOrigin([])).toBe('unknown');
  });
  it('flags a > 24 h disagreement and stores the raw EXIF instant (clock offset is applied by recluster)', () => {
    const r = resolveCapture({ capturedAt: new Date('2026-03-10T20:30:00Z'), capturedTz: '+01:00', exifHasOffset: true }, new Date('2026-03-14T20:30:00Z'), up, 'camera');
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

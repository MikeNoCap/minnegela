import { describe, it, expect } from 'vitest';
import { applyRules, looksLikeScreenshot } from '@/sync/rules';
import { defaultSettings } from '@/store/settings';

const base = { albumIds: ['a1'], isScreenshot: false, createdAt: '2026-03-14T20:00:00.000Z', filename: 'IMG_0001.jpg', mime: 'image/jpeg', w: 4000, h: 3000 };
const rules = defaultSettings().rules;

describe('library rules (§16.5)', () => {
  it('keeps an ordinary photo', () => expect(applyRules(base, rules)).toEqual({ excluded: false }));
  it('excludes by album', () => expect(applyRules(base, { ...rules, excludedAlbumIds: ['a1'] })).toEqual({ excluded: true, reason: 'album' }));
  it('excludes screenshots by OS subtype, filename, or phone-shaped PNG', () => {
    expect(looksLikeScreenshot({ ...base, isScreenshot: true })).toBe(true);
    expect(looksLikeScreenshot({ ...base, filename: 'Screenshot_20260314-2000.png' })).toBe(true);
    expect(looksLikeScreenshot({ ...base, mime: 'image/png', w: 1179, h: 2556 })).toBe(true);
    expect(looksLikeScreenshot({ ...base, mime: 'image/png', w: 1600, h: 1200 })).toBe(false);
    expect(applyRules({ ...base, isScreenshot: true }, rules)).toEqual({ excluded: true, reason: 'screenshot' });
    expect(applyRules({ ...base, isScreenshot: true }, { ...rules, excludeScreenshots: false })).toEqual({ excluded: false });
  });
  it('excludes photos before the since date', () => {
    expect(applyRules(base, { ...rules, sinceDate: '2026-04-01' })).toEqual({ excluded: true, reason: 'before_since' });
    expect(applyRules(base, { ...rules, sinceDate: '2026-01-01' })).toEqual({ excluded: false });
  });
});

import type { Settings } from '@/store/settings';

export type RuleInput = { albumIds: string[]; isScreenshot: boolean; createdAt: string; filename: string; mime: string; w: number | null; h: number | null };
export type RuleResult = { excluded: false } | { excluded: true; reason: 'album' | 'screenshot' | 'before_since' };

/** Screenshot heuristic when the OS does not label it: PNG with a phone-shaped aspect or a telltale filename. */
export function looksLikeScreenshot(a: Pick<RuleInput, 'isScreenshot' | 'filename' | 'mime' | 'w' | 'h'>): boolean {
  if (a.isScreenshot) return true;
  if (/^screenshot/i.test(a.filename) || /^Screen(shot|_Recording)/i.test(a.filename)) return true;
  if (a.mime === 'image/png' && a.w && a.h) {
    const ratio = Math.max(a.w, a.h) / Math.min(a.w, a.h);
    if (ratio > 1.9 && ratio < 2.35) return true;   // 19.5:9 .. 21:9 phone screens
  }
  return false;
}

/** §16.5 library rules, applied at enumeration time. Pure. */
export function applyRules(a: RuleInput, rules: Settings['rules']): RuleResult {
  if (rules.excludedAlbumIds.length && a.albumIds.some((id) => rules.excludedAlbumIds.includes(id))) return { excluded: true, reason: 'album' };
  if (rules.excludeScreenshots && looksLikeScreenshot(a)) return { excluded: true, reason: 'screenshot' };
  if (rules.sinceDate && Date.parse(a.createdAt) < Date.parse(rules.sinceDate)) return { excluded: true, reason: 'before_since' };
  return { excluded: false };
}

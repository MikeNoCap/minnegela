import { describe, it, expect } from 'vitest';
import { layoutBraid, buildRows, gapPx, nodeRadius, strandX, strandCounts, BUNDLE_STEP } from './layout';
import type { TimelineEvent } from '@/lib/types';

const ev = (id: string, startAt: string, endAt: string, people: number[], extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, kind: 'event', title: id, startAt, endAt, center: null, placeName: null, city: 'Asker', contributorIds: ['u1'], personIds: people,
  nAssets: 10, nVideos: 0, coverBlobId: null, isPublicToGroup: false, interest: null, ...extra,
});
const loose = (id: string, startAt: string, n: number): TimelineEvent => ({ ...ev(id, startAt, startAt, []), kind: 'loose', nAssets: n });
const opts = { strands: ['1', '2', '3'], membersOf: (e: TimelineEvent) => e.personIds.map(String), monthLabel: (s: string) => s.slice(0, 7), yearLabel: (s: string) => s.slice(0, 4) };

describe('braid layout', () => {
  it('orders rows newest first and folds loose days into quiet runs between events', () => {
    const rows = buildRows([
      loose('l1', '2026-03-14T10:00:00Z', 3), ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [1, 2]), loose('l2', '2026-03-14T18:00:00Z', 2),
      loose('l3', '2026-03-12T18:00:00Z', 1), ev('b', '2026-03-10T20:00:00Z', '2026-03-10T22:00:00Z', [1]), loose('l4', '2026-03-09T18:00:00Z', 4), loose('l5', '2026-03-18T18:00:00Z', 1),
    ], opts.membersOf, opts.strands);
    expect(rows.map((r) => r.key)).toEqual(['loose-2026-03-18', 'a', 'loose-2026-03-14', 'b', 'loose-2026-03-09']);
    expect(rows[2]).toMatchObject({ kind: 'loose', n: 6, startAt: '2026-03-14T18:00:00Z', endAt: '2026-03-12T18:00:00Z', days: [{ day: '2026-03-14', n: 5, ids: ['l2', 'l1'] }, { day: '2026-03-12', n: 1, ids: ['l3'] }] });
    expect(rows.map((r) => r.y)).toEqual([...rows.map((r) => r.y)].sort((x, y) => x - y));
  });

  it('keeps members in lane order so bundles never cross', () => {
    const rows = buildRows([ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [3, 1])], opts.membersOf, opts.strands);
    expect(rows[0]!.members).toEqual(['1', '3']);
  });

  it('places strands in their lane or inside the knot', () => {
    const rows = buildRows([ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [1, 2])], opts.membersOf, opts.strands);
    const nodeX = 200;
    expect(strandX(nodeX, 50, rows[0]!, '3')).toBe(50);
    expect(strandX(nodeX, 50, rows[0]!, '1')).toBe(nodeX - BUNDLE_STEP / 2);
    expect(strandX(nodeX, 50, rows[0]!, '2')).toBe(nodeX + BUNDLE_STEP / 2);
  });

  it('compresses gaps and dashes the long ones', () => {
    expect(gapPx(0)).toBe(0);
    expect(gapPx(3_600_000 * 6)).toBeLessThan(gapPx(86_400_000 * 30));
    expect(gapPx(86_400_000 * 365 * 3)).toBe(110);
    const l = layoutBraid([ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [1]), ev('b', '2026-01-01T20:00:00Z', '2026-01-01T23:00:00Z', [1, 2]), ev('c', '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z', [2])], opts);
    const ab = l.segments.filter((s) => s.y0 < l.rows[1]!.y), bc = l.segments.filter((s) => s.y0 > l.rows[1]!.y);
    expect(ab.every((s) => s.dashed)).toBe(true);
    expect(bc.every((s) => !s.dashed)).toBe(true);
    expect(l.segments).toHaveLength(opts.strands.length * 2);
    expect(l.height).toBeGreaterThan(l.rows[2]!.y);
  });

  it('marks years and months and finds away-from-home chapters', () => {
    const l = layoutBraid([
      ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [1]),
      ev('b', '2026-02-14T20:00:00Z', '2026-02-14T23:00:00Z', [1], { city: 'København' }),
      ev('b2', '2026-02-14T14:00:00Z', '2026-02-14T16:00:00Z', [1], { city: null }),
      ev('c', '2026-02-13T10:00:00Z', '2026-02-13T12:00:00Z', [2], { city: 'København' }),
      ev('c2', '2026-02-12T10:00:00Z', '2026-02-12T12:00:00Z', [2], { city: null }),
      ev('c3', '2026-02-05T10:00:00Z', '2026-02-05T12:00:00Z', [2], { city: null }),
      ev('d', '2025-12-31T10:00:00Z', '2025-12-31T12:00:00Z', [2]),
      ev('e', '2025-06-01T10:00:00Z', '2025-06-01T12:00:00Z', [2], { city: 'Bergen' }),
    ], opts);
    expect(l.markers.map((m) => [m.kind, m.key])).toEqual([['year', '2026'], ['month', '2026-02'], ['year', '2025'], ['month', '2025-06']]);
    expect(l.homeCity).toBe('Asker');
    expect(l.chapters).toHaveLength(1);
    expect(l.chapters[0]).toMatchObject({ city: 'København', n: 4, from: '2026-02-12T10:00:00Z', to: '2026-02-14T23:00:00Z' });
  });

  it('sizes nodes by photo count within bounds', () => {
    expect(nodeRadius(1)).toBe(13);
    expect(nodeRadius(10_000)).toBeLessThanOrEqual(26);
  });

  it('counts strands over real events only', () => {
    const c = strandCounts([ev('a', '2026-03-15T20:00:00Z', '2026-03-16T01:00:00Z', [1, 2]), loose('l', '2026-03-14T10:00:00Z', 3)], opts.membersOf);
    expect([...c.entries()]).toEqual([['1', 1], ['2', 1]]);
  });
});

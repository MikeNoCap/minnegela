/**
 * Layout for the braid timeline: people are strands running down vertical lanes; every event is a knot where the
 * strands of the people who were there swing into the node column and out again. Pure functions, no DOM, so the
 * geometry is testable and the components only draw.
 */
import type { TimelineEvent } from '@/lib/types';

export type StrandKey = string;

export const LANE = 14;          // px between strand lanes
export const GUTTER = 72;        // left gutter for month / year labels
export const CHAPTER_W = 12;     // the bracket for away-from-home chapters
export const NODE_GAP = 22;      // distance from the last lane to the node column
export const BUNDLE_STEP = 3;    // px between strands inside a knot
export const ROW_MIN = 60;       // px per event row
export const LOOSE_ROW = 30;     // px per loose-photos row
export const DASH_AFTER_MS = 14 * 86_400_000;

export type EventRow = { kind: 'event'; key: string; ev: TimelineEvent; y: number; h: number; r: number; members: StrandKey[]; index: number };
export type LooseDay = { day: string; n: number; ids: string[] };
/** A run of consecutive loose-photo days with no event in between: one quiet row, expandable into its days. */
export type LooseRow = { kind: 'loose'; key: string; days: LooseDay[]; n: number; startAt: string; endAt: string; y: number; h: number; r: number; members: StrandKey[]; index: number };
export type Row = EventRow | LooseRow;

export type Segment = { strand: StrandKey; d: string; dashed: boolean; y0: number; y1: number; joins: boolean };
export type Marker = { y: number; label: string; kind: 'year' | 'month'; key: string };
export type Chapter = { y0: number; y1: number; city: string; n: number; from: string; to: string };

export type Layout = {
  rows: Row[]; segments: Segment[]; markers: Marker[]; chapters: Chapter[];
  height: number; nodeX: number; braidWidth: number; laneX: (i: number) => number; homeCity: string | null;
};

export type LayoutOptions = {
  strands: StrandKey[];                       // lane order
  membersOf: (ev: TimelineEvent) => StrandKey[];
  monthLabel: (iso: string) => string;
  yearLabel: (iso: string) => string;
  extra?: (row: Row) => number;               // extra height under a row (an expanded day)
  gutter?: number;                            // narrower on phones
};

export const nodeRadius = (nAssets: number) => Math.round(Math.min(26, 13 + Math.log2(Math.max(1, nAssets)) * 1.6));

/** Extra vertical breathing room for a gap in time, compressed so a quiet month does not become a wall of nothing. */
export const gapPx = (ms: number) => { const h = Math.max(0, ms) / 3_600_000; return Math.round(Math.min(110, 26 * Math.log2(1 + h / 12))); };

const laneXAt = (gutter: number) => (i: number) => gutter + CHAPTER_W + LANE / 2 + i * LANE;

/** Where a strand sits at a row: its lane, or its slot inside the knot. */
export function strandX(nodeX: number, laneX: number, row: Row, strand: StrandKey): number {
  const k = row.members.indexOf(strand);
  if (k < 0) return laneX;
  return nodeX + (k - (row.members.length - 1) / 2) * BUNDLE_STEP;
}

function curve(x0: number, y0: number, x1: number, y1: number, ya: number, yb: number): string {
  if (x0 === x1) return `M${x0},${y0}V${y1}`;
  const m = (ya + yb) / 2;
  return `M${x0},${y0}V${ya}C${x0},${m} ${x1},${m} ${x1},${yb}V${y1}`;
}

/** Fold loose-photo days into quiet runs between events and keep everything newest first. */
export function buildRows(events: TimelineEvent[], membersOf: (ev: TimelineEvent) => StrandKey[], strands: StrandKey[], extra?: (row: Row) => number): Row[] {
  const lanes = new Set(strands);
  const out: Row[] = [];
  const sorted = [...events].sort((a, b) => (a.startAt < b.startAt ? 1 : a.startAt > b.startAt ? -1 : 0));
  for (const ev of sorted) {
    if (ev.kind === 'loose') {
      const day = ev.startAt.slice(0, 10);
      const last = out[out.length - 1];
      if (last && last.kind === 'loose') {
        const d = last.days[last.days.length - 1]!;
        if (d.day === day) { d.n += ev.nAssets; d.ids.push(ev.id); }
        else last.days.push({ day, n: ev.nAssets, ids: [ev.id] });
        last.n += ev.nAssets; last.endAt = ev.startAt;
        continue;
      }
      out.push({ kind: 'loose', key: `loose-${day}`, days: [{ day, n: ev.nAssets, ids: [ev.id] }], n: ev.nAssets, startAt: ev.startAt, endAt: ev.startAt, y: 0, h: LOOSE_ROW, r: 4, members: [], index: 0 });
    } else {
      const r = nodeRadius(ev.nAssets);
      // strands in lane order so the bundle never crosses itself
      const members = strands.filter((s) => lanes.has(s) && membersOf(ev).includes(s));
      out.push({ kind: 'event', key: ev.id, ev, y: 0, h: Math.max(ROW_MIN, 2 * r + 14), r, members, index: 0 });
    }
  }
  let y = 12;
  let prev: Row | null = null;
  out.forEach((row, i) => {
    if (prev) y += gapPx(new Date(rowOldest(prev)).getTime() - new Date(rowNewest(row)).getTime());
    row.index = i;
    row.y = y + row.h / 2;
    y += row.h + (extra?.(row) ?? 0);
    prev = row;
  });
  return out;
}

export const rowStart = (row: Row) => (row.kind === 'event' ? row.ev.startAt : row.startAt);
/** Rows run newest first: an event's newest edge is its end, a quiet run's is its newest day. */
export const rowNewest = (row: Row) => (row.kind === 'event' ? row.ev.endAt : row.startAt);
export const rowOldest = (row: Row) => (row.kind === 'event' ? row.ev.startAt : row.endAt);
/** The quiet run that holds a given day, if any. */
export const runWithDay = (rows: Row[], day: string) => rows.find((r): r is LooseRow => r.kind === 'loose' && r.days.some((d) => d.day === day));

export function layoutBraid(events: TimelineEvent[], o: LayoutOptions): Layout {
  const rows = buildRows(events, o.membersOf, o.strands, o.extra);
  const laneXFor = laneXAt(o.gutter ?? GUTTER);
  const nodeX = laneXFor(Math.max(0, o.strands.length - 1)) + NODE_GAP + (o.strands.length ? 0 : LANE);
  const braidWidth = nodeX + 30;
  const laneIndex = new Map(o.strands.map((s, i) => [s, i]));

  const segments: Segment[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i]!, b = rows[i + 1]!;
    const dashed = new Date(rowOldest(a)).getTime() - new Date(rowNewest(b)).getTime() > DASH_AFTER_MS;
    for (const s of o.strands) {
      const li = laneIndex.get(s)!;
      const x0 = strandX(nodeX, laneXFor(li), a, s), x1 = strandX(nodeX, laneXFor(li), b, s);
      const inA = a.members.includes(s), inB = b.members.includes(s);
      const y0 = a.y + (inA ? a.r : 0), y1 = b.y - (inB ? b.r : 0);
      const room = Math.max(8, y1 - y0);
      const B = Math.min(34, room * 0.6);
      let ya: number, yb: number;
      if (inA && inB) { ya = (y0 + y1) / 2 - B / 2; yb = ya + B; }
      else if (inA) { ya = y0 + 2; yb = ya + B; }
      else if (inB) { yb = y1 - 2; ya = yb - B; }
      else { ya = (y0 + y1) / 2 - B / 2; yb = ya + B; }
      segments.push({ strand: s, d: curve(x0, y0, x1, y1, ya, yb), dashed, y0, y1, joins: inA || inB });
    }
  }

  const markers: Marker[] = [];
  let lastMonth = '', lastYear = '';
  for (const row of rows) {
    const iso = rowStart(row);
    const ym = iso.slice(0, 7), yy = iso.slice(0, 4);
    if (yy !== lastYear) { markers.push({ y: row.y, label: o.yearLabel(iso), kind: 'year', key: yy }); lastYear = yy; lastMonth = ym; continue; }
    if (ym !== lastMonth) { markers.push({ y: row.y, label: o.monthLabel(iso), kind: 'month', key: ym }); lastMonth = ym; }
  }

  const homeCity = mostCommon(events.filter((e) => e.kind !== 'loose').map((e) => e.city));
  // away-from-home chapters: runs of events in one other city; events with no known city ride along within a day, or if the run resumes
  const chapters: Chapter[] = [];
  let cur: (Chapter & { rows: EventRow[] }) | null = null;
  let pending: EventRow[] = [];
  const flush = () => {
    if (cur && (cur.rows.length >= 2 || cur.rows.some((r) => new Date(r.ev.endAt).getTime() - new Date(r.ev.startAt).getTime() > 20 * 3_600_000))) {
      const { rows: rs, ...c } = cur; chapters.push({ ...c, n: rs.length });
    }
    cur = null; pending = [];
  };
  const add = (c: Chapter & { rows: EventRow[] }, row: EventRow) => { c.rows.push(row); c.y1 = row.y + row.r; c.from = row.ev.startAt; };
  for (const row of rows) {
    if (row.kind !== 'event') continue; // quiet runs neither break nor make a chapter
    const city = row.ev.city;
    if (!city) {
      // no known city: still part of the trip if it happened within a day of it, otherwise only if the trip resumes
      if (cur && new Date(cur.from).getTime() - new Date(row.ev.endAt).getTime() <= 24 * 3_600_000) add(cur, row);
      else if (cur) pending.push(row);
      continue;
    }
    if (homeCity && city !== homeCity) {
      if (cur && cur.city === city) { for (const p of pending) add(cur, p); pending = []; add(cur, row); }
      else { flush(); cur = { city, y0: row.y - row.r, y1: row.y + row.r, n: 1, from: row.ev.startAt, to: row.ev.endAt, rows: [row] }; }
    } else flush();
  }
  flush();

  const last = rows[rows.length - 1];
  const height = last ? last.y + last.h / 2 + (o.extra?.(last) ?? 0) + 24 : 0;
  return { rows, segments, markers, chapters, height, nodeX, braidWidth, laneX: laneXFor, homeCity };
}

function mostCommon(xs: Array<string | null>): string | null {
  const c = new Map<string, number>();
  for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

/** Strand frequency, for choosing the default lanes. */
export function strandCounts(events: TimelineEvent[], membersOf: (ev: TimelineEvent) => StrandKey[]): Map<StrandKey, number> {
  const c = new Map<StrandKey, number>();
  for (const ev of events) if (ev.kind !== 'loose') for (const s of membersOf(ev)) c.set(s, (c.get(s) ?? 0) + 1);
  return c;
}

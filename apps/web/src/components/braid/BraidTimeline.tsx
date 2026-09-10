'use client';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { INTEREST } from '@minnegela/shared';
import type { TimelineEvent, MediaItem } from '@/lib/types';
import { useTimeline } from '@/lib/hooks';
import { useMediaUrls } from '@/lib/urls';
import { useFormat } from '@/lib/format';
import { Avatar, AvatarStack, strandColor } from '../Avatar';
import { MediaGrid } from '../MediaGrid';
import { MediaViewer } from '../MediaViewer';
import { usePeopleIndex, useMemberIndex } from '../indexes';
import { Minimap } from './Minimap';
import { layoutBraid, strandCounts, rowStart, runWithDay, GUTTER, type Row, type StrandKey, type Layout } from './layout';

export type BraidMode = 'people' | 'contributors';
const EXPANDED_H = 316;
const OVERSCAN = 700;

type Props = {
  events: TimelineEvent[];
  mode: BraidMode;
  selected: StrandKey[];
  onSelect: (keys: StrandKey[]) => void;
  onMode: (m: BraidMode) => void;
  day: string | null;
  onDay: (day: string | null) => void;
};

/**
 * The braid: people are coloured strands running down the page; every event is a knot where the strands of the
 * people who were there meet. Pick strands to follow them; pick several to keep only the times they were together.
 */
export function BraidTimeline({ events, mode, selected, onSelect, onMode, day, onDay }: Props) {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  const fmt = useFormat();
  const people = usePeopleIndex();
  const members = useMemberIndex();
  const [narrow, setNarrow] = useState(false);
  const [wide, setWide] = useState(true);
  const [extraLanes, setExtraLanes] = useState<StrandKey[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ y: 0, h: 800, top: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = () => { setNarrow(window.innerWidth < 640); setWide(window.innerWidth >= 1024); };
    m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m);
  }, []);

  // strand identity depends on the mode: persons who were there, or members whose phones the photos came from
  const membersOf = useCallback((ev: TimelineEvent): StrandKey[] => (mode === 'people' ? ev.personIds.map(String) : ev.contributorIds), [mode]);
  const nameOf = useCallback((k: StrandKey): string | null => (mode === 'people' ? people.get(Number(k))?.name ?? null : members.get(k)?.displayName ?? null), [mode, people, members]);
  const counts = useMemo(() => strandCounts(events, membersOf), [events, membersOf]);
  const ranked = useMemo(() => [...counts.entries()].filter(([k]) => mode !== 'people' || !people.get(Number(k))?.hidden).sort((a, b) => b[1] - a[1]).map(([k]) => k), [counts, mode, people]);
  const maxLanes = narrow ? 4 : wide ? 8 : 6;
  const strands = useMemo(() => {
    const out: StrandKey[] = [];
    for (const k of [...selected, ...extraLanes, ...ranked]) if (!out.includes(k) && counts.has(k)) out.push(k);
    return out.slice(0, Math.max(maxLanes, selected.length + extraLanes.length));
  }, [selected, extraLanes, ranked, counts, maxLanes]);
  const others = ranked.filter((k) => !strands.includes(k));

  const extra = useCallback((row: Row) => (row.kind === 'loose' && day && row.days.some((d) => d.day === day) ? EXPANDED_H : 0), [day]);
  const layout = useMemo(() => layoutBraid(events, {
    strands, membersOf, extra, gutter: narrow ? 44 : GUTTER,
    monthLabel: (iso) => fmt.fmtDate(iso, { month: narrow ? 'short' : 'long' }),
    yearLabel: (iso) => fmt.fmtDate(iso, { year: 'numeric' }),
  }), [events, strands, membersOf, extra, narrow, fmt]);

  // hits: rows where everyone selected was there
  const hits = useMemo(() => {
    if (!selected.length) return null;
    return new Set(layout.rows.filter((r) => r.kind === 'event' && selected.every((s) => r.members.includes(s))).map((r) => r.key));
  }, [layout, selected]);

  // window scroll → which slice of the braid to draw
  useEffect(() => {
    let raf = 0;
    const m = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = containerRef.current; if (!el) return;
        const top = el.getBoundingClientRect().top + window.scrollY;
        setView({ y: window.scrollY, h: window.innerHeight, top });
      });
    };
    m();
    window.addEventListener('scroll', m, { passive: true }); window.addEventListener('resize', m);
    return () => { window.removeEventListener('scroll', m); window.removeEventListener('resize', m); cancelAnimationFrame(raf); };
  }, [layout.height]);
  const lo = view.y - view.top - OVERSCAN, hi = view.y - view.top + view.h + OVERSCAN;
  const visibleRows = useMemo(() => layout.rows.filter((r) => r.y + r.h / 2 + extra(r) >= lo && r.y - r.h / 2 <= hi), [layout, lo, hi, extra]);
  const visibleSegs = useMemo(() => layout.segments.filter((s) => s.y1 >= lo && s.y0 <= hi), [layout, lo, hi]);

  // ?day= deep link: expand that day and scroll to it once the layout exists
  const jumped = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!day || jumped.current === day || !layout.rows.length) return;
    const row = runWithDay(layout.rows, day) ?? layout.rows.find((r) => rowStart(r).slice(0, 10) <= day);
    if (!row) return;
    jumped.current = day;
    const el = containerRef.current; if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, top + row.y - row.h / 2 - 120) });
  }, [day, layout]);

  const covers = useMemo(() => visibleRows.flatMap((r) => (r.kind === 'event' && r.ev.coverBlobId ? [{ blobId: r.ev.coverBlobId, kind: 'thumb' as const }] : [])), [visibleRows]);
  const urls = useMediaUrls(covers);

  const toggle = (k: StrandKey) => onSelect(selected.includes(k) ? selected.filter((s) => s !== k) : [...selected, k]);
  const hoverRow = hover ? layout.rows.find((r) => r.key === hover) : null;
  const lit = new Set(hoverRow?.members ?? []);
  const active = selected.length > 0;
  const nEvents = layout.rows.filter((r) => r.kind === 'event').length;
  const span = layout.rows.length ? { from: rowStart(layout.rows[layout.rows.length - 1]!), to: rowStart(layout.rows[0]!) } : null;
  const gutter = narrow ? 44 : GUTTER;

  return (
    <div className="flex gap-6 items-start">
      <div className="flex-1 min-w-0">
        <header className="space-y-3 mb-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center rounded-lg border border-line bg-surface p-0.5 text-[12.5px]">
              {(['people', 'contributors'] as const).map((m) => (
                <button key={m} onClick={() => { onMode(m); setExtraLanes([]); }} className={`px-2.5 py-1 rounded-md transition-colors ${mode === m ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:text-ink'}`}>{t(m === 'people' ? 'whoWasThere' : 'whosePhone')}</button>
              ))}
            </div>
            <p className="text-[13px] text-ink-2">
              {active
                ? <>{selected.length === 1 ? t('alone', { name: nameOf(selected[0]!) ?? tc('unnamed'), count: hits?.size ?? 0 }) : t('together', { names: fmt.listNames(selected.map((k) => nameOf(k) ?? tc('unnamed'))), count: hits?.size ?? 0 })} <button className="text-accent hover:underline ml-1" onClick={() => onSelect([])}>{t('clear')}</button></>
                : span ? t('summary', { count: nEvents, from: fmt.fmtDate(span.from, { month: 'short', year: 'numeric' }), to: fmt.fmtDate(span.to, { month: 'short', year: 'numeric' }) }) : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {strands.map((k) => {
              const on = selected.includes(k);
              const c = strandColor(k);
              return (
                <button key={k} onClick={() => toggle(k)} aria-pressed={on} title={t('countEvents', { count: counts.get(k) ?? 0 })}
                  className={`group inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border text-[12.5px] transition-colors ${on ? 'bg-surface' : 'border-line bg-surface text-ink-2 hover:text-ink'}`}
                  style={on ? { borderColor: c, boxShadow: `inset 0 0 0 1px ${c}` } : undefined}>
                  <Avatar name={nameOf(k)} seed={k} size={20} />
                  <span className="max-w-[9rem] truncate">{nameOf(k) ?? tc('unnamed')}</span>
                  <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: c }} />
                </button>
              );
            })}
            {others.length > 0 && (
              <details className="relative">
                <summary className="chip cursor-pointer list-none text-ink-2 hover:text-ink">+ {t('addStrand')}</summary>
                <div className="absolute z-20 mt-1 card p-1 min-w-[12rem] max-h-64 overflow-y-auto shadow-lg">
                  {others.map((k) => (
                    <button key={k} className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-accent-soft text-[13px] text-left" onClick={(e) => { setExtraLanes((x) => [...x, k]); (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); }}>
                      <Avatar name={nameOf(k)} seed={k} size={18} /><span className="truncate flex-1">{nameOf(k) ?? tc('unnamed')}</span><span className="text-ink-3 tabular-nums">{counts.get(k)}</span>
                    </button>
                  ))}
                </div>
              </details>
            )}
            {strands.length > 0 && !active && <span className="text-[12px] text-ink-3 ml-1 hidden sm:inline">{t('legendHint')}</span>}
          </div>
        </header>

        <div ref={containerRef} className="relative" style={{ height: layout.height }}>
          <svg className="absolute left-0 top-0 overflow-visible" width={layout.braidWidth} height={layout.height} aria-hidden>
            <defs>
              {visibleRows.map((r) => r.kind === 'event' && <clipPath key={r.key} id={`c-${r.key}`}><circle cx={layout.nodeX} cy={r.y} r={r.r - 1.5} /></clipPath>)}
            </defs>
            {layout.chapters.map((c, i) => (
              <g key={i} className="text-accent">
                <title>{t('awayTitle', { count: c.n, city: c.city, from: fmt.fmtDate(c.from, { day: 'numeric', month: 'short' }), to: fmt.fmtDate(c.to, { day: 'numeric', month: 'short' }) })}</title>
                <line x1={gutter + 4} x2={gutter + 4} y1={c.y0} y2={c.y1} stroke="currentColor" strokeWidth={3} strokeLinecap="round" opacity={0.7} />
                {c.y1 - c.y0 > 70 && <text transform={`translate(${gutter - 2} ${(c.y0 + c.y1) / 2}) rotate(-90)`} textAnchor="middle" fill="currentColor" fontSize={10} letterSpacing={1.2} className="uppercase font-medium">{c.city}</text>}
              </g>
            ))}
            {layout.markers.filter((m) => m.y >= lo && m.y <= hi).map((m) => (
              <text key={m.key} x={gutter - 10} y={m.y} textAnchor="end" dominantBaseline="middle" className={m.kind === 'year' ? 'fill-ink font-semibold' : 'fill-ink-3'} fontSize={m.kind === 'year' ? 15 : 11} letterSpacing={m.kind === 'year' ? 0 : 0.3}>{m.label}</text>
            ))}
            {visibleSegs.map((s) => {
              const inSel = selected.includes(s.strand);
              const dim = active && !inSel;
              const glow = lit.has(s.strand);
              return <path key={`${s.strand}:${s.y0}`} d={s.d} fill="none" stroke={strandColor(s.strand)} strokeWidth={glow ? 3.5 : inSel ? 2.6 : 2} strokeLinecap="round" strokeDasharray={s.dashed ? '1 7' : undefined} opacity={dim ? 0.18 : s.dashed ? 0.75 : 0.9} style={{ transition: 'opacity .2s, stroke-width .15s' }} />;
            })}
            {visibleRows.map((r) => {
              if (r.kind === 'loose') return <circle key={r.key} cx={layout.nodeX} cy={r.y} r={r.r} className="fill-bg stroke-ink-3" strokeWidth={1.5} opacity={active ? 0.35 : 1} />;
              const url = r.ev.coverBlobId ? urls[`${r.ev.coverBlobId}:thumb`] : null;
              const hit = !hits || hits.has(r.key);
              const ringColor = r.members[0] ? strandColor(r.members[0]) : 'var(--ink-3)';
              return (
                <g key={r.key} opacity={hit ? 1 : 0.3} style={{ transition: 'opacity .2s' }}>
                  <circle cx={layout.nodeX} cy={r.y} r={r.r} className="fill-surface" stroke={hover === r.key ? 'var(--accent)' : ringColor} strokeWidth={hover === r.key ? 3 : 2} />
                  {url ? <image href={url} x={layout.nodeX - r.r} y={r.y - r.r} width={r.r * 2} height={r.r * 2} preserveAspectRatio="xMidYMid slice" clipPath={`url(#c-${r.key})`} />
                    : <circle cx={layout.nodeX} cy={r.y} r={r.r - 4} fill={ringColor} opacity={0.25} />}
                </g>
              );
            })}
          </svg>
          {visibleRows.map((r) => (
            <div key={r.key} className="absolute right-0" style={{ top: r.y - r.h / 2, left: layout.braidWidth, height: r.h + extra(r) }}>
              {r.kind === 'event'
                ? <EventRowCard row={r} hit={!hits || hits.has(r.key)} nameOf={nameOf} mode={mode} onHover={setHover} />
                : <LooseRowCard row={r} day={day} onDay={onDay} dim={active} />}
            </div>
          ))}
        </div>
      </div>
      <Minimap layout={layout} top={view.top} viewport={{ y: view.y, h: view.h }} hits={hits} label={t('minimap')} />
    </div>
  );
}

function EventRowCard({ row, hit, nameOf, mode, onHover }: { row: Extract<Row, { kind: 'event' }>; hit: boolean; nameOf: (k: StrandKey) => string | null; mode: BraidMode; onHover: (k: string | null) => void }) {
  const t = useTranslations('timeline');
  const { fmtSpan } = useFormat();
  const ev = row.ev;
  const quiet = ev.interest != null && ev.interest < INTEREST.quiet;
  const who = mode === 'people' ? ev.personIds.map((id) => ({ id, name: nameOf(String(id)) })) : ev.contributorIds.map((id) => ({ id, name: nameOf(id) }));
  return (
    <Link href={`/events/${ev.id}`} onMouseEnter={() => onHover(row.key)} onMouseLeave={() => onHover(null)}
      className={`flex items-center h-full gap-3 pl-2 pr-3 rounded-lg hover:bg-surface hover:shadow-[0_1px_0_var(--line)] transition-all ${hit ? '' : 'opacity-40'}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="font-medium text-[15px] leading-tight truncate">{ev.title}</h3>
          {ev.kind === 'trip' && <span className="chip text-accent border-transparent bg-accent-soft shrink-0">{t('trip')}</span>}
          {ev.isPublicToGroup && <span className="chip text-ink-3 shrink-0">{t('open')}</span>}
          {quiet && <span className="chip text-ink-3 shrink-0">{t('quiet')}</span>}
        </div>
        <div className="text-[12.5px] text-ink-2 truncate">{fmtSpan(ev.startAt, ev.endAt)}{ev.placeName ? ` · ${ev.placeName}` : ev.city ? ` · ${ev.city}` : ''}</div>
      </div>
      <div className="shrink-0 flex items-center gap-3 text-[12px] text-ink-3">
        <span className="hidden sm:inline tabular-nums">{t('photos', { count: ev.nAssets })}{ev.nVideos ? ` · ${ev.nVideos} ▶` : ''}</span>
        <AvatarStack people={who} size={20} max={4} />
      </div>
    </Link>
  );
}

function LooseRowCard({ row, day, onDay, dim }: { row: Extract<Row, { kind: 'loose' }>; day: string | null; onDay: (d: string | null) => void; dim: boolean }) {
  const t = useTranslations('timeline');
  const { fmtDate } = useFormat();
  const open = !!day && row.days.some((d) => d.day === day);
  const short = (iso: string) => fmtDate(iso, { day: 'numeric', month: 'short' });
  return (
    <div className={`h-full ${dim ? 'opacity-40' : ''}`}>
      <button onClick={() => onDay(open ? null : row.days[0]!.day)} className="flex items-center gap-2 h-[30px] pl-2 pr-3 rounded-md text-[12.5px] text-ink-3 hover:text-ink hover:bg-surface transition-colors" aria-expanded={open}>
        <span>{row.days.length > 1 ? t('looseRun', { count: row.n, days: row.days.length }) : t('loosePhotos', { count: row.n })}</span>
        <span className="text-ink-3/70">· {row.days.length > 1 ? `${short(row.endAt)} – ${short(row.startAt)}` : fmtDate(row.startAt, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span className="text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && day && (
        <div className="card overflow-hidden" style={{ height: EXPANDED_H - 16 }}>
          {row.days.length > 1 && (
            <div className="flex gap-1 overflow-x-auto px-2 pt-2">
              {row.days.map((d) => <button key={d.day} onClick={() => onDay(d.day)} className={`chip shrink-0 ${d.day === day ? 'bg-accent-soft text-accent border-transparent' : 'text-ink-2'}`}>{short(d.day)} <span className="opacity-60">{d.n}</span></button>)}
            </div>
          )}
          <DayPanel day={day} tall={row.days.length === 1} />
        </div>
      )}
    </div>
  );
}

/** The loose photos of one day, inline under its row. Uses the same day endpoint the old timeline page did. */
function DayPanel({ day, tall }: { day: string; tall: boolean }) {
  const t = useTranslations('timeline');
  const q = useTimeline(day);
  const [viewer, setViewer] = useState<{ items: MediaItem[]; i: number } | null>(null);
  const d = q.data ? ('items' in q.data ? q.data.items[0] : q.data) : null;
  const loose = d?.loose ?? [];
  return (
    <div className="p-2 overflow-y-auto" style={{ height: EXPANDED_H - 16 - (tall ? 0 : 34) }}>
      {q.isLoading && <p className="text-ink-3 text-sm p-2">…</p>}
      {!q.isLoading && loose.length === 0 && <p className="text-ink-3 text-sm p-2">{t('nothing')}</p>}
      {loose.length > 0 && <MediaGrid items={loose} onOpen={(m) => setViewer({ items: loose, i: loose.indexOf(m) })} />}
      {viewer && <MediaViewer items={viewer.items} index={viewer.i} onClose={() => setViewer(null)} onIndex={(i) => setViewer({ ...viewer, i })} />}
    </div>
  );
}

export type { Layout };

'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/format';

export type Range = { from: number; to: number };

/**
 * Two handles over a month histogram. Drag a handle, drag the window, or press play to sweep a window across the years.
 */
export function TimeScrubber({ min, max, range, onChange, times }: { min: number; max: number; range: Range; onChange: (r: Range) => void; times: number[] }) {
  const t = useTranslations('map');
  const { fmtDate } = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const span = Math.max(1, max - min);
  const px = (ms: number) => ((ms - min) / span) * 100;

  const bars = useMemo(() => {
    const months: Array<{ t0: number; t1: number; n: number }> = [];
    const d = new Date(min); d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= max) {
      const t0 = d.getTime(); d.setMonth(d.getMonth() + 1);
      months.push({ t0, t1: d.getTime(), n: 0 });
    }
    for (const x of times) { const i = months.findIndex((m) => x >= m.t0 && x < m.t1); if (i >= 0) months[i]!.n++; }
    const peak = Math.max(1, ...months.map((m) => m.n));
    return months.map((m) => ({ ...m, h: m.n ? 0.15 + 0.85 * Math.sqrt(m.n / peak) : 0 }));
  }, [min, max, times]);

  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = new Date(min).getFullYear() + 1; y <= new Date(max).getFullYear(); y++) out.push(new Date(y, 0, 1).getTime());
    return out;
  }, [min, max]);

  const drag = useRef<{ kind: 'from' | 'to' | 'window'; x0: number; r0: Range } | null>(null);
  const atX = (clientX: number) => {
    const el = ref.current!; const r = el.getBoundingClientRect();
    return min + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const onDown = (kind: 'from' | 'to' | 'window') => (e: React.PointerEvent) => {
    e.stopPropagation(); setPlaying(false);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x0: e.clientX, r0: range };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dt = (e.clientX - d.x0) / ref.current!.getBoundingClientRect().width * span;
    const minW = span / 200;
    if (d.kind === 'from') onChange({ from: Math.min(Math.max(min, d.r0.from + dt), d.r0.to - minW), to: d.r0.to });
    else if (d.kind === 'to') onChange({ from: d.r0.from, to: Math.max(Math.min(max, d.r0.to + dt), d.r0.from + minW) });
    else {
      const w = d.r0.to - d.r0.from;
      const from = Math.min(Math.max(min, d.r0.from + dt), max - w);
      onChange({ from, to: from + w });
    }
  };
  const onUp = () => { drag.current = null; };
  const onTrack = (e: React.PointerEvent) => {
    if (drag.current) return;
    const x = atX(e.clientX);
    const w = range.to - range.from;
    if (x < range.from || x > range.to) {
      // jump the window so it is centred where the user pressed
      const from = Math.min(Math.max(min, x - w / 2), max - w);
      onChange({ from, to: from + w });
    }
  };

  useEffect(() => {
    if (!playing) return;
    const w = Math.min(range.to - range.from, span);
    const step = span / 180;
    const id = setInterval(() => {
      const from = range.from + step;
      if (from + w > max) { onChange({ from: min, to: min + w }); return; }
      onChange({ from, to: from + w });
    }, 80);
    return () => clearInterval(id);
  }, [playing, range, span, min, max, onChange]);

  const full = range.from <= min && range.to >= max;
  const play = () => {
    if (full) { const w = span / 6; onChange({ from: min, to: min + w }); }
    setPlaying((p) => !p);
  };
  return (
    <div className="mg-scrub">
      <button className="mg-scrub-btn" onClick={play} aria-label={playing ? t('pause') : t('play')} title={playing ? t('pause') : t('play')}>{playing ? '❚❚' : '▶'}</button>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between text-[11px] text-ink-2 tabular-nums mb-0.5 px-0.5">
          <span>{fmtDate(new Date(range.from).toISOString(), { month: 'short', year: 'numeric' })}</span>
          {!full && <button className="text-accent hover:underline" onClick={() => { setPlaying(false); onChange({ from: min, to: max }); }}>{t('wholePeriod')}</button>}
          <span>{fmtDate(new Date(range.to).toISOString(), { month: 'short', year: 'numeric' })}</span>
        </div>
        <div ref={ref} className="relative h-9 select-none cursor-pointer" style={{ touchAction: 'none' }} onPointerDown={onTrack} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="absolute inset-x-0 bottom-0 h-7 flex items-end gap-px">
            {bars.map((b, i) => <div key={i} className="flex-1 rounded-t-[2px]" style={{ height: `${b.h * 100}%`, background: b.t1 > range.from && b.t0 < range.to ? 'var(--accent)' : 'var(--line)', opacity: b.t1 > range.from && b.t0 < range.to ? 0.75 : 1, transition: 'background .15s' }} />)}
          </div>
          {years.map((y) => <div key={y} className="absolute top-0 bottom-0 w-px bg-ink-3/30" style={{ left: `${px(y)}%` }}><span className="absolute -top-0.5 left-1 text-[9px] text-ink-3 tabular-nums">{new Date(y).getFullYear()}</span></div>)}
          <div className="absolute top-1 bottom-0 rounded-sm border-y border-accent/60 bg-accent/10 cursor-grab active:cursor-grabbing" style={{ left: `${px(range.from)}%`, width: `${px(range.to) - px(range.from)}%` }} onPointerDown={onDown('window')} />
          <div className="mg-handle" style={{ left: `${px(range.from)}%` }} onPointerDown={onDown('from')} role="slider" aria-label={t('from')} aria-valuenow={range.from} aria-valuemin={min} aria-valuemax={max} />
          <div className="mg-handle" style={{ left: `${px(range.to)}%` }} onPointerDown={onDown('to')} role="slider" aria-label={t('to')} aria-valuenow={range.to} aria-valuemin={min} aria-valuemax={max} />
        </div>
      </div>
    </div>
  );
}

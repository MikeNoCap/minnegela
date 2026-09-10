'use client';
import { useEffect, useRef, useState } from 'react';
import type { Layout } from './layout';

/**
 * The whole timeline squeezed into one strip: year labels, a density bar per month, and the band you are looking at.
 * Click or drag to jump. Lives in the sticky rail on wide screens.
 */
export function Minimap({ layout, top, viewport, hits, label }: { layout: Layout; top: number; viewport: { y: number; h: number }; hits: Set<string> | null; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(400);
  useEffect(() => {
    const m = () => setH(Math.max(160, window.innerHeight - 200));
    m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m);
  }, []);
  const scale = layout.height > 0 ? h / layout.height : 0;
  const months = new Map<string, { y: number; n: number; hit: number }>();
  for (const row of layout.rows) {
    const iso = row.kind === 'event' ? row.ev.startAt : row.startAt;
    const k = iso.slice(0, 7);
    const m = months.get(k) ?? { y: 0, n: 0, hit: 0 };
    if (row.kind === 'event') { m.y += row.y; m.n += 1; if (hits?.has(row.key)) m.hit += 1; }
    months.set(k, m);
  }
  const jump = (clientY: number) => {
    const el = ref.current; if (!el) return;
    const rel = (clientY - el.getBoundingClientRect().top) / scale;
    window.scrollTo({ top: Math.max(0, top + rel - window.innerHeight * 0.35) });
  };
  const bandY = Math.max(0, (viewport.y - top) * scale), bandH = Math.max(6, viewport.h * scale);
  return (
    <aside className="rail hidden lg:block w-16 shrink-0 select-none" aria-label={label}>
      <div
        ref={ref}
        className="relative w-full cursor-pointer rounded-md"
        style={{ height: h, touchAction: 'none' }}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); jump(e.clientY); }}
        onPointerMove={(e) => { if (e.buttons & 1) jump(e.clientY); }}
      >
        <div className="absolute left-7 top-0 bottom-0 w-px bg-line" />
        {[...months.values()].filter((m) => m.n > 0).map((m, i) => {
          const y = (m.y / m.n) * scale;
          const w = 3 + Math.min(22, m.n * 2.2);
          return <div key={i} className="absolute h-[3px] rounded-full" style={{ left: 28, top: y - 1, width: w, background: hits ? (m.hit ? 'var(--accent)' : 'var(--line)') : 'color-mix(in srgb, var(--accent), transparent 45%)' }} />;
        })}
        {layout.markers.filter((m) => m.kind === 'year').map((m) => (
          <div key={m.key} className="absolute right-[calc(100%-1.5rem)] text-[10px] tabular-nums text-ink-3 leading-none -translate-y-1/2" style={{ top: m.y * scale }}>{m.label}</div>
        ))}
        <div className="absolute left-4 right-0 rounded-sm border border-accent/60 bg-accent/10 pointer-events-none" style={{ top: bandY, height: bandH }} />
      </div>
    </aside>
  );
}

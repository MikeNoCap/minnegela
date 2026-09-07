'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTimeline } from '@/lib/hooks';
import { EventCard } from '@/components/EventCard';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import { fmtDate } from '@/lib/format';
import type { TimelineDay } from '@/lib/types';

export default function TimelinePage() { return <Suspense><Timeline /></Suspense>; }

function Timeline() {
  const params = useSearchParams();
  const router = useRouter();
  const day = params.get('day') ?? new Date().toISOString().slice(0, 10);
  const q = useTimeline(day);
  const [viewer, setViewer] = useState<{ items: TimelineDay['loose']; i: number } | null>(null);
  const days: TimelineDay[] = q.data ? ('items' in q.data ? q.data.items : [q.data]) : [];
  const shift = (n: number) => { const d = new Date(day); d.setDate(d.getDate() + n); router.push(`/timeline?day=${d.toISOString().slice(0, 10)}`); };
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button className="btn" onClick={() => shift(-1)}>‹</button>
        <input type="date" className="input w-auto" value={day} onChange={(e) => router.push(`/timeline?day=${e.target.value}`)} />
        <button className="btn" onClick={() => shift(1)}>›</button>
        <span className="text-ink-2">{fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
      {q.isLoading && <p className="text-ink-3 text-sm">…</p>}
      {days.map((d) => (
        <section key={d.day} className="space-y-3">
          {days.length > 1 && <h2 className="text-ink-3 text-xs uppercase tracking-wide">{fmtDate(d.day, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>}
          {d.events.length > 0 && <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{d.events.map((e) => <EventCard key={e.id} ev={e} />)}</div>}
          {d.loose.length > 0 && (
            <div>
              <h3 className="text-ink-3 text-[12px] mb-1">{d.loose.length} loose photo{d.loose.length === 1 ? '' : 's'}</h3>
              <MediaGrid items={d.loose} onOpen={(m) => setViewer({ items: d.loose, i: d.loose.indexOf(m) })} />
            </div>
          )}
          {d.events.length === 0 && d.loose.length === 0 && <p className="text-ink-3 text-sm">Nothing on this day.</p>}
        </section>
      ))}
      {viewer && <MediaViewer items={viewer.items} index={viewer.i} onClose={() => setViewer(null)} onIndex={(i) => setViewer({ ...viewer, i })} />}
    </div>
  );
}

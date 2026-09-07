'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { useEvents, usePeople } from '@/lib/hooks';
import { EventCard } from '@/components/EventCard';
import { Avatar } from '@/components/Avatar';
import { fmtDate } from '@/lib/format';
import type { EventCard as EventCardT } from '@/lib/types';

/** Home: the reverse-chronological river of events. Days with only loose photos collapse into one line. */
export default function HomePage() {
  const q = useEvents();
  const people = usePeople();
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current; if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el); return () => io.disconnect();
  }, [q]);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const groups = useMemo(() => groupByMonth(items), [items]);
  const lastYear = useMemo(() => {
    const now = new Date(); const y = now.getFullYear() - 1;
    return items.filter((e) => { const d = new Date(e.startAt); return d.getFullYear() === y && Math.abs(dayOfYear(d) - dayOfYear(now)) <= 3; });
  }, [items]);
  return (
    <div className="space-y-8">
      {people.data && people.data.length > 0 && (
        <section className="flex items-center gap-3 overflow-x-auto pb-1">
          <span className="text-ink-3 text-xs uppercase tracking-wide shrink-0">People</span>
          {people.data.filter((p) => !p.hidden).slice(0, 12).map((p) => (
            <Link key={p.id} href={`/people/${p.id}`} className="flex items-center gap-1.5 shrink-0 text-[13px] hover:text-accent"><Avatar name={p.name} seed={p.id} size={24} />{p.name ?? 'Unnamed'}</Link>
          ))}
          <Link href="/people" className="text-ink-3 text-[13px] shrink-0">All →</Link>
        </section>
      )}
      {lastYear.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">This week last year</h2>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">{lastYear.slice(0, 4).map((e) => <EventCard key={e.id} ev={e} />)}</div>
        </section>
      )}
      {q.isLoading && <p className="text-ink-3 text-sm">Loading your timeline…</p>}
      {!q.isLoading && items.length === 0 && (
        <div className="card p-6 text-center space-y-2">
          <p className="font-medium">Nothing reconstructed yet</p>
          <p className="text-ink-2 text-sm">Install the app on your phone or import a folder with the CLI. Events appear here as soon as the first photos are analyzed.</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.key}>
          <h2 className="sticky top-12 bg-bg/90 backdrop-blur z-10 py-1 text-ink-3 text-xs uppercase tracking-wide">{g.label}</h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mt-2">
            {g.rows.map((row) => row.kind === 'event' ? <EventCard key={row.ev.id} ev={row.ev} /> : (
              <Link key={row.key} href={`/timeline?day=${row.day}`} className="card p-3 text-[13px] text-ink-2 flex items-center justify-between hover:border-ink-3">
                <span>{fmtDate(row.day, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                <span className="text-ink-3">{row.n} loose photo{row.n === 1 ? '' : 's'}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <div ref={sentinel} className="h-8 text-center text-ink-3 text-xs">{q.isFetchingNextPage ? 'Loading more…' : ''}</div>
    </div>
  );
}

type Row = { kind: 'event'; ev: EventCardT } | { kind: 'loose'; key: string; day: string; n: number };
function groupByMonth(items: EventCardT[]) {
  const out: Array<{ key: string; label: string; rows: Row[] }> = [];
  let cur: (typeof out)[number] | null = null;
  const looseByDay = new Map<string, Row & { kind: 'loose' }>();
  for (const ev of items) {
    const d = new Date(ev.startAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!cur || cur.key !== key) { cur = { key, label: fmtDate(ev.startAt, { month: 'long', year: 'numeric' }), rows: [] }; out.push(cur); }
    if (ev.kind === 'loose') {
      const day = ev.startAt.slice(0, 10);
      const ex = looseByDay.get(day);
      if (ex) { ex.n += ev.nAssets; continue; }
      const row: Row & { kind: 'loose' } = { kind: 'loose', key: `loose-${day}`, day, n: ev.nAssets };
      looseByDay.set(day, row); cur.rows.push(row);
    } else cur.rows.push({ kind: 'event', ev });
  }
  return out;
}
function dayOfYear(d: Date) { return Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000); }

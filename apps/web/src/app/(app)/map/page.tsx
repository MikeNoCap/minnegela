'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMap } from '@/lib/hooks';
import { useFormat } from '@/lib/format';

/** Phase 3 gets MapLibre with a time scrubber. Until then: the pins as a list. */
export default function MapPage() {
  const t = useTranslations('map');
  const { fmtDate } = useFormat();
  const q = useMap();
  const pins = q.data ?? [];
  return (
    <div className="space-y-4">
      <div className="banner">{t('banner')}</div>
      {pins.length === 0 && !q.isLoading && <p className="text-ink-3">{t('noLocation')}</p>}
      <ul className="card divide-y divide-line">
        {pins.map((p) => (
          <li key={p.id} className="p-3 flex items-center justify-between gap-3 text-[13px]">
            <Link href={`/events/${p.id}`} className="font-medium hover:text-accent">{p.title}</Link>
            <span className="text-ink-2">{fmtDate(p.startAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            <span className="text-ink-3 tabular-nums">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</span>
            <a className="text-accent" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`}>{t('osm')}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

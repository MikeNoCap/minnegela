'use client';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useMap } from '@/lib/hooks';

// MapLibre touches window at import time and weighs ~250 KB gzipped: only the map page pays for it, and only in the browser.
const MapExplorer = dynamic(() => import('@/components/map/MapExplorer').then((m) => m.MapExplorer), { ssr: false, loading: () => <Loading /> });

function Loading() {
  const t = useTranslations('map');
  return <div className="mg-map-frame flex items-center justify-center text-ink-3 text-sm">{t('loading')}</div>;
}

export default function MapPage() {
  const t = useTranslations('map');
  const q = useMap();
  if (q.isLoading || !q.data) return <Loading />;
  if (q.data.items.length === 0 && q.data.loose.length === 0) {
    return (
      <div className="card p-6 text-center space-y-2">
        <p className="font-medium">{t('noLocation')}</p>
        <p className="text-ink-2 text-sm">{t('noLocationBody')}</p>
      </div>
    );
  }
  return <MapExplorer data={q.data} />;
}

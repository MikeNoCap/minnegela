'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSearch } from '@/lib/hooks';
import { Chip } from '@/components/Chips';
import { EventCard } from '@/components/EventCard';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import type { SearchChip } from '@/lib/types';

export default function SearchPage() { return <Suspense><Search /></Suspense>; }

function Search() {
  const t = useTranslations('search');
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get('q') ?? '';
  const mode = (params.get('mode') === 'media' ? 'media' : 'events') as 'events' | 'media';
  const [text, setText] = useState(q);
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => setText(q), [q]);
  const res = useSearch(q, mode);
  const go = (nq: string, nm = mode) => router.push(`/search?q=${encodeURIComponent(nq)}${nm === 'media' ? '&mode=media' : ''}`);
  const removeChip = (c: SearchChip) => go(q.replace(c.text, '').replace(/\s{2,}/g, ' ').trim());
  const events = res.data?.events ?? [];
  const media = res.data?.media ?? [];
  const shownMode = res.data?.mode ?? mode;
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); go(text.trim()); }} className="flex gap-2">
        <input className="input text-base" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('placeholder')} aria-label={t('label')} />
        <button className="btn btn-primary">{t('button')}</button>
      </form>
      {q && (
        <div className="flex flex-wrap items-center gap-2">
          {res.data?.parsed.map((c, i) => <Chip key={i} chip={c} onRemove={c.text ? () => removeChip(c) : undefined} />)}
          {res.data && res.data.parsed.length === 0 && <span className="text-ink-3 text-sm">{t('freeText')}</span>}
          <span className="ml-auto flex rounded-md border border-line overflow-hidden text-[13px]">
            {(['events', 'media'] as const).map((m) => <button key={m} onClick={() => go(q, m)} className={`px-3 py-1 ${mode === m ? 'bg-accent-soft text-accent' : 'text-ink-2'}`}>{m === 'events' ? t('events') : t('photos')}</button>)}
          </span>
        </div>
      )}
      {res.isError && <p className="text-danger text-sm">{t('failed')}</p>}
      {res.data && shownMode === 'events' && (events.length ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{events.map((e) => <EventCard key={e.id} ev={e} />)}</div>
      ) : <p className="text-ink-3">{t('noEvents')}</p>)}
      {res.data && shownMode === 'media' && (media.length ? (
        <MediaGrid items={media} onOpen={(m) => setViewer(media.indexOf(m))} />
      ) : <p className="text-ink-3">{t('noPhotos')}</p>)}
      {viewer !== null && <MediaViewer items={media} index={viewer} onClose={() => setViewer(null)} onIndex={setViewer} />}
    </div>
  );
}

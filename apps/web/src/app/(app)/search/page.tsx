'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSearch } from '@/lib/hooks';
import { Chip } from '@/components/Chips';
import { EventCard } from '@/components/EventCard';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import type { SearchChip } from '@/lib/types';

export default function SearchPage() { return <Suspense><Search /></Suspense>; }

function Search() {
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
        <input className="input text-base" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Me and Emma at the beach · Copenhagen trip · last summer" aria-label="Search" />
        <button className="btn btn-primary">Search</button>
      </form>
      {q && (
        <div className="flex flex-wrap items-center gap-2">
          {res.data?.parsed.map((c, i) => <Chip key={i} chip={c} onRemove={c.text ? () => removeChip(c) : undefined} />)}
          {res.data && res.data.parsed.length === 0 && <span className="text-ink-3 text-sm">Understood as free text</span>}
          <span className="ml-auto flex rounded-md border border-line overflow-hidden text-[13px]">
            {(['events', 'media'] as const).map((m) => <button key={m} onClick={() => go(q, m)} className={`px-3 py-1 ${mode === m ? 'bg-accent-soft text-accent' : 'text-ink-2'}`}>{m === 'events' ? 'Events' : 'Photos'}</button>)}
          </span>
        </div>
      )}
      {res.isError && <p className="text-danger text-sm">Search failed. Try again.</p>}
      {res.data && shownMode === 'events' && (events.length ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{events.map((e) => <EventCard key={e.id} ev={e} />)}</div>
      ) : <p className="text-ink-3">No events match. Try the Photos mode or fewer chips.</p>)}
      {res.data && shownMode === 'media' && (media.length ? (
        <MediaGrid items={media} onOpen={(m) => setViewer(media.indexOf(m))} />
      ) : <p className="text-ink-3">No photos match.</p>)}
      {viewer !== null && <MediaViewer items={media} index={viewer} onClose={() => setViewer(null)} onIndex={setViewer} />}
    </div>
  );
}

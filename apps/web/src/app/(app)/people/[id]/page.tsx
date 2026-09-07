'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { usePerson, useEvents, useSearch, peopleActions, useAction } from '@/lib/hooks';
import { useGroup } from '@/lib/group';
import { EventCard } from '@/components/EventCard';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import { Avatar } from '@/components/Avatar';
import { FaceCrop } from '@/components/FaceCrop';

export default function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const p = usePerson(id);
  const events = useEvents({ people: [Number(id)] });
  const media = useSearch(`person:${id}`, 'media');
  const { personId } = useGroup();
  const [viewer, setViewer] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const rename = useAction((n: string) => peopleActions.patch(Number(id), { name: n }), () => [['person', id], ['people']]);
  const hide = useAction(() => peopleActions.patch(Number(id), { hidden: true }), () => [['people']]);
  if (p.isError) return <p className="text-ink-3">This person is not in your view.</p>;
  const d = p.data;
  if (!d) return null;
  const evs = d.events ?? events.data?.pages.flatMap((x) => x.items) ?? [];
  const items = d.media ?? media.data?.media ?? [];
  const isMe = personId === d.id;
  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        {d.coverFaceId ? <FaceCrop faceId={d.coverFaceId} className="w-20 aspect-square rounded-full" /> : <Avatar name={d.name} seed={d.id} size={80} />}
        <div className="flex-1">
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); rename.mutate(name.trim()); setEditing(false); }} className="flex gap-2">
              <input className="input max-w-xs" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary">Save</button><button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : (
            <h1 className="text-xl font-semibold">{d.name ?? 'Unnamed'}{isMe && <span className="ml-2 chip">you</span>}</h1>
          )}
          <div className="text-ink-2 text-[13px]">{evs.length} event{evs.length === 1 ? '' : 's'}{d.nAssets != null ? ` · ${d.nAssets} photos in your view` : ''}</div>
          {d.coAppearances && d.coAppearances.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">{d.coAppearances.slice(0, 8).map((c) => <Link key={c.personId} href={`/people/${c.personId}`} className="chip hover:border-ink-3">with {c.name ?? 'Unnamed'} {c.count}×</Link>)}</div>
          )}
        </div>
        {!d.userId && <div className="flex gap-2"><button className="btn" onClick={() => { setName(d.name ?? ''); setEditing(true); }}>Rename</button><button className="btn btn-danger" onClick={() => hide.mutate()}>Hide</button></div>}
      </header>
      {evs.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">Events</h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{evs.map((e) => <EventCard key={e.id} ev={e} />)}</div>
        </section>
      )}
      {items.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">Photos</h2>
          <MediaGrid items={items} onOpen={(m) => setViewer(items.indexOf(m))} />
        </section>
      )}
      {viewer !== null && <MediaViewer items={items} index={viewer} onClose={() => setViewer(null)} onIndex={setViewer} />}
    </div>
  );
}

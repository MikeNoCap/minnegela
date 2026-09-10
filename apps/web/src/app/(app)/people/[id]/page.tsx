'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePerson, useEvents, useSearch, usePeople, peopleActions, useAction } from '@/lib/hooks';
import { useApiErrorMessage } from '@/lib/errors';
import { useGroup } from '@/lib/group';
import { EventCard } from '@/components/EventCard';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import { Avatar } from '@/components/Avatar';
import { FaceCrop } from '@/components/FaceCrop';

export default function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations('person');
  const tc = useTranslations('common');
  const { id } = use(params);
  const p = usePerson(id);
  const events = useEvents({ people: [Number(id)] });
  const media = useSearch(`person:${id}`, 'media');
  const { personId } = useGroup();
  const [viewer, setViewer] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const router = useRouter();
  const people = usePeople();
  const errorMessage = useApiErrorMessage();
  const rename = useAction((n: string) => peopleActions.patch(Number(id), { name: n }), () => [['person', id], ['people']]);
  const hide = useAction(() => peopleActions.patch(Number(id), { hidden: true }), () => [['people']]);
  const merge = useAction((into: number) => peopleActions.patch(Number(id), { mergeInto: into }), (into) => [['people'], ['person', String(into)], ['review'], ['events'], ['event']]);
  const others = (people.data ?? []).filter((q) => !q.hidden && q.id !== Number(id));
  if (p.isError) return <p className="text-ink-3">{t('notInView')}</p>;
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
              <input className="input max-w-xs" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t('nameLabel')} />
              <button className="btn btn-primary">{tc('save')}</button><button type="button" className="btn" onClick={() => setEditing(false)}>{tc('cancel')}</button>
            </form>
          ) : (
            <h1 className="text-xl font-semibold">{d.name ?? tc('unnamed')}{isMe && <span className="ml-2 chip">{t('you')}</span>}</h1>
          )}
          <div className="text-ink-2 text-[13px]">{t('events', { count: evs.length })}{d.nAssets != null ? ` · ${t('photosInView', { count: d.nAssets })}` : ''}</div>
          {d.coAppearances && d.coAppearances.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">{d.coAppearances.slice(0, 8).map((c) => <Link key={c.personId} href={`/people/${c.personId}`} className="chip hover:border-ink-3">{t('with', { name: c.name ?? tc('unnamed'), count: c.count })}</Link>)}</div>
          )}
        </div>
        {!d.userId && (
          <div className="flex flex-wrap gap-2 items-center justify-end">
            <button className="btn" onClick={() => { setName(d.name ?? ''); setEditing(true); }}>{t('rename')}</button>
            <select className="input max-w-[12rem]" value="" disabled={merge.isPending || !others.length} aria-label={t('mergeInto')} onChange={(e) => {
              const into = Number(e.target.value);
              const target = others.find((q) => q.id === into);
              if (!target || !confirm(t('mergeConfirm', { name: d.name ?? tc('unnamed'), into: target.name ?? tc('unnamed') }))) return;
              merge.mutateAsync(into).then(() => router.replace(`/people/${into}`)).catch(() => {});
            }}>
              <option value="">{t('mergeInto')}</option>
              {others.map((q) => <option key={q.id} value={q.id}>{q.name ?? tc('unnamed')}</option>)}
            </select>
            <button className="btn btn-danger" onClick={() => hide.mutate()}>{t('hide')}</button>
          </div>
        )}
      </header>
      {(rename.isError || merge.isError) && <p className="text-danger text-sm">{errorMessage(rename.error ?? merge.error)}</p>}
      {evs.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">{t('eventsHeading')}</h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{evs.map((e) => <EventCard key={e.id} ev={e} />)}</div>
        </section>
      )}
      {items.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">{t('photosHeading')}</h2>
          <MediaGrid items={items} onOpen={(m) => setViewer(items.indexOf(m))} />
        </section>
      )}
      {viewer !== null && <MediaViewer items={items} index={viewer} onClose={() => setViewer(null)} onIndex={setViewer} />}
    </div>
  );
}

'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useReview, usePeople, faceActions, peopleActions, eventActions, useAction } from '@/lib/hooks';
import { useGroupId } from '@/lib/group';
import { FaceCrop } from '@/components/FaceCrop';
import { Thumb } from '@/components/Thumb';
import { useFormat } from '@/lib/format';
import { useApiErrorMessage } from '@/lib/errors';
import type { UnknownCluster } from '@/lib/types';

/** Correction queue: unnamed clusters, low-confidence matches, suggested splits. Each action is one tap. */
export default function ReviewPage() {
  const t = useTranslations('review');
  const { fmtDate, fmtTime } = useFormat();
  const g = useGroupId();
  const q = useReview();
  const people = usePeople();
  const d = q.data;
  const inv = () => [['review', g], ['people', g], ['events'], ['event']];
  const errorMessage = useApiErrorMessage();
  const label = useAction((v: { faceId: string; personId: number; verdict: 'confirm' | 'reject' }) => faceActions.label(v.faceId, v.personId, v.verdict), inv);
  const createPerson = useAction((v: { name: string; clusterId: string; allowDuplicate?: boolean }) => peopleActions.create(g, v), inv);
  const assignCluster = useAction((v: { clusterId: string; personId: number }) => peopleActions.assignCluster(g, v.clusterId, v.personId), inv);
  const dismiss = useAction((clusterId: string) => peopleActions.dismissCluster(g, clusterId), inv);
  const split = useAction((v: { eventId: string; at: string }) => eventActions.split(v.eventId, v.at), inv);
  // One in-flight action per cluster: the card locks until the server answers, so a slow answer never earns a second submit.
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const act = (clusterId: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(clusterId); setFailed(null);
    run().catch((e) => setFailed({ id: clusterId, message: errorMessage(e) })).finally(() => setBusy(null));
  };
  const namedPeople = (people.data ?? []).filter((p) => !p.hidden);
  if (!d) return <p className="text-ink-3 text-sm">{q.isError ? t('loadFailed') : '…'}</p>;
  const empty = d.unnamedClusters.length === 0 && d.lowConfidenceFaces.length === 0 && d.suggestedSplits.length === 0;
  return (
    <div className="space-y-8">
      {empty && <p className="text-ink-2">{t('nothing')}</p>}
      {d.unnamedClusters.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">{t('unnamed')}</h2>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {d.unnamedClusters.map((c) => <ClusterCard key={c.id} c={c} people={namedPeople} busy={busy === c.id} error={failed?.id === c.id ? failed.message : null}
              onName={(name, allowDuplicate) => act(c.id, () => createPerson.mutateAsync({ name, clusterId: c.id, allowDuplicate }))}
              onAssign={(pid) => act(c.id, () => assignCluster.mutateAsync({ clusterId: c.id, personId: pid }))}
              onHide={() => act(c.id, () => dismiss.mutateAsync(c.id))} />)}
          </div>
        </section>
      )}
      {d.lowConfidenceFaces.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">{t('isThisThem')}</h2>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {d.lowConfidenceFaces.map((f) => (
              <div key={f.id} className="card p-2 space-y-2">
                <div className="flex gap-2">
                  <FaceCrop faceId={f.id} className="w-16 aspect-square rounded" />
                  <Thumb blobId={f.blobId} className="flex-1 aspect-[4/3] rounded" />
                </div>
                <div className="text-[13px]">{t('candidate', { name: f.personName ?? namedPeople.find((p) => p.id === f.personId)?.name ?? t('unknown') })} <span className="text-ink-3">{f.matchScore != null ? `${Math.round(f.matchScore * 100)}%` : ''}</span></div>
                {f.personId != null && (
                  <div className="flex gap-1">
                    <button className="btn btn-primary flex-1 justify-center" onClick={() => label.mutate({ faceId: f.id, personId: f.personId!, verdict: 'confirm' })}>{t('yes')}</button>
                    <button className="btn flex-1 justify-center" onClick={() => label.mutate({ faceId: f.id, personId: f.personId!, verdict: 'reject' })}>{t('no')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {d.suggestedSplits.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">{t('maybeTwo')}</h2>
          <ul className="card divide-y divide-line">
            {d.suggestedSplits.map((s) => (
              <li key={s.eventId} className="p-3 flex flex-wrap items-center gap-3 text-[13px]">
                <Link href={`/events/${s.eventId}`} className="font-medium hover:text-accent">{s.title}</Link>
                {s.at.map((at) => <button key={at} className="btn" onClick={() => split.mutate({ eventId: s.eventId, at })}>{t('splitAt', { when: `${fmtDate(at, { day: 'numeric', month: 'short' })} ${fmtTime(at)}` })}</button>)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ClusterCard({ c, people, busy, error, onName, onAssign, onHide }: { c: UnknownCluster; people: Array<{ id: number; name: string | null }>; busy: boolean; error: string | null; onName: (name: string, allowDuplicate: boolean) => void; onAssign: (pid: number) => void; onHide: () => void }) {
  const t = useTranslations('review');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const trimmed = name.trim();
  // Typing a name that already exists attaches the faces to that person; a second person with the same name needs an explicit choice.
  const match = trimmed ? people.find((p) => (p.name ?? '').trim().toLowerCase() === trimmed.toLowerCase()) : undefined;
  const listId = `people-${c.id}`;
  const faces = c.faces?.map((f) => f.id) ?? c.faceIds;
  return (
    <div className={`card p-3 space-y-2${busy ? ' opacity-60' : ''}`} aria-busy={busy}>
      <div className="flex gap-1 overflow-hidden">{faces.slice(0, 6).map((f) => <FaceCrop key={f} faceId={f} className="w-14 aspect-square rounded" />)}<span className="self-center text-ink-3 text-[12px] ml-1">{t('photos', { count: c.n })}</span></div>
      <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (!trimmed || busy) return; if (match) onAssign(match.id); else onName(trimmed, false); }}>
        <input className="input" list={listId} placeholder={t('namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <datalist id={listId}>{people.map((p) => (p.name ? <option key={p.id} value={p.name} /> : null))}</datalist>
        <button className="btn btn-primary whitespace-nowrap" disabled={!trimmed || busy}>{match ? t('addTo', { name: match.name ?? tc('unnamed') }) : t('name')}</button>
      </form>
      {match && (
        <p className="text-[12px] text-ink-3">{t('matchesExisting', { name: match.name ?? tc('unnamed') })} <button type="button" className="underline" disabled={busy} onClick={() => onName(trimmed, true)}>{t('createAnother', { name: trimmed })}</button></p>
      )}
      <div className="flex gap-1">
        <select className="input" value="" disabled={busy} onChange={(e) => { if (e.target.value) onAssign(Number(e.target.value)); }} aria-label={t('existing')}>
          <option value="">{t('existing')}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name ?? tc('unnamed')}</option>)}
        </select>
        <button type="button" className="btn" disabled={busy} onClick={onHide}>{t('hide')}</button>
      </div>
      {error && <p className="text-danger text-[12px]">{error}</p>}
    </div>
  );
}

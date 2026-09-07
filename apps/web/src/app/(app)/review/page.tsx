'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useReview, usePeople, faceActions, peopleActions, eventActions, useAction } from '@/lib/hooks';
import { useGroupId } from '@/lib/group';
import { FaceCrop } from '@/components/FaceCrop';
import { Thumb } from '@/components/Thumb';
import { fmtDate, fmtTime } from '@/lib/format';
import type { UnknownCluster } from '@/lib/types';

/** Correction queue: unnamed clusters, low-confidence matches, suggested splits. Each action is one tap. */
export default function ReviewPage() {
  const g = useGroupId();
  const q = useReview();
  const people = usePeople();
  const d = q.data;
  const inv = () => [['review', g], ['people', g], ['events'], ['event']];
  const label = useAction((v: { faceId: string; personId: number; verdict: 'confirm' | 'reject' }) => faceActions.label(v.faceId, v.personId, v.verdict), inv);
  const createPerson = useAction((v: { name: string; clusterId: string }) => peopleActions.create(g, v), inv);
  const mergeCluster = useAction((v: { clusterId: string; personId: number; faceIds: string[] }) => Promise.all(v.faceIds.map((f) => faceActions.label(f, v.personId, 'confirm'))), inv);
  const dismiss = useAction((clusterId: string) => peopleActions.dismissCluster(g, clusterId), inv);
  const split = useAction((v: { eventId: string; at: string }) => eventActions.split(v.eventId, v.at), inv);
  const namedPeople = (people.data ?? []).filter((p) => !p.hidden);
  if (!d) return <p className="text-ink-3 text-sm">{q.isError ? 'Could not load the review queue.' : '…'}</p>;
  const empty = d.unnamedClusters.length === 0 && d.lowConfidenceFaces.length === 0 && d.suggestedSplits.length === 0;
  return (
    <div className="space-y-8">
      {empty && <p className="text-ink-2">Nothing to review. New faces and uncertain matches will show up here.</p>}
      {d.unnamedClusters.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">Unnamed people</h2>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {d.unnamedClusters.map((c) => <ClusterCard key={c.id} c={c} people={namedPeople}
              onName={(name) => createPerson.mutate({ name, clusterId: c.id })}
              onMerge={(pid) => mergeCluster.mutate({ clusterId: c.id, personId: pid, faceIds: c.faceIds })}
              onHide={() => dismiss.mutate(c.id)} />)}
          </div>
        </section>
      )}
      {d.lowConfidenceFaces.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">Is this them?</h2>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {d.lowConfidenceFaces.map((f) => (
              <div key={f.id} className="card p-2 space-y-2">
                <div className="flex gap-2">
                  <FaceCrop faceId={f.id} className="w-16 aspect-square rounded" />
                  <Thumb blobId={f.blobId} className="flex-1 aspect-[4/3] rounded" />
                </div>
                <div className="text-[13px]">{f.personName ?? namedPeople.find((p) => p.id === f.personId)?.name ?? 'Unknown'}? <span className="text-ink-3">{f.matchScore != null ? `${Math.round(f.matchScore * 100)}%` : ''}</span></div>
                {f.personId != null && (
                  <div className="flex gap-1">
                    <button className="btn btn-primary flex-1 justify-center" onClick={() => label.mutate({ faceId: f.id, personId: f.personId!, verdict: 'confirm' })}>Yes</button>
                    <button className="btn flex-1 justify-center" onClick={() => label.mutate({ faceId: f.id, personId: f.personId!, verdict: 'reject' })}>No</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {d.suggestedSplits.length > 0 && (
        <section>
          <h2 className="text-ink-3 text-xs uppercase tracking-wide mb-2">Might be two events</h2>
          <ul className="card divide-y divide-line">
            {d.suggestedSplits.map((s) => (
              <li key={s.eventId} className="p-3 flex flex-wrap items-center gap-3 text-[13px]">
                <Link href={`/events/${s.eventId}`} className="font-medium hover:text-accent">{s.title}</Link>
                {s.at.map((at) => <button key={at} className="btn" onClick={() => split.mutate({ eventId: s.eventId, at })}>Split at {fmtDate(at, { day: 'numeric', month: 'short' })} {fmtTime(at)}</button>)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ClusterCard({ c, people, onName, onMerge, onHide }: { c: UnknownCluster; people: Array<{ id: number; name: string | null }>; onName: (n: string) => void; onMerge: (pid: number) => void; onHide: () => void }) {
  const [name, setName] = useState('');
  const faces = c.faces?.map((f) => f.id) ?? c.faceIds;
  return (
    <div className="card p-3 space-y-2">
      <div className="flex gap-1 overflow-hidden">{faces.slice(0, 6).map((f) => <FaceCrop key={f} faceId={f} className="w-14 aspect-square rounded" />)}<span className="self-center text-ink-3 text-[12px] ml-1">{c.n} photos</span></div>
      <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onName(name.trim()); }}>
        <input className="input" placeholder="Name this person" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary" disabled={!name.trim()}>Name</button>
      </form>
      <div className="flex gap-1">
        <select className="input" defaultValue="" onChange={(e) => { if (e.target.value) onMerge(Number(e.target.value)); }}>
          <option value="">This is… (existing person)</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name ?? 'Unnamed'}</option>)}
        </select>
        <button type="button" className="btn" onClick={onHide}>Hide</button>
      </div>
    </div>
  );
}

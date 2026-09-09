'use client';
import Link from 'next/link';
import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useEvent, useEventMedia, useVisibility, useEvents, eventActions, useAction } from '@/lib/hooks';
import { useGroup } from '@/lib/group';
import { usePeopleIndex, useMemberIndex } from '@/components/indexes';
import { MediaGrid } from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import { Avatar, AvatarStack } from '@/components/Avatar';
import { useFormat, type Fmt } from '@/lib/format';
import type { EventDetail, MediaItem, Moment, VisibilityInfo } from '@/lib/types';
import { INTEREST } from '@minnegela/shared';

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations('event');
  const tc = useTranslations('common');
  const fmt = useFormat();
  const { fmtSpan, fmtTime, listNames } = fmt;
  const { id } = use(params);
  const ev = useEvent(id);
  const media = useEventMedia(id);
  const vis = useVisibility(id);
  const { me } = useGroup();
  const [viewer, setViewer] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showUncertain, setShowUncertain] = useState(false);
  const [personFilter, setPersonFilter] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'video'>('all');
  const inv = () => [['event', id], ['event-media', id], ['visibility', id], ['events'], ['review']];
  const rename = useAction((title: string) => eventActions.rename(id, title), inv);
  const open = useAction((on: boolean) => (on ? eventActions.open(id) : eventActions.close(id)), inv);
  const tag = useAction((pid: number) => eventActions.tag(id, pid), inv);
  const untag = useAction((pid: number) => eventActions.untag(id, pid), inv);
  const split = useAction((at: string) => eventActions.split(id, at), inv);
  const merge = useAction((withId: string) => eventActions.merge(id, withId), inv);
  const exclude = useAction((ids: string[]) => eventActions.exclude(id, ids), inv);
  const interest = useAction((v: 'keep' | 'quiet' | 'auto') => eventActions.interest(id, v), inv);

  const all = useMemo(() => media.data?.pages.flatMap((p) => p.items) ?? [], [media.data]);
  const filtered = useMemo(() => all.filter((m) => (personFilter == null || m.personIds.includes(personFilter)) && (typeFilter === 'all' || m.durationMs != null)), [all, personFilter, typeFilter]);
  const main = useMemo(() => filtered.filter((m) => m.membership?.tier !== 'uncertain'), [filtered]);
  const uncertain = useMemo(() => filtered.filter((m) => m.membership?.tier === 'uncertain'), [filtered]);
  // When nothing made it past 'uncertain' (common before faces are enrolled), an empty page
  // reads as broken; pin the uncertain section open instead.
  const showAllUncertain = showUncertain || (main.length === 0 && uncertain.length > 0);
  const viewerItems = showAllUncertain ? filtered : main;
  const moreLabel = t('more');

  if (ev.isError) return <div className="py-16 text-center text-ink-3">{t('notInView')}</div>;
  const d = ev.data;
  if (!d) return <div className="text-ink-3 text-sm">…</div>;
  const isContributor = !!me && d.contributorIds.includes(me.user.id);
  const contribNames = d.contributors.map((c) => c.displayName);
  const rows = buildMomentRows(d.moments, main, fmt, moreLabel);
  const uncertainCount = uncertain.length;
  const tod = t(`tod.${timeOfDay(d.startAt)}`);

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          <Title title={d.title} onSave={(x) => rename.mutate(x)} />
          {d.frozen && <span className="chip" title={t('frozenTitle')}>{t('frozen')}</span>}
        </div>
        <div className="text-ink-2">{fmtSpan(d.startAt, d.endAt)}{d.placeName ? ` · ${d.placeName}` : d.center ? ` · ${d.center.lat.toFixed(3)}, ${d.center.lon.toFixed(3)}` : ''}</div>
        <div className="text-[13px] text-ink-3">{t(`confidence.${d.confidenceKey}`)} · {t('photos', { count: d.nAssets })}{d.nVideos ? `, ${t('videos', { count: d.nVideos })}` : ''}</div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <span className="flex items-center gap-2">
            <AvatarStack people={d.participants.map((p) => ({ id: p.id, name: p.name }))} />
            <span className="text-ink-2">{listNames(d.participants.map((p) => p.name ?? tc('unnamed'))) || t('noOneYet')}</span>
          </span>
          <span className="text-ink-2">{t('from', { names: d.contributors.map((c) => `${c.displayName} (${c.nAssets})`).join(', ') })}</span>
        </div>
        <VisibilityLine v={vis.data} d={d} meId={me?.user.id ?? ''} />
        <div className="flex flex-wrap gap-2 pt-1">
          {isContributor && <OpenToggle d={d} contribNames={contribNames} onChange={(on) => open.mutate(on)} />}
          <TagPicker existing={d.personIds} onTag={(pid) => tag.mutate(pid)} onUntag={(pid) => untag.mutate(pid)} />
          {isContributor && <MergePicker d={d} onMerge={(w) => merge.mutate(w)} />}
          <InterestToggle d={d} onChange={(v) => interest.mutate(v)} />
          {selected.size > 0 && isContributor && <button className="btn btn-danger" onClick={() => { exclude.mutate([...selected]); setSelected(new Set()); }}>{t('removeSelected', { count: selected.size })}</button>}
          {selected.size > 0 && <button className="btn" onClick={() => setSelected(new Set())}>{t('clearSelection')}</button>}
        </div>
        {d.suggestedSplits.length > 0 && (
          <div className="banner flex flex-wrap items-center gap-2">
            {t('maybeTwo')}
            {d.suggestedSplits.map((at) => <button key={at} className="btn !py-0.5" onClick={() => split.mutate(at)}>{t('splitAt', { time: fmtTime(at) })}</button>)}
          </div>
        )}
      </header>

      <div className="flex flex-wrap gap-2 text-[13px] items-center">
        <span className="text-ink-3">{t('show')}</span>
        <button className={`chip ${personFilter == null && typeFilter === 'all' ? 'bg-accent-soft text-accent border-transparent' : ''}`} onClick={() => { setPersonFilter(null); setTypeFilter('all'); }}>{t('everything')}</button>
        {d.participants.map((p) => <button key={p.id} className={`chip ${personFilter === p.id ? 'bg-accent-soft text-accent border-transparent' : ''}`} onClick={() => setPersonFilter(personFilter === p.id ? null : p.id)}>{t('justPerson', { name: p.name ?? tc('unnamed') })}</button>)}
        {d.nVideos > 0 && <button className={`chip ${typeFilter === 'video' ? 'bg-accent-soft text-accent border-transparent' : ''}`} onClick={() => setTypeFilter(typeFilter === 'video' ? 'all' : 'video')}>{t('justVideos')}</button>}
        {media.isLoading && <span className="text-ink-3">{t('loadingMedia')}</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <section className="space-y-6">
          {rows.map((r, i) => (
            <div key={r.key} className="space-y-2">
              <div className="flex items-center gap-3 text-[13px]">
                <span className="font-medium tabular-nums">{fmtTime(r.startAt)}</span>
                {r.label && <span className="text-ink-2">{r.label}</span>}
                {r.delta && <span className="text-ink-3">{r.delta}</span>}
                <span className="text-ink-3">{r.items.length}</span>
                {isContributor && i > 0 && <button className="ml-auto text-ink-3 hover:text-accent" title={t('splitHereTitle')} onClick={() => split.mutate(r.startAt)}>{t('splitHere')}</button>}
              </div>
              <MediaGrid items={r.items} onOpen={(m) => setViewer(viewerItems.indexOf(m))} selected={selected} onToggle={isContributor ? (aid) => setSelected((s) => { const n = new Set(s); n.has(aid) ? n.delete(aid) : n.add(aid); return n; }) : undefined} />
            </div>
          ))}
          {rows.length === 0 && uncertainCount === 0 && !media.isLoading && <p className="text-ink-3">{t('noMedia')}</p>}
          {uncertainCount > 0 && (
            <div className="border-t border-line pt-3">
              <button className="text-[13px] text-ink-2 hover:text-ink" onClick={() => setShowUncertain((s) => !s)}>{showAllUncertain ? '▾' : '▸'} {rows.length === 0 ? t('probablyFrom', { tod }) : t('alsoPossiblyFrom', { tod })} ({uncertainCount})</button>
              {showAllUncertain && <div className="mt-2"><MediaGrid items={uncertain} onOpen={(m) => setViewer(viewerItems.indexOf(m))} selected={selected} onToggle={isContributor ? (aid) => setSelected((s) => { const n = new Set(s); n.has(aid) ? n.delete(aid) : n.add(aid); return n; }) : undefined} /></div>}
            </div>
          )}
        </section>
        <aside className="rail space-y-4 text-[13px]">
          <div className="card p-3 space-y-2">
            <h3 className="font-medium">{t('people')}</h3>
            {d.participants.length === 0 && <p className="text-ink-3">{t('noOneYetDot')}</p>}
            {d.participants.map((p) => {
              const n = all.filter((m) => m.personIds.includes(p.id)).length;
              return <Link key={p.id} href={`/people/${p.id}`} className="flex items-center gap-2 hover:text-accent"><Avatar name={p.name} seed={p.id} size={22} /><span className="flex-1">{p.name ?? tc('unnamed')}</span><span className="text-ink-3 tabular-nums">{n || t('tagged')}</span></Link>;
            })}
          </div>
          <div className="card p-3 space-y-2">
            <h3 className="font-medium">{t('contributors')}</h3>
            {d.contributors.map((c) => <div key={c.userId} className="flex items-center gap-2"><Avatar name={c.displayName} seed={c.userId} size={22} /><span className="flex-1">{c.displayName}</span><span className="text-ink-3 tabular-nums">{c.nAssets}</span></div>)}
          </div>
          <div className="card p-3 space-y-1">
            <h3 className="font-medium">{t('timeline')}</h3>
            {d.moments.map((m) => <a key={m.id} href={`#m-${m.id}`} className="block text-ink-2 hover:text-ink"><span className="tabular-nums">{fmtTime(m.startAt)}</span> {m.label ?? ''} <span className="text-ink-3">{m.nAssets}</span></a>)}
            {d.center && <a className="block text-accent pt-1" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${d.center.lat}&mlon=${d.center.lon}#map=16/${d.center.lat}/${d.center.lon}`}>{t('openOsm')}</a>}
          </div>
          <p className="text-ink-3 text-[12px]">{t('railNote')}</p>
        </aside>
      </div>
      {viewer !== null && <MediaViewer items={viewerItems} index={viewer} onClose={() => setViewer(null)} onIndex={setViewer} />}
    </div>
  );
}

/** Rows of the timeline: moments from the API, each filled with the media whose blob it lists; leftovers get their own row by time. */
function buildMomentRows(moments: Moment[], items: MediaItem[], fmt: Fmt, moreLabel: string) {
  const byBlob = new Map(items.map((m) => [m.blobId, m]));
  const used = new Set<string>();
  const rows: Array<{ key: string; startAt: string; label: string | null; delta: string | null; items: MediaItem[]; center?: { lat: number; lon: number } | null }> = [];
  let prevCenter: { lat: number; lon: number } | null = null;
  for (const mo of [...moments].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    const its = mo.blobIds.map((b) => byBlob.get(b)).filter((x): x is MediaItem => !!x);
    for (const i of its) used.add(i.assetId);
    if (!its.length) continue;
    const gps = its.find((i) => i.lat != null && i.lon != null);
    const center = gps ? { lat: gps.lat!, lon: gps.lon! } : null;
    rows.push({ key: mo.id, startAt: mo.startAt, label: mo.label, delta: fmt.kmDelta(prevCenter, center), items: its.sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '')), center });
    if (center) prevCenter = center;
  }
  const rest = items.filter((i) => !used.has(i.assetId)).sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
  if (rest.length) {
    if (!rows.length) {
      // no moments yet: bucket by 20-minute gaps so the page still reads as a timeline
      let cur: MediaItem[] = [];
      let last = 0;
      const flush = () => { if (cur.length) rows.push({ key: `r-${rows.length}`, startAt: cur[0]!.capturedAt ?? '', label: null, delta: null, items: cur }); cur = []; };
      for (const m of rest) {
        const t = m.capturedAt ? Date.parse(m.capturedAt) : last;
        if (cur.length && t - last > 20 * 60_000) flush();
        cur.push(m); last = t;
      }
      flush();
    } else rows.push({ key: 'rest', startAt: rest[0]!.capturedAt ?? '', label: moreLabel, delta: null, items: rest });
  }
  return rows.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function timeOfDay(iso: string): 'night' | 'afternoon' | 'morning' { const h = new Date(iso).getHours(); return h >= 18 || h < 5 ? 'night' : h >= 12 ? 'afternoon' : 'morning'; }

function Title({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const t = useTranslations('event');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  if (!editing) return <h1 className="text-2xl font-semibold tracking-tight cursor-text" title={t('clickToRename')} onClick={() => { setV(title); setEditing(true); }}>{title}</h1>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim() && v.trim() !== title) onSave(v.trim()); setEditing(false); }} className="flex gap-2 items-center">
      <input className="input text-xl font-semibold max-w-lg" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} aria-label={t('titleLabel')} />
      <button className="btn btn-primary">{tc('save')}</button>
      <button type="button" className="btn" onClick={() => setEditing(false)}>{tc('cancel')}</button>
    </form>
  );
}

/** §18.3 header copy: who can see this and why. */
function VisibilityLine({ v, d, meId }: { v: VisibilityInfo | undefined; d: EventDetail; meId: string }) {
  const t = useTranslations('event');
  const tc = useTranslations('common');
  const { listNames } = useFormat();
  if (!v) return <div className="text-[13px] text-ink-3">{d.isPublicToGroup ? t('visibleGroup') : t('visiblePeople')}</div>;
  if (v.isPublicToGroup) return <div className="text-[13px] text-ink-2">{t('visibleGroup')}{v.openedBy ? ` ${t('openedBy', { name: v.openedBy.displayName })}` : ''}</div>;
  const you = tc('you');
  const names = v.viewers.map((x) => (x.userId === meId ? you : x.displayName));
  const ordered = [...names.filter((n) => n === you), ...names.filter((n) => n !== you)];
  return (
    <div className="text-[13px] text-ink-2" title={v.viewers.map((x) => `${x.displayName}: ${x.reasons.map((r) => t(`reason.${r}`)).join(', ')}`).join('\n')}>
      {t('visibleTo', { names: listNames(ordered) || t('nobodyYet') })}
    </div>
  );
}

/** §9.11 feed ranking feedback. "Quiet" folds the event out of the river and teaches the place's routine factor. */
function InterestToggle({ d, onChange }: { d: EventDetail; onChange: (v: 'keep' | 'quiet' | 'auto') => void }) {
  const t = useTranslations('event.interest');
  const quiet = d.interest != null && d.interest < INTEREST.quiet;
  if (d.interestManual === -1) return <button className="btn" title={t('markedQuietTitle')} onClick={() => onChange('auto')}>{t('markedQuiet')}</button>;
  if (d.interestManual === 1) return <button className="btn" title={t('keptTitle')} onClick={() => onChange('auto')}>{t('kept')}</button>;
  return quiet
    ? <button className="btn" title={t('keepTitle')} onClick={() => onChange('keep')}>{t('keep')}</button>
    : <button className="btn" title={t('quietTitle')} onClick={() => onChange('quiet')}>{t('quiet')}</button>;
}

function OpenToggle({ d, contribNames, onChange }: { d: EventDetail; contribNames: string[]; onChange: (on: boolean) => void }) {
  const t = useTranslations('event.open');
  const tc = useTranslations('common');
  const { listNames } = useFormat();
  const ref = useRef<HTMLDialogElement>(null);
  if (d.isPublicToGroup) return <button className="btn" onClick={() => onChange(false)}>{t('stop')}</button>;
  return (
    <>
      <button className="btn" onClick={() => ref.current?.showModal()}>{t('show')}</button>
      <dialog ref={ref}>
        <h3 className="font-medium mb-2">{t('confirmTitle')}</h3>
        <p className="text-[13px] text-ink-2">{t('confirmBody', { count: d.nAssets, names: listNames(contribNames) })}</p>
        <div className="flex gap-2 justify-end mt-4">
          <button className="btn" onClick={() => ref.current?.close()}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={() => { ref.current?.close(); onChange(true); }}>{t('confirm')}</button>
        </div>
      </dialog>
    </>
  );
}

function TagPicker({ existing, onTag, onUntag }: { existing: number[]; onTag: (pid: number) => void; onUntag: (pid: number) => void }) {
  const t = useTranslations('event.tag');
  const tc = useTranslations('common');
  const people = usePeopleIndex();
  const [openMenu, setOpenMenu] = useState(false);
  const options = [...people.values()].filter((p) => !p.hidden);
  return (
    <span className="relative">
      <button className="btn" onClick={() => setOpenMenu((o) => !o)}>{t('button')}</button>
      {openMenu && (
        <div className="absolute z-20 mt-1 card p-1 min-w-52 max-h-72 overflow-y-auto shadow-lg">
          {options.length === 0 && <div className="p-2 text-ink-3 text-[13px]">{t('none')}</div>}
          {options.map((p) => {
            const on = existing.includes(p.id);
            return <button key={p.id} className="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-accent-soft text-[13px]" onClick={() => { on ? onUntag(p.id) : onTag(p.id); setOpenMenu(false); }}><Avatar name={p.name} seed={p.id} size={20} /><span className="flex-1">{p.name ?? tc('unnamed')}</span>{on && <span className="text-ink-3">{t('remove')}</span>}</button>;
          })}
        </div>
      )}
    </span>
  );
}

/** Adjacent events (previous/next in time) as merge targets. */
function MergePicker({ d, onMerge }: { d: EventDetail; onMerge: (withEventId: string) => void }) {
  const t = useTranslations('event.merge');
  const te = useTranslations('event');
  const { fmtDate, listNames } = useFormat();
  const from = new Date(new Date(d.startAt).getTime() - 36 * 3600_000).toISOString();
  const to = new Date(new Date(d.endAt).getTime() + 36 * 3600_000).toISOString();
  const q = useEvents({ from, to });
  const members = useMemberIndex();
  const neighbours = (q.data?.pages.flatMap((p) => p.items) ?? []).filter((e) => e.id !== d.id && e.kind !== 'loose').slice(0, 4);
  const [openMenu, setOpenMenu] = useState(false);
  if (!neighbours.length) return null;
  return (
    <span className="relative">
      <button className="btn" onClick={() => setOpenMenu((o) => !o)}>{t('button')}</button>
      {openMenu && (
        <div className="absolute z-20 mt-1 card p-1 min-w-64 shadow-lg">
          {neighbours.map((e) => (
            <button key={e.id} className="block w-full text-left px-2 py-1.5 rounded hover:bg-accent-soft text-[13px]" onClick={() => { setOpenMenu(false); if (confirm(t('confirm', { title: e.title, names: listNames([...new Set([...d.contributorIds, ...e.contributorIds])].map((u) => members.get(u)?.displayName ?? '…')) }))) onMerge(e.id); }}>
              <div className="font-medium">{e.title}</div><div className="text-ink-3">{fmtDate(e.startAt, { day: 'numeric', month: 'short' })} · {te('photos', { count: e.nAssets })}</div>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

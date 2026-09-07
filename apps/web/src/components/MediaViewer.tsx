'use client';
import Link from 'next/link';
import { useEffect, useCallback } from 'react';
import type { MediaItem } from '@/lib/types';
import { useMedia } from '@/lib/hooks';
import { useMediaUrl } from '@/lib/urls';
import { fmtDate, fmtTime, cleanTag } from '@/lib/format';
import { useMemberIndex, usePeopleIndex } from './indexes';
import { Thumb } from './Thumb';

/** Full-screen viewer with keyboard navigation (←/→/Esc). Shows the preview; videos play the 720p transcode. */
export function MediaViewer({ items, index, onClose, onIndex }: { items: MediaItem[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const item = items[index];
  const detail = useMedia(item?.blobId ?? null);
  const isVideo = item?.durationMs != null || (item?.mime.startsWith('video/') ?? false);
  const preview = useMediaUrl(item?.blobId, 'preview');
  const video = useMediaUrl(isVideo ? item?.blobId : null, 'video720');
  const orig = useMediaUrl(item?.hasOriginal ? item.blobId : null, 'orig');
  const members = useMemberIndex();
  const people = usePeopleIndex();
  const prev = useCallback(() => onIndex(Math.max(0, index - 1)), [index, onIndex]);
  const next = useCallback(() => onIndex(Math.min(items.length - 1, index + 1)), [index, items.length, onIndex]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); else if (e.key === 'ArrowLeft') prev(); else if (e.key === 'ArrowRight') next(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, prev, next]);
  if (!item) return null;
  const d = detail.data;
  const owner = members.get(item.ownerUserId)?.displayName ?? d?.ownerName ?? '';
  const pids = d?.people?.map((p) => p.id) ?? item.personIds;
  return (
    <div className="viewer" role="dialog" aria-modal="true">
      <div className="relative flex items-center justify-center select-none">
        <button onClick={onClose} className="absolute top-3 left-3 z-10 text-white/80 hover:text-white text-2xl leading-none" aria-label="Close">×</button>
        <span className="absolute top-4 right-4 text-xs text-white/60">{index + 1} / {items.length}</span>
        {index > 0 && <button onClick={prev} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/70 hover:text-white text-3xl px-2" aria-label="Previous">‹</button>}
        {index < items.length - 1 && <button onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/70 hover:text-white text-3xl px-2" aria-label="Next">›</button>}
        {isVideo && video ? (
          <video src={video} poster={preview ?? undefined} controls autoPlay className="max-h-screen max-w-full" />
        ) : preview ? (
          <img src={preview} alt="" className="max-h-screen max-w-full object-contain" />
        ) : (
          <Thumb blobId={item.blobId} className="max-h-[70vh] w-auto aspect-[4/3]" cover={false} />
        )}
      </div>
      <aside className="border-l border-white/10 p-4 overflow-y-auto text-[13px] space-y-4 bg-black/40">
        <div>
          <div className="text-white/60">{owner ? `From ${owner}’s phone` : ''}</div>
          <div className="font-medium">{item.capturedAt ? `${fmtDate(item.capturedAt)} · ${fmtTime(item.capturedAt)}` : 'Unknown time'}</div>
          <div className="text-white/60">{d?.placeName ?? d?.city ?? (item.lat != null ? `${item.lat.toFixed(4)}, ${item.lon?.toFixed(4)}` : 'No location')}</div>
          {item.membership && item.membership.tier !== 'confirmed' && <div className="mt-1 text-amber">{item.membership.tier === 'probable' ? 'Probably part of this event' : 'Possibly part of this event'}</div>}
        </div>
        {pids.length > 0 && (
          <div>
            <div className="text-white/50 uppercase text-[10px] tracking-wide mb-1">People</div>
            <div className="flex flex-wrap gap-1">{pids.map((id) => <Link key={id} href={`/people/${id}`} className="chip !bg-white/10 !border-white/10">{people.get(id)?.name ?? d?.people?.find((p) => p.id === id)?.name ?? 'Unnamed'}</Link>)}</div>
          </div>
        )}
        {item.tags.length > 0 && (
          <div>
            <div className="text-white/50 uppercase text-[10px] tracking-wide mb-1">Looks like</div>
            <div className="flex flex-wrap gap-1">{item.tags.slice(0, 5).map((t) => <span key={t.tag} className="chip !bg-white/10 !border-white/10">{cleanTag(t.tag)}</span>)}</div>
          </div>
        )}
        {d?.events && d.events.length > 0 && (
          <div>
            <div className="text-white/50 uppercase text-[10px] tracking-wide mb-1">Event</div>
            {d.events.map((e) => <Link key={e.id} href={`/events/${e.id}`} className="block underline underline-offset-2">{e.title}</Link>)}
          </div>
        )}
        {d?.otherAngles && d.otherAngles.length > 0 && (
          <div>
            <div className="text-white/50 uppercase text-[10px] tracking-wide mb-1">Other angles of this moment</div>
            <div className="grid grid-cols-3 gap-1">{d.otherAngles.map((m) => <Thumb key={m.blobId} blobId={m.blobId} className="aspect-square rounded" />)}</div>
          </div>
        )}
        {d?.similar && d.similar.length > 0 && (
          <div>
            <div className="text-white/50 uppercase text-[10px] tracking-wide mb-1">Similar photos</div>
            <div className="grid grid-cols-3 gap-1">{d.similar.map((m) => <Thumb key={m.blobId} blobId={m.blobId} className="aspect-square rounded" />)}</div>
          </div>
        )}
        <div className="pt-2 flex gap-2">
          {orig && <a href={orig} download className="btn !bg-white/10 !border-white/10 !text-white">Download original</a>}
          {!item.hasOriginal && <span className="text-white/40">Original not uploaded yet</span>}
        </div>
      </aside>
    </div>
  );
}

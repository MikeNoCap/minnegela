'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { EventCard as EventCardT } from '@/lib/types';
import { useFormat } from '@/lib/format';
import { Thumb } from './Thumb';
import { AvatarStack } from './Avatar';
import { usePeopleIndex, useMemberIndex } from './indexes';
import { INTEREST } from '@minnegela/shared';

export function EventCard({ ev, covers }: { ev: EventCardT; covers?: string[] }) {
  const t = useTranslations('eventCard');
  const { fmtSpan } = useFormat();
  const people = usePeopleIndex();
  const members = useMemberIndex();
  const blobs = (covers && covers.length ? covers : ev.coverBlobId ? [ev.coverBlobId] : []).slice(0, 4);
  const participants = ev.personIds.map((id) => ({ id, name: people.get(id)?.name ?? null }));
  const contribs = ev.contributorIds.map((id) => ({ id, name: members.get(id)?.displayName ?? null }));
  const n = blobs.length;
  const quiet = ev.interest != null && ev.interest < INTEREST.quiet;
  return (
    <Link href={`/events/${ev.id}`} className={`card block overflow-hidden hover:border-ink-3 transition-colors${quiet ? ' opacity-70' : ''}`}>
      {n > 0 ? (
        <div className={`mosaic n${Math.min(n, 4)}`}>{blobs.map((b) => <Thumb key={b} blobId={b} className="w-full h-full" />)}</div>
      ) : (
        <div className="tile aspect-[16/10] rounded-t-[.5rem] flex items-center justify-center text-ink-3 text-xs">{t('noPreview')}</div>
      )}
      <div className="p-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-medium text-[15px] leading-tight truncate">{ev.title}</h3>
          {ev.isPublicToGroup && <span className="chip text-ink-3 shrink-0" title={t('openTitle')}>{t('open')}</span>}
          {quiet && <span className="chip text-ink-3 shrink-0" title={t('quietTitle')}>{t('quiet')}</span>}
        </div>
        <div className="text-ink-2 text-[13px]">{fmtSpan(ev.startAt, ev.endAt)}{ev.placeName ? ` · ${ev.placeName}` : ''}</div>
        <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
          <span>{t('photos', { count: ev.nAssets })}{ev.nVideos ? ` (${t('videos', { count: ev.nVideos })})` : ''} · {t('contributors', { count: contribs.length })} · {t('people', { count: participants.length })}</span>
          <span className="flex items-center gap-2">
            <AvatarStack people={participants} size={20} />
          </span>
        </div>
      </div>
    </Link>
  );
}

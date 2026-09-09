'use client';
import { useTranslations } from 'next-intl';
import type { MediaItem } from '@/lib/types';
import { Thumb } from './Thumb';
import { Avatar } from './Avatar';
import { useMemberIndex } from './indexes';

export function MediaGrid({ items, onOpen, selected, onToggle, showOwner = true }: {
  items: MediaItem[];
  onOpen: (item: MediaItem) => void;
  selected?: Set<string>;
  onToggle?: (assetId: string) => void;
  showOwner?: boolean;
}) {
  const t = useTranslations('mediaGrid');
  const members = useMemberIndex();
  return (
    <div className="grid-media">
      {items.map((m) => {
        const ratio = m.width && m.height ? m.width / m.height : 1;
        const shape = ratio > 1.6 ? 'wide' : ratio < 0.65 ? 'tall' : '';
        const sel = selected?.has(m.assetId);
        const owner = members.get(m.ownerUserId);
        return (
          <div key={m.assetId} className={`tile relative rounded overflow-hidden group ${shape} ${sel ? 'outline outline-2 outline-accent' : ''}`}>
            <button className="absolute inset-0 w-full h-full" onClick={() => onOpen(m)} aria-label={t('open')}>
              <Thumb blobId={m.blobId} className="w-full h-full" />
            </button>
            {m.durationMs != null && <span className="absolute right-1 top-1 text-[10px] px-1 rounded bg-black/60 text-white">▶ {Math.round(m.durationMs / 1000)}s</span>}
            {showOwner && <span className="absolute right-1 bottom-1 pointer-events-none"><Avatar name={owner?.displayName ?? '?'} seed={m.ownerUserId} size={18} /></span>}
            {m.membership?.tier === 'probable' && <span className="probably">{t('probably')}</span>}
            {onToggle && (
              <button onClick={(e) => { e.stopPropagation(); onToggle(m.assetId); }} aria-label={t('select')} className={`absolute left-1 top-1 w-5 h-5 rounded-full border ${sel ? 'bg-accent border-accent' : 'bg-black/40 border-white/70 opacity-0 group-hover:opacity-100'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

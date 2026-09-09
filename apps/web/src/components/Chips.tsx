'use client';
import { useTranslations } from 'next-intl';
import type { SearchChip } from '@/lib/types';

const COLORS: Record<SearchChip['kind'], string> = {
  person: 'bg-accent-soft text-accent border-transparent',
  time: 'bg-amber-soft text-amber border-transparent',
  place: 'bg-[color-mix(in_srgb,var(--surface),#2a9d8f_18%)] text-[#1f7a70] border-transparent',
  event: 'bg-[color-mix(in_srgb,var(--surface),#e76f51_18%)] text-[#b3452d] border-transparent',
  contributor: 'bg-surface text-ink-2',
  type: 'bg-surface text-ink-2',
  semantic: 'bg-surface text-ink-2 italic',
  tag: 'bg-surface text-ink-2',
};

export function Chip({ chip, onRemove }: { chip: SearchChip; onRemove?: () => void }) {
  const t = useTranslations('chips');
  const kind = t.has(`kind.${chip.kind}`) ? t(`kind.${chip.kind}`) : chip.kind;
  return (
    <span className={`chip ${COLORS[chip.kind] ?? ''}`} title={`${kind}: ${chip.text}`}>
      <span className="opacity-60 text-[10px] uppercase tracking-wide">{kind}</span>
      {chip.label}
      {onRemove && <button aria-label={t('remove', { label: chip.label })} onClick={onRemove} className="ml-0.5 opacity-60 hover:opacity-100">×</button>}
    </span>
  );
}

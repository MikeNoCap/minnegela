'use client';
import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTimelineOverview } from '@/lib/hooks';
import { BraidTimeline, type BraidMode } from '@/components/braid/BraidTimeline';

export default function TimelinePage() { return <Suspense><Timeline /></Suspense>; }

/** URL state: ?with=1,2 (strands to follow) · ?mode=people|contributors · ?day=YYYY-MM-DD (an expanded loose-photo day). */
function Timeline() {
  const t = useTranslations('timeline');
  const params = useSearchParams();
  const router = useRouter();
  const q = useTimelineOverview();
  const mode: BraidMode = params.get('mode') === 'contributors' ? 'contributors' : 'people';
  const selected = (params.get('with') ?? '').split(',').filter(Boolean);
  const day = params.get('day');
  const set = useCallback((patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/timeline${p.size ? `?${p}` : ''}`, { scroll: false });
  }, [params, router]);
  const events = q.data?.items ?? [];
  if (q.isLoading) return <p className="text-ink-3 text-sm">{t('loading')}</p>;
  if (!events.length) {
    return (
      <div className="card p-6 text-center space-y-2">
        <p className="font-medium">{t('emptyTitle')}</p>
        <p className="text-ink-2 text-sm">{t('emptyBody')}</p>
      </div>
    );
  }
  return (
    <BraidTimeline
      events={events}
      mode={mode}
      selected={selected}
      day={day}
      onSelect={(keys) => set({ with: keys.join(',') || null })}
      onMode={(m) => set({ mode: m === 'people' ? null : m, with: null })}
      onDay={(d) => set({ day: d })}
    />
  );
}

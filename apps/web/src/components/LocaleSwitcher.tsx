'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LOCALES, type Locale } from '@minnegela/shared';
import { setLocale } from '@/i18n/actions';

const NAMES: Record<Locale, string> = { nb: 'Norsk', en: 'English' };

export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations('locale');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <select
      className={`input w-auto! py-1 ${className}`}
      value={locale}
      aria-label={t('label')}
      disabled={pending}
      onChange={(e) => start(async () => { await setLocale(e.target.value); router.refresh(); })}
    >
      {LOCALES.map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}
    </select>
  );
}

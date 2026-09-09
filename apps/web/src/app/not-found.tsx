import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('notFound');
  return <main className="min-h-screen flex flex-col items-center justify-center gap-2 text-ink-2"><p>{t('title')}</p><Link href="/" className="text-accent">{t('home')}</Link></main>;
}

'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { authClient } from '@/lib/auth';
import { useAuthErrorMessage } from '@/lib/errors';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

function LoginForm() {
  const t = useTranslations('login');
  const authError = useAuthErrorMessage();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const callbackURL = `${location.origin}${next.startsWith('/') ? next : '/'}`;
    const r = await authClient.signIn.magicLink({ email: email.trim(), callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: `${location.origin}/login?error=link` });
    setBusy(false);
    if (r.error) setErr(authError(r.error)); else setSent(true);
  }
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Minnegela</h1>
            <p className="text-ink-2 mt-1">{t('tagline')}</p>
          </div>
          <LocaleSwitcher />
        </div>
        {sent ? (
          <div className="card p-4 space-y-2">
            <p className="font-medium">{t('checkInbox')}</p>
            <p className="text-ink-2 text-sm">{t.rich('sentTo', { email, b: (c) => <b>{c}</b> })}</p>
            <button className="btn" onClick={() => setSent(false)}>{t('useDifferent')}</button>
          </div>
        ) : (
          <form className="card p-4 space-y-3" onSubmit={submit}>
            <label className="block text-sm text-ink-2" htmlFor="email">{t('email')}</label>
            <input id="email" type="email" className="input" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="btn btn-primary w-full justify-center" disabled={busy}>{t('sendLink')}</button>
            {params.get('error') && <p className="text-danger text-sm">{t('linkInvalid')}</p>}
            {err && <p className="text-danger text-sm">{err}</p>}
          </form>
        )}
        <p className="text-xs text-ink-3">{t('privacy')}</p>
      </div>
    </main>
  );
}

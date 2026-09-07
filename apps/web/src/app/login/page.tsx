'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth';

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

function LoginForm() {
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
    if (r.error) setErr(r.error.message ?? 'Could not send the link'); else setSent(true);
  }
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Minnegela</h1>
          <p className="text-ink-2 mt-1">A search engine for your friend group’s memories.</p>
        </div>
        {sent ? (
          <div className="card p-4 space-y-2">
            <p className="font-medium">Check your inbox</p>
            <p className="text-ink-2 text-sm">We sent a sign-in link to <b>{email}</b>. In development the link is printed in the API console.</p>
            <button className="btn" onClick={() => setSent(false)}>Use a different address</button>
          </div>
        ) : (
          <form className="card p-4 space-y-3" onSubmit={submit}>
            <label className="block text-sm text-ink-2" htmlFor="email">Email</label>
            <input id="email" type="email" className="input" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="btn btn-primary w-full justify-center" disabled={busy}>Send me a sign-in link</button>
            {params.get('error') && <p className="text-danger text-sm">That link was invalid or expired. Request a new one.</p>}
            {err && <p className="text-danger text-sm">{err}</p>}
          </form>
        )}
        <p className="text-xs text-ink-3">Friends only ever see events you were at together. Everything else stays yours.</p>
      </div>
    </main>
  );
}

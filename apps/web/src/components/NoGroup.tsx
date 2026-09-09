'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useGroup } from '@/lib/group';
import { groupActions } from '@/lib/hooks';
import { useApiErrorMessage } from '@/lib/errors';
import { LocaleSwitcher } from './LocaleSwitcher';

export function NoGroup() {
  const t = useTranslations('noGroup');
  const errorMessage = useApiErrorMessage();
  const { refresh, setGroupId } = useGroup();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ id?: string; groupId?: string }>) {
    setBusy(true); setErr(null);
    try { const r = await fn(); const id = r.id ?? r.groupId; if (id) setGroupId(id); refresh(); }
    catch (e) { setErr(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <main className="max-w-md mx-auto p-8 space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-ink-2 mt-1">{t('intro')}</p>
        </div>
        <LocaleSwitcher />
      </div>
      <form className="card p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void run(() => groupActions.create(name.trim())); }}>
        <h2 className="font-medium">{t('startGroup')}</h2>
        <input className="input" placeholder={t('groupName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{t('create')}</button>
      </form>
      <form className="card p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void run(() => groupActions.accept(code.trim())); }}>
        <h2 className="font-medium">{t('joinTitle')}</h2>
        <input className="input" placeholder={t('inviteCode')} value={code} onChange={(e) => setCode(e.target.value)} required />
        <button className="btn" disabled={busy || !code.trim()}>{t('join')}</button>
      </form>
      {err && <p className="text-danger text-sm">{err}</p>}
    </main>
  );
}

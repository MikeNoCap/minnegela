'use client';
import { useState } from 'react';
import { useGroup } from '@/lib/group';
import { groupActions } from '@/lib/hooks';
import { ApiError } from '@/lib/api';

export function NoGroup() {
  const { refresh, setGroupId } = useGroup();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ id?: string; groupId?: string }>) {
    setBusy(true); setErr(null);
    try { const r = await fn(); const id = r.id ?? r.groupId; if (id) setGroupId(id); refresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong'); }
    finally { setBusy(false); }
  }
  return (
    <main className="max-w-md mx-auto p-8 space-y-8">
      <div>
        <h1 className="text-xl font-semibold">You are not in a group yet</h1>
        <p className="text-ink-2 mt-1">Friends only ever see events you were at together. Everything else stays yours.</p>
      </div>
      <form className="card p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void run(() => groupActions.create(name.trim())); }}>
        <h2 className="font-medium">Start a group</h2>
        <input className="input" placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>Create</button>
      </form>
      <form className="card p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void run(() => groupActions.accept(code.trim())); }}>
        <h2 className="font-medium">Join with an invite code</h2>
        <input className="input" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} required />
        <button className="btn" disabled={busy || !code.trim()}>Join</button>
      </form>
      {err && <p className="text-danger text-sm">{err}</p>}
    </main>
  );
}

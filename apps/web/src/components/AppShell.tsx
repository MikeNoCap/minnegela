'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useGroup } from '@/lib/group';
import { useStatus } from '@/lib/hooks';
import { authClient } from '@/lib/auth';
import { Avatar } from './Avatar';
import { NoGroup } from './NoGroup';

const NAV = [
  ['/', 'Home'],
  ['/search', 'Search'],
  ['/people', 'People'],
  ['/timeline', 'Timeline'],
  ['/map', 'Map'],
  ['/review', 'Review'],
  ['/group', 'Group'],
] as const;

/** Client shell: requires a session and a group. Renders nothing for the API-less build. */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, group, groupId, setGroupId, loading } = useGroup();
  const path = usePathname();
  const router = useRouter();
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!loading && !me) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, router, path]);
  if (loading || !me) return <div className="p-8 text-ink-3 text-sm">…</div>;
  if (!group || !groupId) return <NoGroup />;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-bg/90 backdrop-blur border-b border-line">
        <div className="max-w-7xl mx-auto px-4 h-12 flex items-center gap-4">
          <Link href="/" className="font-semibold tracking-tight">Minnegela</Link>
          <nav className="hidden md:flex items-center gap-1 text-[13px]">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className={`px-2 py-1 rounded-md ${path === href || (href !== '/' && path.startsWith(href)) ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:text-ink'}`}>{label}</Link>
            ))}
          </nav>
          <form className="ml-auto flex-1 max-w-md" onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <input className="input py-1" placeholder="Emma and Jonas · party in March · beach" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          </form>
          {me.groups.length > 1 && (
            <select className="input w-auto py-1" value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Group">
              {me.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <button className="flex items-center gap-2" title={me.user.email} onClick={async () => { await authClient.signOut(); router.replace('/login'); }}>
            <Avatar name={me.user.displayName ?? me.user.name ?? me.user.email} seed={me.user.id} size={26} />
          </button>
        </div>
        <nav className="md:hidden flex overflow-x-auto gap-1 px-3 pb-2 text-[13px]">
          {NAV.map(([href, label]) => <Link key={href} href={href} className={`px-2 py-0.5 rounded-md whitespace-nowrap ${path === href ? 'bg-accent-soft text-accent' : 'text-ink-2'}`}>{label}</Link>)}
        </nav>
      </header>
      <ProcessingBanner />
      <main className="max-w-7xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}

/** §17.5: a quiet line, never a spinner over data that already exists. */
function ProcessingBanner() {
  const s = useStatus();
  const n = s.data?.analyzing ?? s.data?.pendingAnalyze ?? s.data?.queues?.filter((q) => q.kind === 'analyze' || q.kind === 'derive').reduce((a, q) => a + q.pending + q.running, 0) ?? 0;
  if (!n) return null;
  return <div className="max-w-7xl mx-auto px-4 pt-3"><div className="banner">{n} item{n === 1 ? '' : 's'} still being analyzed. Events will improve as they finish.</div></div>;
}

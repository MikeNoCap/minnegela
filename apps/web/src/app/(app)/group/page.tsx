'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useGroup } from '@/lib/group';
import { useGroupInfo, useMembers, useStatus, useAudit, groupActions, useAction } from '@/lib/hooks';
import { Avatar } from '@/components/Avatar';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { useFormat } from '@/lib/format';

export default function GroupPage() {
  const t = useTranslations('group');
  const { fmtBytes, fmtRelative, fmtDate, fmtTime } = useFormat();
  const { group, groupId, me } = useGroup();
  const info = useGroupInfo();
  const members = useMembers();
  const status = useStatus();
  const isOwner = group?.role === 'owner';
  const audit = useAudit(!!isOwner);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const mkInvite = useAction(() => groupActions.invite(groupId!), () => []);
  const consent = useAction((on: boolean) => groupActions.consent(groupId!, on), () => [['members', groupId]]);
  const recluster = useAction(() => groupActions.recluster(groupId!), () => [['status', groupId]]);
  const retry = useAction(() => groupActions.retryJobs(groupId!), () => [['status', groupId]]);
  const meRow = members.data?.find((m) => m.userId === me?.user.id);
  const s = status.data;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{info.data?.name ?? group?.name}</h1>
          <p className="text-ink-2 text-[13px]">{t('intro')}</p>
        </header>
        <section className="card">
          <div className="p-3 border-b border-line flex items-center justify-between"><h2 className="font-medium">{t('members')}</h2>
            {isOwner && <button className="btn" onClick={() => mkInvite.mutateAsync().then(setInvite)}>{t('createInvite')}</button>}
          </div>
          {invite && <div className="p-3 border-b border-line text-[13px] bg-accent-soft/40">{t.rich('inviteCode', { code: invite.code, until: fmtDate(invite.expiresAt), code_: (c) => <code className="font-mono font-medium select-all">{c}</code> })}</div>}
          <ul className="divide-y divide-line">
            {(members.data ?? []).map((m) => (
              <li key={m.userId} className="p-3 flex items-center gap-3 text-[13px]">
                <Avatar name={m.displayName} seed={m.userId} size={28} />
                <span className="font-medium">{m.displayName}</span>
                <span className="chip">{t(`role.${m.role}`)}</span>
                <span className="ml-auto text-ink-3">{m.consentFacesAt ? t('recognitionOn') : m.personId != null ? t('enrolledOff') : t('notEnrolled')}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-3 space-y-2">
          <h2 className="font-medium">{t('privacy')}</h2>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={!!meRow?.consentFacesAt} onChange={(e) => consent.mutate(e.target.checked)} />
            {t('consentLabel')}
          </label>
          <p className="text-ink-3 text-[12px]">{t('privacyNote')}</p>
        </section>
        <section className="card p-3 space-y-2">
          <h2 className="font-medium">{t('language')}</h2>
          <div className="flex items-center gap-3 text-[13px]"><LocaleSwitcher /><span className="text-ink-3">{t('languageNote')}</span></div>
        </section>
        <section className="card">
          <div className="p-3 border-b border-line"><h2 className="font-medium">{t('devices')}</h2></div>
          <ul className="divide-y divide-line">
            {(s?.devices ?? []).map((d) => (
              <li key={d.id} className="p-3 flex items-center gap-3 text-[13px]"><span className="font-medium">{d.name}</span><span className="chip">{d.platform}</span>{d.ownerName && <span className="text-ink-2">{d.ownerName}</span>}<span className="ml-auto text-ink-3">{t('synced', { when: fmtRelative(d.lastSyncAt) })}</span></li>
            ))}
            {s && (s.devices?.length ?? 0) === 0 && <li className="p-3 text-ink-3 text-[13px]">{t('noDevices')}</li>}
          </ul>
        </section>
        {isOwner && audit.data && (
          <section className="card">
            <div className="p-3 border-b border-line"><h2 className="font-medium">{t('activity')}</h2></div>
            <ul className="divide-y divide-line max-h-96 overflow-y-auto">
              {audit.data.map((a) => <li key={a.id} className="p-2 px-3 text-[12px] flex gap-3"><span className="text-ink-3 tabular-nums shrink-0">{fmtDate(a.at, { day: 'numeric', month: 'short' })} {fmtTime(a.at)}</span><span className="text-ink-2">{a.userName ?? a.userId?.slice(0, 8) ?? t('system')}</span><span>{a.action}</span><span className="text-ink-3 truncate">{a.targetType} {a.targetId?.slice(0, 8)}</span></li>)}
            </ul>
          </section>
        )}
      </div>
      <aside className="space-y-4 rail">
        <section className="card p-3 space-y-1 text-[13px]">
          <h2 className="font-medium">{t('storage')}</h2>
          <Row k={t('photosVideos')} v={String(s?.storage?.blobs ?? '–')} />
          <Row k={t('bytes')} v={fmtBytes(s?.storage?.bytes)} />
          <Row k={t('originals')} v={String(s?.storage?.originals ?? '–')} />
        </section>
        <section className="card p-3 space-y-1 text-[13px]">
          <div className="flex items-center justify-between"><h2 className="font-medium">{t('processing')}</h2>{isOwner && <span className="flex gap-1"><button className="btn !py-0.5" onClick={() => retry.mutate()}>{t('retryFailed')}</button><button className="btn !py-0.5" onClick={() => recluster.mutate()}>{t('recluster')}</button></span>}</div>
          {(s?.queues ?? []).map((q) => (
            <div key={q.kind} className="flex items-center gap-2">
              <span className="w-20 text-ink-2">{q.kind}</span>
              <span className="flex-1 h-1.5 rounded bg-line overflow-hidden"><span className="block h-full bg-accent" style={{ width: `${Math.min(100, (q.pending + q.running) / 5)}%` }} /></span>
              <span className="tabular-nums text-ink-3 w-24 text-right">{q.pending} · {q.running}{q.failed ? <span className="text-danger"> · {q.failed}!</span> : ''}</span>
            </div>
          ))}
          {s && (s.queues?.length ?? 0) === 0 && <p className="text-ink-3">{t('idle')}</p>}
        </section>
      </aside>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) { return <div className="flex justify-between"><span className="text-ink-2">{k}</span><span className="tabular-nums">{v}</span></div>; }

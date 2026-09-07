import React, { useState } from 'react';
import { Share } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '@/store/context';
import { Screen, Card, P, H2, Row, Button, Field, Mono } from '@/ui/components';

const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`);

export default function GroupScreen() {
  const app = useApp();
  const groupId = app.settings.groupId;
  const group = app.me?.groups.find((g) => g.id === groupId);
  const members = useQuery({ queryKey: ['members', groupId], queryFn: () => app.api.members(groupId!), enabled: !!groupId });
  const status = useQuery({ queryKey: ['status', groupId], queryFn: () => app.api.status(groupId!), enabled: !!groupId, refetchInterval: 30_000 });
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [webUrl, setWebUrl] = useState(app.settings.webUrl);

  return (
    <Screen title={group?.name || 'Group'}>
      <Card>
        <H2>Members</H2>
        {(members.data ?? []).map((m) => <Row key={m.userId} label={m.displayName} value={`${m.role}${m.consentFacesAt ? ' · faces on' : ''}`} />)}
        {group?.role === 'owner' ? (
          <>
            <Button title="Create invite code" kind="secondary" onPress={async () => setInvite(await app.api.createInvite(groupId!))} />
            {invite ? (
              <>
                <Mono>{invite.code}</Mono>
                <Button title="Share code" onPress={() => Share.share({ message: `Join our Minnegela group with code ${invite.code} (valid 7 days). Server: ${app.settings.apiUrl}` })} />
              </>
            ) : null}
          </>
        ) : null}
      </Card>
      <Card>
        <H2>Devices</H2>
        {(status.data?.devices ?? []).map((d) => <Row key={d.id} label={`${d.ownerName} · ${d.name}`} value={d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : 'never'} />)}
      </Card>
      <Card>
        <H2>Server</H2>
        {status.data ? (
          <>
            <Row label="Storage" value={`${status.data.storage.blobs} items · ${fmtBytes(status.data.storage.bytes)}`} />
            <Row label="Analysed" value={`${status.data.counts.analyzed} / ${status.data.counts.previews}`} />
            <Row label="Events" value={status.data.counts.events} />
            {status.data.queues.map((q) => <Row key={q.kind} label={`queue · ${q.kind}`} value={`${q.pending} pending${q.running ? `, ${q.running} running` : ''}${q.failed ? `, ${q.failed} failed` : ''}`} />)}
          </>
        ) : <P muted>Loading…</P>}
        <Field label="API" value={app.settings.apiUrl} editable={false} />
        <Field label="Web app URL (for opening events)" value={webUrl} onChangeText={setWebUrl} autoCapitalize="none" keyboardType="url" placeholder="http://server:3000" />
        <Button title="Save web URL" kind="secondary" onPress={() => app.updateSettings((s) => ({ ...s, webUrl: webUrl.trim().replace(/\/$/, '') }))} />
      </Card>
    </Screen>
  );
}

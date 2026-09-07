import React, { useState } from 'react';
import { useApp, platform } from '@/store/context';
import { Screen, Card, P, H2, Button, Field, Banner } from '@/ui/components';
import * as Device from 'expo-constants';

export default function Group() {
  const app = useApp();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'join' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = async (groupId: string) => {
    const deviceName = `${platform()}:${Device.default.deviceName ?? 'phone'}`;
    const dev = await app.api.registerDevice(groupId, deviceName, platform());
    await app.updateSettings((s) => ({ ...s, groupId, deviceId: dev.id }));
    await app.refreshMe();
  };
  const join = async () => {
    setBusy('join'); setError(null);
    try { const r = await app.api.acceptInvite(code); await finish(r.groupId); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const create = async () => {
    setBusy('create'); setError(null);
    try { const g = await app.api.createGroup(name.trim()); await finish(g.id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const existing = app.me?.groups ?? [];

  return (
    <Screen title="Your group">
      {existing.length ? (
        <Card>
          <H2>Continue with</H2>
          {existing.map((g) => <Button key={g.id} title={g.name || 'Unnamed group'} kind="secondary" onPress={() => finish(g.id)} />)}
        </Card>
      ) : null}
      <Card>
        <H2>Join with an invite code</H2>
        <P muted small>Ask the friend who runs the group for a code. Codes last 7 days.</P>
        <Field value={code} onChangeText={setCode} placeholder="invite code" autoCapitalize="none" autoCorrect={false} />
        <Button title="Join" onPress={join} loading={busy === 'join'} disabled={code.trim().length < 4} />
      </Card>
      <Card>
        <H2>Or start a new group</H2>
        <Field value={name} onChangeText={setName} placeholder="The gang" />
        <Button title="Create" kind="secondary" onPress={create} loading={busy === 'create'} disabled={name.trim().length < 1} />
      </Card>
      {error ? <Banner tone="warn">{error}</Banner> : null}
    </Screen>
  );
}

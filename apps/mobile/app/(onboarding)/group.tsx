import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp, platform } from '@/store/context';
import { apiErrorMessage } from '@/api/errors';
import { Screen, Card, P, H2, Button, Field, Banner } from '@/ui/components';
import * as Device from 'expo-constants';

export default function Group() {
  const app = useApp();
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'join' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = async (groupId: string) => {
    const deviceName = `${platform()}:${Device.default.deviceName ?? t('common.phone')}`;
    const dev = await app.api.registerDevice(groupId, deviceName, platform());
    await app.updateSettings((s) => ({ ...s, groupId, deviceId: dev.id }));
    await app.refreshMe();
  };
  const join = async () => {
    setBusy('join'); setError(null);
    try { const r = await app.api.acceptInvite(code); await finish(r.groupId); } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(null); }
  };
  const create = async () => {
    setBusy('create'); setError(null);
    try { const g = await app.api.createGroup(name.trim()); await finish(g.id); } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(null); }
  };
  const existing = app.me?.groups ?? [];

  return (
    <Screen title={t('groupSetup.title')}>
      {existing.length ? (
        <Card>
          <H2>{t('groupSetup.continueWith')}</H2>
          {existing.map((g) => <Button key={g.id} title={g.name || t('groupSetup.unnamedGroup')} kind="secondary" onPress={() => finish(g.id)} />)}
        </Card>
      ) : null}
      <Card>
        <H2>{t('groupSetup.joinTitle')}</H2>
        <P muted small>{t('groupSetup.joinHint')}</P>
        <Field value={code} onChangeText={setCode} placeholder={t('groupSetup.codePlaceholder')} autoCapitalize="none" autoCorrect={false} />
        <Button title={t('groupSetup.join')} onPress={join} loading={busy === 'join'} disabled={code.trim().length < 4} />
      </Card>
      <Card>
        <H2>{t('groupSetup.createTitle')}</H2>
        <Field value={name} onChangeText={setName} placeholder={t('groupSetup.namePlaceholder')} />
        <Button title={t('groupSetup.create')} kind="secondary" onPress={create} loading={busy === 'create'} disabled={name.trim().length < 1} />
      </Card>
      {error ? <Banner tone="warn">{error}</Banner> : null}
    </Screen>
  );
}

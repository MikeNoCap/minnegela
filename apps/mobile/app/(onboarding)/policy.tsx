import React from 'react';
import { Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { Screen, Card, P, Button, Row } from '@/ui/components';

export default function Policy() {
  const app = useApp();
  const router = useRouter();
  const { t } = useTranslation();
  const p = app.settings.policy;
  const set = (patch: Partial<typeof p>) => app.updateSettings((s) => ({ ...s, policy: { ...s.policy, ...patch } }));
  return (
    <Screen title={t('policy.title')}>
      <Card>
        <Row label={t('policy.previewsCellular')} value={<Switch value={p.previewsOnCellular} onValueChange={(v) => set({ previewsOnCellular: v })} />} />
        <Row label={t('policy.originalsWifi')} value={<Switch value={p.originalsWifiCharging} onValueChange={(v) => set({ originalsWifiCharging: v })} />} />
        <Row label={t('policy.includeVideos')} value={<Switch value={p.includeVideos} onValueChange={(v) => set({ includeVideos: v })} />} />
        <Row label={t('policy.videoCap')} value={t('policy.videoCapValue', { mb: p.videosMaxMb })} />
        <P muted small>{t('policy.hint')}</P>
      </Card>
      <Button title={t('policy.start')} onPress={async () => { await app.updateSettings((s) => ({ ...s, onboardingDone: true })); router.replace('/(tabs)' as never); }} />
    </Screen>
  );
}

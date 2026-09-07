import React from 'react';
import { Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '@/store/context';
import { Screen, Card, P, Button, Row } from '@/ui/components';

export default function Policy() {
  const app = useApp();
  const router = useRouter();
  const p = app.settings.policy;
  const set = (patch: Partial<typeof p>) => app.updateSettings((s) => ({ ...s, policy: { ...s.policy, ...patch } }));
  return (
    <Screen title="How to sync">
      <Card>
        <Row label="Previews on mobile data" value={<Switch value={p.previewsOnCellular} onValueChange={(v) => set({ previewsOnCellular: v })} />} />
        <Row label="Originals only on Wi-Fi + charging" value={<Switch value={p.originalsWifiCharging} onValueChange={(v) => set({ originalsWifiCharging: v })} />} />
        <Row label="Include videos" value={<Switch value={p.includeVideos} onValueChange={(v) => set({ includeVideos: v })} />} />
        <Row label="Video size cap" value={`${p.videosMaxMb} MB`} />
        <P muted small>Previews are about 300 KB each and are what the recognition runs on. Originals are kept for downloads and never re-analysed.</P>
      </Card>
      <Button title="Start syncing" onPress={async () => { await app.updateSettings((s) => ({ ...s, onboardingDone: true })); router.replace('/(tabs)' as never); }} />
    </Screen>
  );
}

import React, { useState } from 'react';
import { Image, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useApp } from '@/store/context';
import { Screen, Card, P, H2, Button, Banner } from '@/ui/components';

/**
 * §5.3 enrollment: 3–5 reference photos. They are pushed through the sync at top priority and the
 * enroll call is retried on every pass until the server has analyzed them.
 */
export default function Enroll() {
  const app = useApp();
  const router = useRouter();
  const [picked, setPicked] = useState<Array<{ uri: string; assetId: string | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const group = app.me?.groups.find((g) => g.id === app.settings.groupId);

  const pick = async () => {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 5, quality: 1 });
    if (res.canceled) return;
    setPicked(res.assets.map((a) => ({ uri: a.uri, assetId: a.assetId ?? null })).slice(0, 5));
  };
  const confirm = async () => {
    const ids = picked.map((p) => p.assetId).filter((x): x is string => !!x);
    if (ids.length < picked.length) { setError('Some picks did not come with a library id (Android picker limitation). Pick again from the library.'); }
    if (!ids.length) return;
    await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: ids, doneAt: null, lastError: null } }));
    if (group) { try { await app.api.setConsent(group.id, true); } catch { /* retried from privacy screen */ } }
    router.replace('/(onboarding)/policy' as never);
  };
  const skip = async () => {
    await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: [], doneAt: null, lastError: null } }));
    router.replace('/(onboarding)/policy' as never);
  };

  return (
    <Screen title="Teach it your face">
      <Card>
        <P>Pick 3 to 5 photos of yourself: front, slightly left, slightly right, and one with your usual glasses or hat.</P>
        <P muted small>This is the switch that lets friends' photos of you count as "you were there", which is what unlocks those events for you. You can turn it off any time; that deletes your face data on the server.</P>
        <Button title={picked.length ? 'Pick different photos' : 'Pick photos'} kind={picked.length ? 'secondary' : 'primary'} onPress={pick} />
        {picked.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {picked.map((p) => <Image key={p.uri} source={{ uri: p.uri }} style={{ width: 72, height: 72, borderRadius: 8 }} />)}
          </View>
        ) : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        <Button title="Use these and enable recognition" onPress={confirm} disabled={picked.length < 1} />
        <Button title="Not now" kind="secondary" onPress={skip} />
      </Card>
      <H2>What friends can see</H2>
      <P muted small>Until you enroll, you only see events you photographed yourself. Enrollment lets the server recognise you in friends' photos and share those nights with you.</P>
    </Screen>
  );
}

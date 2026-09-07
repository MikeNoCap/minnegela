import React, { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useApp } from '@/store/context';
import { useSync } from '@/sync/useSync';
import { Screen, Card, P, H2, Row, Button, Banner } from '@/ui/components';

export default function Privacy() {
  const app = useApp();
  const router = useRouter();
  const sync = useSync();
  const groupId = app.settings.groupId;
  const group = app.me?.groups.find((g) => g.id === groupId);
  const status = useQuery({ queryKey: ['status', groupId], queryFn: () => app.api.status(groupId!), enabled: !!groupId });
  const [busy, setBusy] = useState(false);
  const consent = !!group?.consentFacesAt;
  const enrollment = app.settings.enrollment;

  const setConsent = async (v: boolean) => {
    if (!groupId) return;
    if (!v) {
      Alert.alert('Turn off face recognition?', 'Your face data on the server is deleted. Friends\' photos of you stop counting as "you were there", so those events disappear for you unless you also contributed photos.', [
        { text: 'Keep on', style: 'cancel' },
        { text: 'Turn off', style: 'destructive', onPress: async () => { setBusy(true); try { await app.api.setConsent(groupId, false); await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: [], doneAt: null, lastError: null } })); await app.refreshMe(); } finally { setBusy(false); } } },
      ]);
      return;
    }
    router.push('/(onboarding)/enroll' as never);
  };

  const c = sync.counts;
  const indexed = c ? c.total - c.deleted - c.excluded : 0;
  const counts = status.data?.counts;

  return (
    <Screen title="People & privacy">
      <Card>
        <H2>Who sees what</H2>
        <P>There are no sharing settings. Being at an event, as the photographer or as a face in someone's photo, is the only key that unlocks it. Everything else in your library is invisible to the group.</P>
        <P bold>{indexed} photos indexed on this phone{counts ? ` · ${counts.events} events reconstructed in the group` : ''}</P>
        <P muted small>Per-event viewers are listed on each event in the web app ("Visible to you, Emma and Jonas").</P>
      </Card>
      <Card>
        <H2>My identity</H2>
        <Row label="Face recognition" value={<Switch value={consent} onValueChange={setConsent} disabled={busy} />} />
        {enrollment.pendingLocalIds.length ? <Banner>Enrollment in progress: {enrollment.pendingLocalIds.length} reference photo(s) waiting for analysis.{enrollment.lastError ? ` (${enrollment.lastError})` : ''}</Banner> : null}
        {enrollment.doneAt ? <P muted small>Enrolled {new Date(enrollment.doneAt).toLocaleDateString()}.</P> : null}
        <Button title={consent ? 'Re-enroll with new photos' : 'Enroll my face'} kind="secondary" onPress={() => router.push('/(onboarding)/enroll' as never)} />
        <P muted small>Face embeddings never leave the server and are never shown or exported. Withdrawing consent deletes them.</P>
      </Card>
      <Card>
        <H2>My data</H2>
        <Button title="Download my data" kind="secondary" onPress={async () => { await app.api.requestExport(groupId ?? undefined); Alert.alert('Export queued', 'A zip of your originals and metadata will be prepared on the server.'); }} />
        <Button title="Leave group" kind="secondary" onPress={() => groupId && Alert.alert('Leave group', 'Take your media with you?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Leave, keep my contributions', onPress: async () => { await app.api.leaveGroup(groupId, false); await app.updateSettings((s) => ({ ...s, groupId: null, deviceId: null, onboardingDone: false })); await app.db.reset(); await app.refreshMe(); } },
          { text: 'Leave and delete my media', style: 'destructive', onPress: async () => { await app.api.leaveGroup(groupId, true); await app.updateSettings((s) => ({ ...s, groupId: null, deviceId: null, onboardingDone: false })); await app.db.reset(); await app.refreshMe(); } },
        ])} />
        <Button title="Delete my account" kind="danger" onPress={() => Alert.alert('Delete account', 'Scheduled with a 7-day grace period. Sign in again within 7 days to cancel.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: async () => { await app.api.deleteMe(); await app.signOut(); } },
        ])} />
        <Button title="Sign out" kind="secondary" onPress={() => app.signOut()} />
      </Card>
    </Screen>
  );
}

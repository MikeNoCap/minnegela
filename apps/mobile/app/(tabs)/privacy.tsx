import React, { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { useSync } from '@/sync/useSync';
import { fmtDate } from '@/i18n';
import { Screen, Card, P, H2, Row, Button, Banner } from '@/ui/components';

export default function Privacy() {
  const app = useApp();
  const router = useRouter();
  const { t } = useTranslation();
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
      Alert.alert(t('privacy.turnOff.title'), t('privacy.turnOff.body'), [
        { text: t('privacy.turnOff.keep'), style: 'cancel' },
        { text: t('privacy.turnOff.off'), style: 'destructive', onPress: async () => { setBusy(true); try { await app.api.setConsent(groupId, false); await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: [], doneAt: null, lastError: null } })); await app.refreshMe(); } finally { setBusy(false); } } },
      ]);
      return;
    }
    router.push('/(onboarding)/enroll' as never);
  };

  const c = sync.counts;
  const indexed = c ? c.total - c.deleted - c.excluded : 0;
  const counts = status.data?.counts;

  return (
    <Screen title={t('privacy.title')}>
      <Card>
        <H2>{t('privacy.whoTitle')}</H2>
        <P>{t('privacy.whoBody')}</P>
        <P bold>{t('privacy.indexed', { count: indexed })}{counts ? t('privacy.eventsReconstructed', { count: counts.events }) : ''}</P>
        <P muted small>{t('privacy.viewersHint')}</P>
      </Card>
      <Card>
        <H2>{t('privacy.identityTitle')}</H2>
        <Row label={t('privacy.faceRecognition')} value={<Switch value={consent} onValueChange={setConsent} disabled={busy} />} />
        {enrollment.pendingLocalIds.length ? <Banner>{t('privacy.enrollProgress', { count: enrollment.pendingLocalIds.length })}{enrollment.lastError ? ` (${enrollment.lastError})` : ''}</Banner> : null}
        {enrollment.doneAt ? <P muted small>{t('privacy.enrolled', { date: fmtDate(enrollment.doneAt) })}</P> : null}
        <Button title={consent ? t('privacy.reEnroll') : t('privacy.enrollFace')} kind="secondary" onPress={() => router.push('/(onboarding)/enroll' as never)} />
        <P muted small>{t('privacy.embeddings')}</P>
      </Card>
      <Card>
        <H2>{t('privacy.dataTitle')}</H2>
        <Button title={t('privacy.download')} kind="secondary" onPress={async () => { await app.api.requestExport(groupId ?? undefined); Alert.alert(t('privacy.exportQueued.title'), t('privacy.exportQueued.body')); }} />
        <Button title={t('privacy.leave')} kind="secondary" onPress={() => groupId && Alert.alert(t('privacy.leaveTitle'), t('privacy.leaveBody'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('privacy.leaveKeep'), onPress: async () => { await app.api.leaveGroup(groupId, false); await app.updateSettings((s) => ({ ...s, groupId: null, deviceId: null, onboardingDone: false })); await app.db.reset(); await app.refreshMe(); } },
          { text: t('privacy.leaveDelete'), style: 'destructive', onPress: async () => { await app.api.leaveGroup(groupId, true); await app.updateSettings((s) => ({ ...s, groupId: null, deviceId: null, onboardingDone: false })); await app.db.reset(); await app.refreshMe(); } },
        ])} />
        <Button title={t('privacy.deleteAccount')} kind="danger" onPress={() => Alert.alert(t('privacy.deleteTitle'), t('privacy.deleteBody'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('privacy.delete'), style: 'destructive', onPress: async () => { await app.api.deleteMe(); await app.signOut(); } },
        ])} />
        <Button title={t('privacy.signOut')} kind="secondary" onPress={() => app.signOut()} />
      </Card>
    </Screen>
  );
}

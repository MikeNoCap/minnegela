import React, { useState } from 'react';
import { Share, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, type Locale } from '@minnegela/shared';
import { useApp } from '@/store/context';
import { fmtDateTime } from '@/i18n';
import { Screen, Card, P, H2, Row, Button, Field, Mono } from '@/ui/components';

const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`);

export default function GroupScreen() {
  const app = useApp();
  const { t } = useTranslation();
  const groupId = app.settings.groupId;
  const group = app.me?.groups.find((g) => g.id === groupId);
  const members = useQuery({ queryKey: ['members', groupId], queryFn: () => app.api.members(groupId!), enabled: !!groupId });
  const status = useQuery({ queryKey: ['status', groupId], queryFn: () => app.api.status(groupId!), enabled: !!groupId, refetchInterval: 30_000 });
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [webUrl, setWebUrl] = useState(app.settings.webUrl);
  const locale: Locale = app.settings.locale ?? DEFAULT_LOCALE;
  const pickLocale = (l: Locale) => app.updateSettings((s) => ({ ...s, locale: l }));

  return (
    <Screen title={group?.name || t('group.title')}>
      <Card>
        <H2>{t('group.members')}</H2>
        {(members.data ?? []).map((m) => <Row key={m.userId} label={m.displayName} value={`${t(`group.role.${m.role}`)}${m.consentFacesAt ? ` · ${t('group.facesOn')}` : ''}`} />)}
        {group?.role === 'owner' ? (
          <>
            <Button title={t('group.createInvite')} kind="secondary" onPress={async () => setInvite(await app.api.createInvite(groupId!))} />
            {invite ? (
              <>
                <Mono>{invite.code}</Mono>
                <Button title={t('group.shareCode')} onPress={() => Share.share({ message: t('group.shareMessage', { code: invite.code, server: app.settings.apiUrl }) })} />
              </>
            ) : null}
          </>
        ) : null}
      </Card>
      <Card>
        <H2>{t('group.devices')}</H2>
        {(status.data?.devices ?? []).map((d) => <Row key={d.id} label={`${d.ownerName} · ${d.name}`} value={d.lastSyncAt ? fmtDateTime(d.lastSyncAt) : t('common.never')} />)}
      </Card>
      <Card>
        <H2>{t('group.language')}</H2>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Button title={t('group.norwegian')} kind={locale === 'nb' ? 'primary' : 'secondary'} onPress={() => pickLocale('nb')} /></View>
          <View style={{ flex: 1 }}><Button title={t('group.english')} kind={locale === 'en' ? 'primary' : 'secondary'} onPress={() => pickLocale('en')} /></View>
        </View>
      </Card>
      <Card>
        <H2>{t('group.server')}</H2>
        {status.data ? (
          <>
            <Row label={t('group.storage')} value={t('group.storageValue', { count: status.data.storage.blobs, size: fmtBytes(status.data.storage.bytes) })} />
            <Row label={t('group.analysed')} value={`${status.data.counts.analyzed} / ${status.data.counts.previews}`} />
            <Row label={t('group.events')} value={status.data.counts.events} />
            {status.data.queues.map((q) => <Row key={q.kind} label={t('group.queue', { kind: q.kind })} value={[t('group.queuePending', { count: q.pending }), q.running ? t('group.queueRunning', { count: q.running }) : null, q.failed ? t('group.queueFailed', { count: q.failed }) : null].filter(Boolean).join(', ')} />)}
          </>
        ) : <P muted>{t('common.loading')}</P>}
        <Field label={t('group.api')} value={app.settings.apiUrl} editable={false} />
        <Field label={t('group.webUrl')} value={webUrl} onChangeText={setWebUrl} autoCapitalize="none" keyboardType="url" placeholder={t('group.webUrlPlaceholder')} />
        <Button title={t('group.saveWebUrl')} kind="secondary" onPress={() => app.updateSettings((s) => ({ ...s, webUrl: webUrl.trim().replace(/\/$/, '') }))} />
      </Card>
    </Screen>
  );
}

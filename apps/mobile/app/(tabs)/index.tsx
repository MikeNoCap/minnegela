import React, { useEffect } from 'react';
import { View, Pressable, RefreshControl, ScrollView } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { useSync } from '@/sync/useSync';
import { fmtDate } from '@/i18n';
import { Card, P, H2, Button, Stat, Ring, Banner, Mono } from '@/ui/components';
import { useTheme } from '@/ui/theme';
import { SyncOverlay } from '@/ui/SyncOverlay';

export default function Home() {
  const app = useApp();
  const t = useTheme();
  const { t: tr } = useTranslation();
  const sync = useSync();
  const groupId = app.settings.groupId;
  const events = useQuery({ queryKey: ['events', groupId], queryFn: () => app.api.events(groupId!), enabled: !!groupId });
  const status = useQuery({ queryKey: ['status', groupId], queryFn: () => app.api.status(groupId!), enabled: !!groupId, refetchInterval: 60_000 });

  // A foreground open is the best moment to make progress (§16.4).
  useEffect(() => { void sync.syncNow({ budgetMs: 120_000, maxItems: 300 }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const c = sync.counts;
  const indexed = c ? c.total - c.deleted : 0;
  const uploaded = c ? c.preview_uploaded + c.original_uploaded + c.skipped : 0;
  const queued = c ? c.new + c.manifested : 0;
  const excluded = c?.excluded ?? 0;
  const failed = c?.failed ?? 0;
  const enrollment = app.settings.enrollment;
  const ago = (ms: number | null) => (ms ? tr('home.minAgo', { count: Math.max(0, Math.round((Date.now() - ms) / 60000)) }) : tr('common.never'));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <SyncOverlay sync={sync} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void events.refetch(); void status.refetch(); void sync.refresh(); }} />}>
        <H2>{tr('home.syncTitle')}</H2>
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <Stat label={tr('home.indexed')} value={indexed} />
            <Stat label={tr('home.uploaded')} value={uploaded} />
            <Stat label={tr('home.queued')} value={queued} />
            <Stat label={tr('home.excluded')} value={excluded} />
          </View>
          <Ring fraction={indexed - excluded > 0 ? uploaded / (indexed - excluded) : 0} />
          <P muted small>
            {sync.busy ? `${tr(`sync.phase.${sync.progress.phase}.title`)}${sync.progress.total ? ` ${sync.progress.done}/${sync.progress.total}` : ''}…` : tr('home.lastSync', { when: ago(sync.last.at) })}
            {failed ? ` · ${tr('home.failed', { count: failed })}` : ''}
          </P>
          {sync.last.error ? <Mono>{sync.last.error}</Mono> : null}
          <Button title={sync.busy ? tr('home.syncing') : tr('home.syncNow')} onPress={() => void sync.syncNow()} disabled={sync.busy} />
          <Button title={tr('home.fullSync')} kind="secondary" onPress={() => void sync.fullSync()} disabled={sync.busy} />
          <P muted small>{tr('home.fullSyncHint')}</P>
        </Card>
        {enrollment.pendingLocalIds.length ? (
          <Banner>{tr('home.enrollWaiting', { count: enrollment.pendingLocalIds.length })} {enrollment.lastError ? tr('home.enrollLastTry', { error: enrollment.lastError }) : tr('home.enrollLater')}</Banner>
        ) : null}
        {status.data && status.data.analyzing > 0 ? <Banner>{tr('home.analyzing', { count: status.data.analyzing })}</Banner> : null}

        <H2>{tr('home.memoriesTitle')}</H2>
        {events.isError ? <Banner tone="warn">{tr('home.unreachable')}</Banner> : null}
        {events.data?.items.length === 0 ? <P muted>{tr('home.noEvents')}</P> : null}
        {events.data?.items.slice(0, 20).map((e) => (
          <Pressable key={e.id} onPress={() => app.settings.webUrl && WebBrowser.openBrowserAsync(`${app.settings.webUrl}/events/${e.id}`)}>
            <Card>
              <P bold>{e.title}</P>
              <P muted small>{fmtDate(e.startAt)} · {tr('home.photos', { count: e.nAssets })} · {tr('home.contributors', { count: e.contributorIds.length })} · {tr('home.people', { count: e.personIds.length })}{e.placeName ? ` · ${e.placeName}` : ''}</P>
            </Card>
          </Pressable>
        ))}
        {!app.settings.webUrl ? <P muted small>{tr('home.setWebUrl')}</P> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

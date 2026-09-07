import React, { useEffect } from 'react';
import { View, Pressable, RefreshControl, ScrollView } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '@/store/context';
import { useSync } from '@/sync/useSync';
import { Card, P, H2, Button, Stat, Ring, Banner, Mono } from '@/ui/components';
import { useTheme } from '@/ui/theme';

const ago = (ms: number | null) => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 60000))} min ago` : 'never');

export default function Home() {
  const app = useApp();
  const t = useTheme();
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

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void events.refetch(); void status.refetch(); void sync.refresh(); }} />}>
        <H2>Sync</H2>
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <Stat label="indexed" value={indexed} />
            <Stat label="uploaded" value={uploaded} />
            <Stat label="queued" value={queued} />
            <Stat label="excluded" value={excluded} />
          </View>
          <Ring fraction={indexed - excluded > 0 ? uploaded / (indexed - excluded) : 0} />
          <P muted small>
            {sync.busy ? `${sync.progress.phase}${sync.progress.total ? ` ${sync.progress.done}/${sync.progress.total}` : ''}…` : `Last sync ${ago(sync.last.at)}`}
            {failed ? ` · ${failed} failed` : ''}
          </P>
          {sync.last.error ? <Mono>{sync.last.error}</Mono> : null}
          <Button title={sync.busy ? 'Syncing…' : 'Sync now'} onPress={() => void sync.syncNow()} disabled={sync.busy} />
          <P muted small>Fastest while the app is open on Wi-Fi and charging. Background sync continues when the phone allows it.</P>
        </Card>
        {enrollment.pendingLocalIds.length ? (
          <Banner>Waiting for the server to find your face on {enrollment.pendingLocalIds.length} reference photo(s). {enrollment.lastError ? `Last try: ${enrollment.lastError}` : 'This finishes on a later sync.'}</Banner>
        ) : null}
        {status.data && status.data.analyzing > 0 ? <Banner>{status.data.analyzing} items still being analysed on the server.</Banner> : null}

        <H2>New memories</H2>
        {events.isError ? <Banner tone="warn">Could not reach the server.</Banner> : null}
        {events.data?.items.length === 0 ? <P muted>No events yet. They appear as photos are analysed.</P> : null}
        {events.data?.items.slice(0, 20).map((e) => (
          <Pressable key={e.id} onPress={() => app.settings.webUrl && WebBrowser.openBrowserAsync(`${app.settings.webUrl}/events/${e.id}`)}>
            <Card>
              <P bold>{e.title}</P>
              <P muted small>{new Date(e.startAt).toLocaleDateString()} · {e.nAssets} photos · {e.contributorIds.length} contributors · {e.personIds.length} people{e.placeName ? ` · ${e.placeName}` : ''}</P>
            </Card>
          </Pressable>
        ))}
        {!app.settings.webUrl ? <P muted small>Set the web app URL under Group to open events.</P> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { useSync } from '@/sync/useSync';
import { Button, P } from './components';
import { useTheme } from './theme';

type Sync = ReturnType<typeof useSync>;

/** Full-screen progress for the multi-pass full sync; shown while it runs and until the summary is dismissed. */
export function SyncOverlay({ sync }: { sync: Sync }) {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const fmtDuration = (ms: number) => {
    const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000);
    return m ? tr('sync.durationMinSec', { m, s }) : tr('sync.durationSec', { s });
  };
  const { full, progress, counts } = sync;
  const visible = full.status !== 'idle';
  const [, tick] = useState(0);
  useEffect(() => { if (!visible) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [visible]);

  const indexed = counts ? counts.total - counts.deleted - counts.excluded : 0;
  const uploaded = counts ? counts.preview_uploaded + counts.original_uploaded + counts.skipped : 0;
  const queued = counts ? counts.new + counts.manifested : 0;
  const overall = indexed > 0 ? uploaded / indexed : 0;
  const running = full.status === 'running' || full.status === 'stopping';
  const phase = { title: tr(`sync.phase.${progress.phase}.title`), hint: tr(`sync.phase.${progress.phase}.hint`) };
  const elapsed = full.startedAt ? Date.now() - full.startedAt : 0;
  const reason = full.reason ?? 'drained';
  const done = full.status === 'done' ? { title: tr(`sync.reason.${reason}.title`), body: tr(`sync.reason.${reason}.body`) } : null;

  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent onRequestClose={() => (running ? sync.stopFullSync() : sync.dismissFullSync())}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'space-between' }}>
          <View style={{ gap: 6 }}>
            <Text style={{ color: t.ink3, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>{running ? tr('sync.headerPass', { pass: full.pass }) : tr('sync.header')}</Text>
            <Text style={{ color: t.ink, fontSize: 30, fontWeight: '700', letterSpacing: -0.5 }}>{done ? done.title : full.status === 'stopping' ? tr('sync.stopping') : phase.title}</Text>
            <P muted>{done ? done.body : full.status === 'stopping' ? tr('sync.stoppingHint') : phase.hint}</P>
          </View>

          <View style={{ gap: 20 }}>
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
                <Text style={{ color: t.ink, fontSize: 64, fontWeight: '700', letterSpacing: -2, lineHeight: 68, fontVariant: ['tabular-nums'] }}>{Math.round(overall * 100)}%</Text>
                <Text style={{ color: t.ink3, fontSize: 14, paddingBottom: 12 }}>{tr('sync.uploadedOf', { uploaded, indexed })}</Text>
              </View>
              <Bar fraction={overall} height={14} />
            </View>
            <View style={{ gap: 6 }}>
              {running ? <Bar fraction={progress.total ? progress.done / progress.total : null} /> : null}
              <P muted small>{!running ? ' ' : progress.total ? tr('sync.phaseProgress', { title: phase.title, done: progress.done, total: progress.total }) : progress.phase === 'enumerate' && progress.done ? tr('sync.foundSoFar', { count: progress.done }) : ' '}</P>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'space-between' }}>
              <Stat label={tr('sync.stats.indexed')} value={full.totals.enumerated} />
              <Stat label={tr('sync.stats.previews')} value={full.totals.previews} />
              <Stat label={tr('sync.stats.originals')} value={full.totals.originals} />
              <Stat label={tr('sync.stats.queued')} value={queued} />
              {full.totals.failed ? <Stat label={tr('sync.stats.failed')} value={full.totals.failed} tone="warn" /> : null}
            </View>
            {full.lastError ? <Text style={{ color: t.ink3, fontSize: 12, fontFamily: 'monospace' }} numberOfLines={2}>{tr('sync.lastError')}: {full.lastError}</Text> : null}
          </View>

          <View style={{ gap: 10 }}>
            <P muted small>{running ? tr('sync.running', { duration: fmtDuration(elapsed) }) : tr('sync.ran', { count: full.pass, duration: fmtDuration(elapsed) })}</P>
            {running
              ? <Button title={full.status === 'stopping' ? tr('sync.stopping') : tr('sync.stop')} kind="secondary" onPress={sync.stopFullSync} disabled={full.status === 'stopping'} />
              : <Button title={tr('sync.done')} onPress={sync.dismissFullSync} />}
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  const t = useTheme();
  return (
    <View style={{ minWidth: 70 }}>
      <Text style={{ color: tone === 'warn' ? t.danger : t.ink, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
      <Text style={{ color: t.ink3, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

/** Determinate bar, or a sweeping indeterminate one when the phase has no known total. */
function Bar({ fraction, height = 8 }: { fraction: number | null; height?: number }) {
  const t = useTheme();
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (fraction !== null) return;
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [fraction, sweep]);
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: t.accentSoft, overflow: 'hidden' }}>
      {fraction === null
        ? <Animated.View style={{ width: '35%', height: '100%', borderRadius: height / 2, backgroundColor: t.accent, transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-140, 420] }) }] }} />
        : <View style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, height: '100%', backgroundColor: t.accent }} />}
    </View>
  );
}

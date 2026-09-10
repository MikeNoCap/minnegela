import React, { useState } from 'react';
import { Image, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { importPick } from '@/sync/enrollImport';
import { indexLibraryAsset } from '@/sync/adapters';
import { Screen, Card, P, H2, Button, Banner } from '@/ui/components';

/**
 * §5.3 enrollment: 3–5 reference photos. They are pushed through the sync at top priority and the
 * enroll call is retried on every pass until the server has analyzed them.
 */
export default function Enroll() {
  const app = useApp();
  const router = useRouter();
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Array<{ uri: string; assetId: string | null; debug?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const group = app.me?.groups.find((g) => g.id === app.settings.groupId);

  const pick = async () => {
    setError(null);
    // legacy: Android's modern system picker returns temporary URIs with no MediaStore id; the
    // legacy gallery picker returns ids when the media documents provider serves the pick.
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 5, quality: 1, legacy: true, exif: true });
    if (res.canceled) return;
    // Resolve each pick to a local index row: the picker's own id, else a filename/size match in the
    // index, else import the file as its own row (the normal case during onboarding, before the
    // first library walk has run).
    const resolved: Array<{ uri: string; assetId: string | null; debug?: string }> = [];
    for (const a of res.assets.slice(0, 5)) {
      let assetId = a.assetId ?? null;
      let how = assetId ? 'picker-id' : 'none';
      if (assetId && !(await app.db.get(assetId))) {
        // iOS (and some Android pickers) name the library asset, but before the first library walk the
        // index has no row for it; write one now so the sync can push the reference photo first.
        try { await indexLibraryAsset(app.db, assetId); how = 'indexed'; } catch { assetId = null; how = 'none'; }
      }
      if (!assetId && a.fileName) {
        const matches = await app.db.findByFile(a.fileName, a.fileSize ?? null);
        const m = matches.length === 1 ? matches[0]
          : matches.find((r) => a.width != null && r.w === a.width && a.height != null && r.h === a.height) ?? matches[0] ?? null;
        if (m) { assetId = m.localId; how = `index-match(${matches.length})`; }
      }
      if (!assetId) {
        try { assetId = await importPick(app.db, a); how = 'imported'; } catch (e) { how = `import-failed: ${e instanceof Error ? e.message : String(e)}`; }
      }
      const debug = `${a.fileName ?? 'no-filename'} ${a.fileSize ?? '?'}B ${a.width}x${a.height} ${how}`;
      console.log('[enroll pick]', debug);
      resolved.push({ uri: a.uri, assetId, debug });
    }
    setPicked(resolved);
    const failed = resolved.filter((p) => !p.assetId);
    if (failed.length) setError(t('enroll.prepFailed', { count: failed.length, details: failed.map((p) => p.debug).join(' | ') }));
  };
  const confirm = async () => {
    const ids = picked.map((p) => p.assetId).filter((x): x is string => !!x);
    if (!ids.length) return;
    await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: ids, doneAt: null, lastError: null } }));
    if (group) { try { await app.api.setConsent(group.id, true); } catch { /* retried from privacy screen */ } }
    router.replace((app.settings.onboardingDone ? '/(tabs)/privacy' : '/(onboarding)/policy') as never);
  };
  const skip = async () => {
    await app.updateSettings((s) => ({ ...s, enrollment: { pendingLocalIds: [], doneAt: null, lastError: null } }));
    router.replace((app.settings.onboardingDone ? '/(tabs)/privacy' : '/(onboarding)/policy') as never);
  };

  return (
    <Screen title={t('enroll.title')}>
      <Card>
        <P>{t('enroll.intro')}</P>
        <P muted small>{t('enroll.why')}</P>
        <Button title={picked.length ? t('enroll.pickDifferent') : t('enroll.pick')} kind={picked.length ? 'secondary' : 'primary'} onPress={pick} />
        {picked.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {picked.map((p) => <Image key={p.uri} source={{ uri: p.uri }} style={{ width: 72, height: 72, borderRadius: 8 }} />)}
          </View>
        ) : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        <Button title={t('enroll.use')} onPress={confirm} disabled={picked.length < 1} />
        <Button title={t('enroll.notNow')} kind="secondary" onPress={skip} />
      </Card>
      <H2>{t('enroll.visibleTitle')}</H2>
      <P muted small>{t('enroll.visibleBody')}</P>
    </Screen>
  );
}

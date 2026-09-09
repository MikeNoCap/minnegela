import React, { useEffect, useState } from 'react';
import { Switch } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { resetEnumeration } from '@/sync/runner';
import { Screen, Card, P, H2, Row, Field, Button } from '@/ui/components';

/** §16.5 library rules. Changing a rule re-enumerates from scratch so exclusions apply to the whole library. */
export default function Library() {
  const app = useApp();
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [since, setSince] = useState(app.settings.rules.sinceDate ?? '');
  const rules = app.settings.rules;
  useEffect(() => { MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false }).then(setAlbums).catch(() => setAlbums([])); }, []);

  const setRules = async (patch: Partial<typeof rules>) => {
    await app.updateSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
    await resetEnumeration(app.db);   // re-walk so rules apply everywhere
  };
  const toggleAlbum = (id: string) => setRules({ excludedAlbumIds: rules.excludedAlbumIds.includes(id) ? rules.excludedAlbumIds.filter((x) => x !== id) : [...rules.excludedAlbumIds, id] });

  return (
    <Screen title={t('library.title')}>
      <Card>
        <Row label={t('library.excludeScreenshots')} value={<Switch value={rules.excludeScreenshots} onValueChange={(v) => setRules({ excludeScreenshots: v })} />} />
        <Field label={t('library.sinceLabel')} value={since} onChangeText={setSince} placeholder={t('library.sincePlaceholder')} autoCapitalize="none" />
        <Button title={t('library.applyDate')} kind="secondary" onPress={() => setRules({ sinceDate: /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null })} />
      </Card>
      <H2>{t('library.albumsTitle')}</H2>
      <Card>
        {albums.length === 0 ? <P muted>{t('library.noAlbums')}</P> : null}
        {albums.map((a) => <Row key={a.id} label={`${a.title} (${a.assetCount})`} value={<Switch value={rules.excludedAlbumIds.includes(a.id)} onValueChange={() => toggleAlbum(a.id)} />} />)}
      </Card>
      <P muted small>{t('library.footer')}</P>
    </Screen>
  );
}

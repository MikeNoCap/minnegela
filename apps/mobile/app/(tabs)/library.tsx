import React, { useEffect, useState } from 'react';
import { Switch } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useApp } from '@/store/context';
import { Screen, Card, P, H2, Row, Field, Button } from '@/ui/components';

/** §16.5 library rules. Changing a rule re-enumerates from scratch so exclusions apply to the whole library. */
export default function Library() {
  const app = useApp();
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [since, setSince] = useState(app.settings.rules.sinceDate ?? '');
  const rules = app.settings.rules;
  useEffect(() => { MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false }).then(setAlbums).catch(() => setAlbums([])); }, []);

  const setRules = async (patch: Partial<typeof rules>) => {
    await app.updateSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
    await app.db.setSyncState('enumerate.createdAfter', null);   // re-walk so rules apply everywhere
  };
  const toggleAlbum = (id: string) => setRules({ excludedAlbumIds: rules.excludedAlbumIds.includes(id) ? rules.excludedAlbumIds.filter((x) => x !== id) : [...rules.excludedAlbumIds, id] });

  return (
    <Screen title="Library rules">
      <Card>
        <Row label="Exclude screenshots" value={<Switch value={rules.excludeScreenshots} onValueChange={(v) => setRules({ excludeScreenshots: v })} />} />
        <Field label="Only photos since (YYYY-MM-DD, empty for all)" value={since} onChangeText={setSince} placeholder="2022-01-01" autoCapitalize="none" />
        <Button title="Apply date" kind="secondary" onPress={() => setRules({ sinceDate: /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null })} />
      </Card>
      <H2>Albums to exclude</H2>
      <Card>
        {albums.length === 0 ? <P muted>No albums found (or limited access).</P> : null}
        {albums.map((a) => <Row key={a.id} label={`${a.title} (${a.assetCount})`} value={<Switch value={rules.excludedAlbumIds.includes(a.id)} onValueChange={() => toggleAlbum(a.id)} />} />)}
      </Card>
      <P muted small>Excluded photos are never indexed for the group. Anything already uploaded from an album you exclude stays until you delete it from the web app.</P>
    </Screen>
  );
}

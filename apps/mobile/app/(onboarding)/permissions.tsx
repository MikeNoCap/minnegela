import React, { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Screen, Card, P, H2, Button, Banner } from '@/ui/components';

export default function Permissions() {
  const router = useRouter();
  const { t } = useTranslation();
  const [state, setState] = useState<MediaLibrary.PermissionResponse | null>(null);
  const refresh = () => MediaLibrary.getPermissionsAsync(false, ['photo', 'video']).then(setState);
  useEffect(() => { void refresh(); }, []);
  const ask = async () => { setState(await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])); };
  const limited = state?.accessPrivileges === 'limited';

  return (
    <Screen title={t('permissions.title')}>
      <Card>
        <H2>{t('permissions.whatTitle')}</H2>
        <P>{t('permissions.what1')}</P>
        <P>{t('permissions.what2')}</P>
        <P muted small>{t('permissions.what3')}</P>
      </Card>
      {!state?.granted ? (
        <Card>
          <Button title={t('permissions.allow')} onPress={ask} />
          {state && !state.canAskAgain ? <Button title={t('permissions.openSettings')} kind="secondary" onPress={() => Linking.openSettings()} /> : null}
        </Card>
      ) : (
        <Card>
          {limited ? (
            <>
              <Banner tone="warn">{t('permissions.limited')}</Banner>
              {Platform.OS === 'ios' ? <Button title={t('permissions.manage')} kind="secondary" onPress={() => MediaLibrary.presentPermissionsPickerAsync().then(refresh)} /> : null}
            </>
          ) : <P>{t('permissions.granted')}</P>}
          <Button title={t('common.continue')} onPress={() => router.replace('/(onboarding)/enroll' as never)} />
        </Card>
      )}
    </Screen>
  );
}

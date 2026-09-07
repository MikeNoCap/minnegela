import React, { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useRouter } from 'expo-router';
import { Screen, Card, P, H2, Button, Banner } from '@/ui/components';

export default function Permissions() {
  const router = useRouter();
  const [state, setState] = useState<MediaLibrary.PermissionResponse | null>(null);
  const refresh = () => MediaLibrary.getPermissionsAsync().then(setState);
  useEffect(() => { void refresh(); }, []);
  const ask = async () => { setState(await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])); };
  const limited = state?.accessPrivileges === 'limited';

  return (
    <Screen title="Your photos">
      <Card>
        <H2>What Minnegela does with them</H2>
        <P>It reads your library to build a private index of when and where photos were taken, and uploads small previews to your group's server so faces and events can be recognised there.</P>
        <P>Friends only ever see events you were at together. A hike alone, a screenshot, a receipt: those never leave your view.</P>
        <P muted small>Your library syncs fastest while the app is open and the phone is on Wi-Fi and charging. We keep going in the background when the phone lets us.</P>
      </Card>
      {!state?.granted ? (
        <Card>
          <Button title="Allow access to photos" onPress={ask} />
          {state && !state.canAskAgain ? <Button title="Open Settings" kind="secondary" onPress={() => Linking.openSettings()} /> : null}
        </Card>
      ) : (
        <Card>
          {limited ? (
            <>
              <Banner tone="warn">You gave access to a selection of photos. Only those will be indexed.</Banner>
              {Platform.OS === 'ios' ? <Button title="Manage selection" kind="secondary" onPress={() => MediaLibrary.presentPermissionsPickerAsync().then(refresh)} /> : null}
            </>
          ) : <P>Access granted.</P>}
          <Button title="Continue" onPress={() => router.replace('/(onboarding)/enroll' as never)} />
        </Card>
      )}
    </Screen>
  );
}

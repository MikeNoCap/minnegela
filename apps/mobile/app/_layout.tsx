import React, { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as MediaLibrary from 'expo-media-library/legacy';
import { AppProvider, useApp } from '@/store/context';
import { nextStep, type Step } from '@/onboarding';
import { useTheme } from '@/ui/theme';
import '@/sync/background';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

function Gate({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const router = useRouter();
  const segments = useSegments();
  const [perm, setPerm] = useState<'granted' | 'limited' | 'denied' | 'unknown'>('unknown');

  useEffect(() => {
    MediaLibrary.getPermissionsAsync().then((p) => setPerm(p.granted ? (p.accessPrivileges === 'limited' ? 'limited' : 'granted') : p.canAskAgain ? 'unknown' : 'denied')).catch(() => setPerm('unknown'));
  }, [app.settings.onboardingDone, segments]);

  useEffect(() => {
    if (!app.ready) return;
    const step: Step = nextStep({ token: app.token, me: app.me, settings: app.settings, photoPermission: perm });
    const inOnboarding = segments[0] === '(onboarding)';
    const current = (segments as readonly string[])[1];
    if (step === 'done') { if (inOnboarding) router.replace('/(tabs)'); return; }
    if (!inOnboarding || current !== step) router.replace(`/(onboarding)/${step}` as never);
  }, [app.ready, app.token, app.me, app.settings, perm, segments, router]);

  return <>{children}</>;
}

export default function RootLayout() {
  const t = useTheme();
  return (
    <QueryClientProvider client={qc}>
      <AppProvider>
        <Gate>
          <StatusBar style={t.dark ? 'light' : 'dark'} />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </Gate>
      </AppProvider>
    </QueryClientProvider>
  );
}

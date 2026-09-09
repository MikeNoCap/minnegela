import React from 'react';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/ui/theme';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  const { t: tr } = useTranslation();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.ink3, tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line } }}>
      <Tabs.Screen name="index" options={{ title: tr('tabs.home'), tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="library" options={{ title: tr('tabs.library'), tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="privacy" options={{ title: tr('tabs.privacy'), tabBarIcon: icon('◐') }} />
      <Tabs.Screen name="group" options={{ title: tr('tabs.group'), tabBarIcon: icon('⬡') }} />
    </Tabs>
  );
}

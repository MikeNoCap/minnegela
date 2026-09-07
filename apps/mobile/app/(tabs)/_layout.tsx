import React from 'react';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useTheme } from '@/ui/theme';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.ink3, tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line } }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="library" options={{ title: 'Library', tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="privacy" options={{ title: 'Privacy', tabBarIcon: icon('◐') }} />
      <Tabs.Screen name="group" options={{ title: 'Group', tabBarIcon: icon('⬡') }} />
    </Tabs>
  );
}

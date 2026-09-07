import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from './theme';

export function Screen({ children, title, scroll = true }: { children: React.ReactNode; title?: string; scroll?: boolean }) {
  const t = useTheme();
  const body = (
    <View style={{ padding: 20, gap: 16 }}>
      {title ? <Text style={{ fontSize: 28, fontWeight: '700', color: t.ink, letterSpacing: -0.5 }}>{title}</Text> : null}
      {children}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">{body}</ScrollView> : <View style={{ flex: 1 }}>{body}</View>}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.surface, borderColor: t.line, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 16, gap: 10 }, style]}>{children}</View>;
}

export function P({ children, muted, small, bold }: { children: React.ReactNode; muted?: boolean; small?: boolean; bold?: boolean }) {
  const t = useTheme();
  return <Text style={{ color: muted ? t.ink2 : t.ink, fontSize: small ? 13 : 16, lineHeight: small ? 18 : 22, fontWeight: bold ? '600' : '400' }}>{children}</Text>;
}
export function H2({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.ink, fontSize: 18, fontWeight: '600' }}>{children}</Text>;
}
export function Mono({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.ink3, fontSize: 12, fontFamily: 'monospace' }}>{children}</Text>;
}

export function Button({ title, onPress, kind = 'primary', disabled, loading }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; loading?: boolean }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : t.accentSoft;
  const fg = kind === 'secondary' ? t.accent : '#fff';
  return (
    <Pressable onPress={onPress} disabled={disabled || loading} style={({ pressed }) => ({ backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1, paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center' })}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {props.label ? <Text style={{ color: t.ink2, fontSize: 13 }}>{props.label}</Text> : null}
      <TextInput placeholderTextColor={t.ink3} {...props} style={[{ borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 12, color: t.ink, backgroundColor: t.surface, fontSize: 16 }, props.style]} />
    </View>
  );
}

export function Row({ label, value, onPress }: { label: string; value?: React.ReactNode; onPress?: () => void }) {
  const t = useTheme();
  const inner = (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }}>
      <Text style={{ color: t.ink, fontSize: 16, flexShrink: 1 }}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? <Text style={{ color: t.ink2, fontSize: 15 }}>{value}</Text> : value}
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{inner}</Pressable> : inner;
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  const t = useTheme();
  return (
    <View style={{ minWidth: 80 }}>
      <Text style={{ color: t.ink, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
      <Text style={{ color: t.ink3, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Ring({ fraction, size = 64 }: { fraction: number; size?: number }) {
  // A dependency-free progress indicator: a bar rendered as a ring-ish pill. Good enough for v1.
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <View style={{ width: size * 2, height: 10, borderRadius: 5, backgroundColor: t.accentSoft, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: t.accent }} />
    </View>
  );
}

export function Banner({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warn' }) {
  const t = useTheme();
  return <View style={{ backgroundColor: tone === 'warn' ? t.amberSoft : t.accentSoft, borderRadius: 10, padding: 12 }}><Text style={{ color: t.ink }}>{children}</Text></View>;
}

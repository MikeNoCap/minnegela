import { useColorScheme } from 'react-native';

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    bg: dark ? '#131522' : '#f6f7fb',
    surface: dark ? '#1a1d2e' : '#ffffff',
    ink: dark ? '#e8e9f3' : '#1a1d2e',
    ink2: dark ? '#b7bacd' : '#4a4f66',
    ink3: dark ? '#8b8fa8' : '#7a7f97',
    line: dark ? '#2d3148' : '#dadcea',
    accent: dark ? '#9d94f0' : '#4a3fb0',
    accentSoft: dark ? '#272a4a' : '#e9e7fb',
    danger: dark ? '#f08a8a' : '#b3261e',
    amberSoft: dark ? '#3a2f1a' : '#fbf1dd',
  };
}
export type Theme = ReturnType<typeof useTheme>;

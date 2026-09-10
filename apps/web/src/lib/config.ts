/** Public API base. Server components use API_URL when set (compose network), the browser uses NEXT_PUBLIC_API_URL. */
export const API_URL = (typeof window === 'undefined' ? process.env.API_URL : undefined) ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const GROUP_KEY = 'minnegela.groupId';

/** MapLibre style URLs (light / dark). OpenFreeMap needs no key; point these at a self-hosted style to go offline (§17.1). */
export const MAP_STYLE_LIGHT = process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT ?? 'https://tiles.openfreemap.org/styles/positron';
export const MAP_STYLE_DARK = process.env.NEXT_PUBLIC_MAP_STYLE_DARK ?? 'https://tiles.openfreemap.org/styles/dark';

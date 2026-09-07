/** Public API base. Server components use API_URL when set (compose network), the browser uses NEXT_PUBLIC_API_URL. */
export const API_URL = (typeof window === 'undefined' ? process.env.API_URL : undefined) ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const GROUP_KEY = 'minnegela.groupId';

import { API_URL } from './config';
import type { Problem } from '@minnegela/shared';

export class ApiError extends Error {
  constructor(public status: number, public problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

type Opts = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal; redirectOn401?: boolean };

/** Typed fetch against the API. Cookies carry the session; problem+json becomes ApiError; 401 sends the browser to /login. */
export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && opts.redirectOn401 !== false && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    }
    const p = (data && typeof data === 'object' && 'title' in (data as object)) ? (data as Problem) : { type: 'about:blank', title: res.statusText || 'Request failed', status: res.status, detail: text.slice(0, 300) };
    throw new ApiError(res.status, p);
  }
  return data as T;
}

export const qs = (params: Record<string, string | number | boolean | undefined | null | Array<string | number>>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { if (v.length) u.set(k, v.join(',')); continue; }
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
};

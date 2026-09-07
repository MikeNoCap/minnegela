'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useGroupId } from './group';

export type UrlKind = 'thumb' | 'preview' | 'orig' | 'video720' | 'poster';
type Key = `${string}:${UrlKind}`;

/**
 * Batch signer. Requests from every mounted component in one render tick are coalesced into one
 * POST /groups/:g/media/urls; results are cached for 50 minutes, just under the API's hour-bucketed
 * signature window (§15.0), so repeated renders reuse the same URL and the browser cache hits.
 */
const TTL_MS = 50 * 60 * 1000;
const cache = new Map<Key, { url: string | null; at: number }>();
const listeners = new Set<() => void>();
let pending = new Map<Key, true>();
let pendingGroup = '';
let timer: ReturnType<typeof setTimeout> | null = null;
const inflight = new Set<Key>();

function notify() { for (const l of listeners) l(); }

async function flush() {
  timer = null;
  const keys = [...pending.keys()];
  const g = pendingGroup;
  pending = new Map();
  if (!keys.length || !g) return;
  for (const k of keys) inflight.add(k);
  const chunks: Key[][] = [];
  for (let i = 0; i < keys.length; i += 400) chunks.push(keys.slice(i, i + 400));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const res = await api<{ urls: Record<string, string> }>(`/v1/groups/${g}/media/urls`, {
        method: 'POST',
        body: { items: chunk.map((k) => { const i = k.lastIndexOf(':'); return { blobId: k.slice(0, i), kind: k.slice(i + 1) }; }) },
      });
      const now = Date.now();
      for (const k of chunk) cache.set(k, { url: res.urls[k] ?? null, at: now });
    } catch {
      const now = Date.now();
      for (const k of chunk) cache.set(k, { url: null, at: now - TTL_MS + 30_000 }); // retry after 30 s
    } finally {
      for (const k of chunk) inflight.delete(k);
    }
  }));
  notify();
}

function request(groupId: string, keys: Key[]) {
  const now = Date.now();
  let added = false;
  for (const k of keys) {
    const c = cache.get(k);
    if (c && now - c.at < TTL_MS) continue;
    if (inflight.has(k) || pending.has(k)) continue;
    pending.set(k, true); pendingGroup = groupId; added = true;
  }
  if (added && !timer) timer = setTimeout(flush, 0);
}

export function useMediaUrls(items: Array<{ blobId: string; kind: UrlKind }>): Record<string, string | null> {
  const groupId = useGroupId();
  const keys = useMemo(() => items.map((i) => `${i.blobId}:${i.kind}` as Key), [items]);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => { if (groupId && keys.length) request(groupId, keys); }, [groupId, keys]);
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = cache.get(k)?.url ?? null;
  return out;
}

export function useMediaUrl(blobId: string | null | undefined, kind: UrlKind): string | null {
  const items = useMemo(() => (blobId ? [{ blobId, kind }] : []), [blobId, kind]);
  const urls = useMediaUrls(items);
  return blobId ? urls[`${blobId}:${kind}`] ?? null : null;
}

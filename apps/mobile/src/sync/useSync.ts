import { useCallback, useEffect, useRef, useState } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useApp } from '@/store/context';
import type { Settings } from '@/store/settings';
import { runSync, SYNC_KEYS } from './runner';
import { mediaLibrary, expoUploader, currentConditions } from './adapters';
import { setBackgroundDeps, registerBackgroundSync } from './background';
import type { SyncDeps, SyncProgress, SyncSummary } from './types';
import type { Counts } from '@/db/types';

export type FullSyncReason = 'drained' | 'waiting' | 'stopped' | 'stalled' | 'limit';
export type FullSyncState = {
  status: 'idle' | 'running' | 'stopping' | 'done';
  pass: number;
  totals: Pick<SyncSummary, 'enumerated' | 'manifested' | 'previews' | 'originals' | 'deleted' | 'failed'>;
  startedAt: number | null;
  reason: FullSyncReason | null;
  lastError: string | null;
};
const IDLE_FULL: FullSyncState = { status: 'idle', pass: 0, totals: { enumerated: 0, manifested: 0, previews: 0, originals: 0, deleted: 0, failed: 0 }, startedAt: null, reason: null, lastError: null };

/** Builds the runner dependencies from live app state; shared by the foreground button and the background task. */
export function useSyncDeps(): SyncDeps {
  const app = useApp();
  const settingsRef = useRef<Settings>(app.settings);
  settingsRef.current = app.settings;
  const personId = app.me?.groups.find((g) => g.id === app.settings.groupId)?.personId ?? null;
  return {
    db: app.db,
    api: app.api,
    library: mediaLibrary,
    uploader: expoUploader,
    conditions: currentConditions,
    settings: () => settingsRef.current,
    saveSettings: (s) => app.updateSettings(() => s),
    personId: () => personId,
    log: (msg, extra) => console.log('[sync]', msg, extra ?? ''),
  };
}

export function useSync() {
  const deps = useSyncDeps();
  const app = useApp();
  const [progress, setProgress] = useState<SyncProgress>({ phase: 'idle', done: 0, total: 0 });
  const [counts, setCounts] = useState<Counts | null>(null);
  const [last, setLast] = useState<{ at: number | null; error: string | null; summary: SyncSummary | null }>({ at: null, error: null, summary: null });
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const refresh = useCallback(async () => {
    setCounts(await app.db.counts());
    const [at, error, summary] = await Promise.all([app.db.getSyncState(SYNC_KEYS.lastSyncAt), app.db.getSyncState(SYNC_KEYS.lastError), app.db.getSyncState(SYNC_KEYS.lastSummary)]);
    setLast({ at: at ? Number(at) : null, error, summary: summary ? (JSON.parse(summary) as SyncSummary) : null });
  }, [app.db]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setBackgroundDeps(async () => depsRef.current);
    void registerBackgroundSync();
  }, []);

  const syncNow = useCallback(async (opts: { budgetMs?: number; maxItems?: number } = {}) => {
    let lastPhase: SyncProgress['phase'] | null = null;
    const onProgress = (p: SyncProgress) => {
      setProgress(p);
      // Counts only change between phases; refreshing on each phase change keeps the overlay's
      // totals live during a long pass without querying per item.
      if (p.phase !== lastPhase) { lastPhase = p.phase; void app.db.counts().then(setCounts); }
    };
    const s = await runSync(depsRef.current, { budgetMs: opts.budgetMs ?? 5 * 60_000, maxItems: opts.maxItems ?? 500, onProgress });
    await refresh();
    return s;
  }, [app.db, refresh]);

  // Full sync: chain bounded passes until a pass finds nothing left to do (or the
  // user stops it). Bounded passes stay crash-safe; the loop just removes the taps.
  const [full, setFull] = useState<FullSyncState>(IDLE_FULL);
  const stopFullRef = useRef(false);
  const stopFullSync = useCallback(() => {
    stopFullRef.current = true;
    setFull((f) => (f.status === 'running' ? { ...f, status: 'stopping' } : f));
  }, []);
  const dismissFullSync = useCallback(() => setFull(IDLE_FULL), []);
  const fullSync = useCallback(async () => {
    if (stopFullRef.current) return; // already winding down
    try { await activateKeepAwakeAsync('full-sync'); } catch { /* keep-awake is best effort */ }
    const totals = { ...IDLE_FULL.totals };
    let reason: FullSyncReason = 'limit';
    let lastError: string | null = null;
    setFull({ status: 'running', pass: 0, totals, startedAt: Date.now(), reason: null, lastError: null });
    let idlePasses = 0;
    try {
      for (let pass = 1; pass <= 50; pass++) {
        if (stopFullRef.current) { reason = 'stopped'; break; }
        setFull((f) => ({ ...f, pass }));
        const s = await syncNow();
        for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += s[k];
        lastError = s.lastError;
        setFull((f) => ({ ...f, totals: { ...totals }, lastError }));
        const work = s.enumerated + s.manifested + s.previews + s.originals + s.deleted;
        if (work === 0 && !s.stoppedEarly) { reason = 'drained'; break; } // backlog drained or policy defers under current conditions
        idlePasses = work === 0 ? idlePasses + 1 : 0;
        if (idlePasses >= 2) { reason = 'stalled'; break; } // budget keeps expiring with no progress: do not spin
      }
      if (stopFullRef.current) reason = 'stopped';
      // "Drained" with items still queued means the policy is holding them (Wi-Fi, charging, offline).
      const c = await app.db.counts();
      if (reason === 'drained' && c.new + c.manifested + c.preview_uploaded > 0) reason = 'waiting';
      setCounts(c);
    } finally {
      stopFullRef.current = false;
      setFull((f) => ({ ...f, status: 'done', reason, lastError }));
      try { deactivateKeepAwake('full-sync'); } catch { /* ignore */ }
    }
  }, [app.db, syncNow]);

  const fullPass = full.status === 'running' || full.status === 'stopping' ? full.pass : 0;
  return { progress, counts, last, syncNow, fullSync, stopFullSync, dismissFullSync, full, fullPass, refresh, busy: progress.phase !== 'idle' };
}

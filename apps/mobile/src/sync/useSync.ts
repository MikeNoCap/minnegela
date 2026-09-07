import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/store/context';
import type { Settings } from '@/store/settings';
import { runSync, SYNC_KEYS } from './runner';
import { mediaLibrary, expoUploader, currentConditions } from './adapters';
import { setBackgroundDeps, registerBackgroundSync } from './background';
import type { SyncDeps, SyncProgress, SyncSummary } from './types';
import type { Counts } from '@/db/types';

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
    const s = await runSync(depsRef.current, { budgetMs: opts.budgetMs ?? 5 * 60_000, maxItems: opts.maxItems ?? 500, onProgress: setProgress });
    await refresh();
    return s;
  }, [refresh]);

  return { progress, counts, last, syncNow, refresh, busy: progress.phase !== 'idle' };
}

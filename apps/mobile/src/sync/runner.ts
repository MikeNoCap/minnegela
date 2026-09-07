import type { LocalAsset } from '@/db/types';
import { applyRules } from './rules';
import { decide } from './policy';
import { toManifestItem, stateForAction } from './manifest';
import type { SyncDeps, SyncProgress, SyncSummary } from './types';

export const SYNC_KEYS = {
  cursorCreatedAfter: 'enumerate.createdAfter',
  lastReconcile: 'reconcile.lastAt',
  lastSyncAt: 'sync.lastAt',
  lastError: 'sync.lastError',
  lastSummary: 'sync.lastSummary',
} as const;

const RECONCILE_EVERY_MS = 7 * 24 * 3600_000;
const MAX_ATTEMPTS = 5;

/**
 * §16.3 One bounded, idempotent pass: enumerate → (reconcile weekly) → manifest → preview → original → enroll.
 * Every step checks the time budget and item cap so it can run inside a 30 s background window
 * and simply continue next time. Safe to call concurrently only from one place (the runner keeps
 * a module-level lock).
 */
let running: Promise<SyncSummary> | null = null;

export function runSync(deps: SyncDeps, opts: { budgetMs: number; maxItems: number; onProgress?: (p: SyncProgress) => void; force?: boolean }): Promise<SyncSummary> {
  if (running) return running;
  running = runSyncInner(deps, opts).finally(() => { running = null; });
  return running;
}

async function runSyncInner(deps: SyncDeps, opts: { budgetMs: number; maxItems: number; onProgress?: (p: SyncProgress) => void }): Promise<SyncSummary> {
  const now = deps.now ?? Date.now;
  const start = now();
  const log = deps.log ?? (() => {});
  const sum: SyncSummary = { enumerated: 0, manifested: 0, previews: 0, originals: 0, deleted: 0, failed: 0, stoppedEarly: false, lastError: null, enrolled: false };
  const over = () => now() - start > opts.budgetMs;
  const progress = (p: SyncProgress) => opts.onProgress?.(p);
  const settings = deps.settings();
  const groupId = settings.groupId;
  const deviceId = settings.deviceId;
  const fail = (e: unknown) => { sum.failed++; sum.lastError = e instanceof Error ? e.message : String(e); log('sync error', { error: sum.lastError }); };

  try {
    // 1. enumerate
    progress({ phase: 'enumerate', done: 0, total: 0 });
    const cursorRaw = await deps.db.getSyncState(SYNC_KEYS.cursorCreatedAfter);
    let createdAfter = cursorRaw ? Number(cursorRaw) : null;
    let after: string | null = null;
    while (!over() && sum.enumerated < opts.maxItems * 4) {
      const page = await deps.library.page({ createdAfter, after, first: 200, includeVideos: settings.policy.includeVideos });
      if (!page.assets.length) break;
      await deps.db.upsertLocal(page.assets.map((a) => {
        const r = applyRules(a, settings.rules);
        return { ...a, state: r.excluded ? 'excluded' as const : 'new' as const };
      }));
      sum.enumerated += page.assets.length;
      const newest = Math.max(...page.assets.map((a) => Date.parse(a.createdAt)));
      if (Number.isFinite(newest)) createdAfter = Math.max(createdAfter ?? 0, newest);
      progress({ phase: 'enumerate', done: sum.enumerated, total: 0 });
      if (!page.hasNextPage) break;
      after = page.endCursor;
    }
    if (createdAfter !== null) await deps.db.setSyncState(SYNC_KEYS.cursorCreatedAfter, String(createdAfter));

    // 2. reconcile (weekly): deletions on the phone propagate as soft deletes (§18.7)
    const lastRec = Number((await deps.db.getSyncState(SYNC_KEYS.lastReconcile)) ?? 0);
    if (!over() && groupId && now() - lastRec > RECONCILE_EVERY_MS) {
      progress({ phase: 'reconcile', done: 0, total: 0 });
      try {
        const present = new Set(await deps.library.allIds());
        const gone = await deps.db.markDeletedExcept(present);
        for (const g of gone) {
          if (over()) { sum.stoppedEarly = true; break; }
          try { await deps.api.deleteAsset(g.serverAssetId!); sum.deleted++; } catch (e) { fail(e); }
        }
        if (!sum.stoppedEarly) await deps.db.setSyncState(SYNC_KEYS.lastReconcile, String(now()));
      } catch (e) { fail(e); }
    }

    if (!groupId || !deviceId) { sum.lastError = 'not configured (group or device missing)'; return finish(); }

    // 3. manifest: enrollment photos first so the face is known as early as possible
    const pendingEnroll = settings.enrollment.pendingLocalIds;
    const prioritized = pendingEnroll.length ? await deps.db.listByState('new', 20, { localIds: pendingEnroll }) : [];
    const fresh = await deps.db.listByState('new', Math.max(0, Math.min(200, opts.maxItems) - prioritized.length));
    const batch = [...prioritized, ...fresh.filter((f) => !prioritized.some((p) => p.localId === f.localId))];
    if (batch.length && !over()) {
      progress({ phase: 'manifest', done: 0, total: batch.length });
      const items = [];
      for (const a of batch) {
        try {
          const md5 = a.md5 ?? (await deps.library.md5(a));
          if (md5 && md5 !== a.md5) await deps.db.setState(a.localId, { md5 });
          items.push({ a, item: toManifestItem(a, md5) });
        } catch (e) { await deps.db.setState(a.localId, { state: 'failed', lastError: String(e) }); fail(e); }
      }
      if (items.length) {
        try {
          const res = await deps.api.manifest(groupId, { deviceId, assets: items.map((i) => i.item) });
          for (const r of res.results) {
            await deps.db.setState(r.localId, { state: stateForAction(r.action), serverAssetId: r.assetId, lastError: null });
            if (r.action === 'want_preview' && r.upload) pendingUploads.set(r.localId, r.upload);
            sum.manifested++;
          }
        } catch (e) { fail(e); }
      }
    }

    // 4. previews
    const cond = await deps.conditions();
    const toPreview = await deps.db.listByState('manifested', opts.maxItems);
    const enrollFirst = [...toPreview].sort((x, y) => Number(pendingEnroll.includes(y.localId)) - Number(pendingEnroll.includes(x.localId)));
    let i = 0;
    for (const a of enrollFirst) {
      if (over()) { sum.stoppedEarly = true; break; }
      const d = decide(cond, settings.policy, { isVideo: a.isVideo, size: a.size });
      if (!d.allowPreview) { log('preview deferred', { reason: d.reason }); break; }
      progress({ phase: 'preview', done: i++, total: enrollFirst.length });
      try {
        await uploadOne(deps, a, 'preview', groupId, pendingUploads.get(a.localId));
        pendingUploads.delete(a.localId);
        await deps.db.setState(a.localId, { state: 'preview_uploaded', lastError: null, attempts: 0 });
        sum.previews++;
      } catch (e) { await markFailure(deps, a, e); fail(e); }
    }

    // 5. originals, by policy
    const toOriginal = await deps.db.listByState('preview_uploaded', opts.maxItems);
    i = 0;
    for (const a of toOriginal) {
      if (over()) { sum.stoppedEarly = true; break; }
      const d = decide(cond, settings.policy, { isVideo: a.isVideo, size: a.size });
      if (!d.allowOriginal) { if (a.isVideo && d.reason?.includes('cap')) continue; break; }
      progress({ phase: 'original', done: i++, total: toOriginal.length });
      try {
        await uploadOne(deps, a, 'original', groupId);
        await deps.db.setState(a.localId, { state: 'original_uploaded', lastError: null, attempts: 0 });
        sum.originals++;
      } catch (e) { await markFailure(deps, a, e); fail(e); }
    }

    // 6. enrollment: retried every pass until the server has found faces on the reference photos
    if (pendingEnroll.length && !over()) {
      const personId = deps.personId();
      const rows = await Promise.all(pendingEnroll.map((id) => deps.db.get(id)));
      const uploaded = rows.filter((r): r is LocalAsset => !!r && !!r.serverAssetId && (r.state === 'preview_uploaded' || r.state === 'original_uploaded' || r.state === 'skipped'));
      if (personId && uploaded.length && uploaded.length === rows.filter(Boolean).length) {
        progress({ phase: 'enroll', done: 0, total: 1 });
        try {
          await deps.api.enroll(personId, uploaded.map((r) => r.serverAssetId!));
          sum.enrolled = true;
          await deps.saveSettings({ ...deps.settings(), enrollment: { pendingLocalIds: [], doneAt: new Date(now()).toISOString(), lastError: null } });
        } catch (e) {
          const s = deps.settings();
          await deps.saveSettings({ ...s, enrollment: { ...s.enrollment, lastError: e instanceof Error ? e.message : String(e) } });
        }
      }
    }
  } catch (e) { fail(e); }
  return finish();

  async function finish() {
    await deps.db.setSyncState(SYNC_KEYS.lastSyncAt, String(now()));
    await deps.db.setSyncState(SYNC_KEYS.lastError, sum.lastError);
    await deps.db.setSyncState(SYNC_KEYS.lastSummary, JSON.stringify(sum));
    progress({ phase: 'idle', done: 0, total: 0 });
    return sum;
  }
}

/** Upload targets handed back by the manifest, valid for 15 minutes; re-issued via /sync/uploads after that. */
const pendingUploads = new Map<string, import('@minnegela/shared').UploadTarget>();

async function uploadOne(deps: SyncDeps, a: LocalAsset, kind: 'preview' | 'original', groupId: string, presigned?: import('@minnegela/shared').UploadTarget) {
  if (!a.serverAssetId) throw new Error('no server asset id');
  const file = kind === 'preview' ? await deps.uploader.preparePreview(a) : await deps.uploader.prepareOriginal(a);
  try {
    let target = presigned && kind === 'preview' && Date.parse(presigned.expiresAt) > Date.now() + 60_000 ? presigned : null;
    if (!target) {
      const res = await deps.api.uploads(groupId, [{ assetId: a.serverAssetId, kind, bytes: file.bytes, mime: file.mime }]);
      target = res.items[0]?.upload ?? null;
      if (!target) throw new Error('server did not issue an upload URL (asset not yours or deleted)');
    }
    await deps.uploader.put(target, file);
    await deps.api.complete(a.serverAssetId, kind, file.sha256, file.bytes);
  } finally {
    await file.cleanup();
  }
}

async function markFailure(deps: SyncDeps, a: LocalAsset, e: unknown) {
  const attempts = a.attempts + 1;
  await deps.db.setState(a.localId, { attempts, lastError: e instanceof Error ? e.message : String(e), state: attempts >= MAX_ATTEMPTS ? 'failed' : a.state });
}

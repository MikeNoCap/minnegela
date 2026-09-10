import type { LocalAsset } from '@/db/types';
import { applyRules } from './rules';
import { decide } from './policy';
import { toManifestItem, stateForAction } from './manifest';
import { isEnrollImport } from './enrollPick';
import type { PreparedUpload, SyncDeps, SyncProgress, SyncSummary } from './types';

export const SYNC_KEYS = {
  /** ms epoch: every asset modified at or before this has been walked by a completed enumeration. */
  enumerateHighWater: 'enumerate.highWater',
  /** JSON {@link EnumerateResume}: a walk that ran out of budget and continues next pass. */
  enumerateResume: 'enumerate.resume',
  lastReconcile: 'reconcile.lastAt',
  lastSyncAt: 'sync.lastAt',
  lastError: 'sync.lastError',
  lastSummary: 'sync.lastSummary',
  /** §7.4: rows known to the server have been re-manifested with provenance signals up to this version. */
  provenanceVersion: 'provenance.version',
  /** 'started' while the one-off full re-walk that collects those signals runs, 'done' after. */
  provenanceWalk: 'provenance.walk',
} as const;

const RECONCILE_EVERY_MS = 7 * 24 * 3600_000;
const MAX_ATTEMPTS = 5;
/** Uploads in flight at once. The per-asset cost is mostly waiting on R2 and the API, so a few
 * overlap well; originals are large, so fewer of them. */
export const UPLOAD_CONCURRENCY = { preview: 4, original: 2 } as const;
/** Assets prepared and presigned per /sync/uploads call. The endpoint allows 120 calls a minute
 * per client, so presigning one asset at a time cannot survive concurrent uploads. */
export const PRESIGN_BATCH = 8;
/** Transient answers (rate limit, server hiccup) do not burn one of the asset's 5 attempts. */
const isTransient = (e: unknown) => { const st = (e as { status?: number })?.status; return st === 429 || (typeof st === 'number' && st >= 500); };

/**
 * Run `fn` over `items` with at most `n` in flight, in order. `gate` runs before each launch and
 * returns true to stop launching; `fn` returns 'stop' to do the same. In-flight work always finishes.
 */
export async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<'ok' | 'stop'>, gate: () => boolean = () => false): Promise<void> {
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      if (gate()) { stopped = true; return; }
      const item = items[next++]!;
      if ((await fn(item)) === 'stop') stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

type EnumerateResume = { after: string | null; newest: number; highWater: number };
/** Bump when the manifest gains provenance signals the server should regrade existing assets with. */
export const PROVENANCE_VERSION = '1';
const modifiedMs = (a: { modifiedAt: string | null; createdAt: string }) => Date.parse(a.modifiedAt ?? a.createdAt);

/** Forget the enumeration position so the next pass walks the whole library again (rules changed). */
export async function resetEnumeration(db: Pick<SyncDeps['db'], 'setSyncState'>): Promise<void> {
  await db.setSyncState(SYNC_KEYS.enumerateHighWater, null);
  await db.setSyncState(SYNC_KEYS.enumerateResume, null);
}

/**
 * §16.3 One bounded, idempotent pass: enumerate → (reconcile weekly) → manifest → preview → original → enroll.
 * Every step checks the time budget and item cap so it can run inside a 30 s background window
 * and simply continue next time. Safe to call concurrently only from one place (the runner keeps
 * a module-level lock).
 */
let running: Promise<SyncSummary> | null = null;

export type SyncOpts = { budgetMs: number; maxItems: number; onProgress?: (p: SyncProgress) => void; force?: boolean; concurrency?: { preview: number; original: number } };

export function runSync(deps: SyncDeps, opts: SyncOpts): Promise<SyncSummary> {
  if (running) return running;
  running = runSyncInner(deps, opts).finally(() => { running = null; });
  return running;
}

async function runSyncInner(deps: SyncDeps, opts: SyncOpts): Promise<SyncSummary> {
  const concurrency = opts.concurrency ?? UPLOAD_CONCURRENCY;
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
    // 1. enumerate: newest modification first, down to the high-water mark of the last completed
    // walk. The query never changes mid-walk (Android pages by row offset), and the mark only moves
    // once a walk finishes; an interrupted walk stores its position and resumes next pass.
    progress({ phase: 'enumerate', done: 0, total: 0 });
    // §7.4 one-off: an app that learned to read provenance signals walks the whole library again so
    // every row carries them before the server is asked to regrade
    const provenanceDone = (await deps.db.getSyncState(SYNC_KEYS.provenanceVersion)) === PROVENANCE_VERSION;
    let provenanceWalk = await deps.db.getSyncState(SYNC_KEYS.provenanceWalk);
    if (!provenanceDone && provenanceWalk === null) {
      if ((await deps.db.listRegrade(1)).length) {
        await resetEnumeration(deps.db);
        provenanceWalk = 'started';
        await deps.db.setSyncState(SYNC_KEYS.provenanceWalk, provenanceWalk);
      } else {
        // nothing the server knows yet (fresh install): every row it will ever see carries the signals
        await deps.db.setSyncState(SYNC_KEYS.provenanceVersion, PROVENANCE_VERSION);
      }
    }
    const highWater = Number((await deps.db.getSyncState(SYNC_KEYS.enumerateHighWater)) ?? 0);
    const resumeRaw = await deps.db.getSyncState(SYNC_KEYS.enumerateResume);
    let resume: EnumerateResume | null = null;
    try { resume = resumeRaw ? (JSON.parse(resumeRaw) as EnumerateResume) : null; } catch { resume = null; }
    if (resume && resume.highWater !== highWater) resume = null;   // mark was reset since; start over
    let after: string | null = resume?.after ?? null;
    let newest = resume?.newest ?? 0;
    let walkDone = false;
    for (;;) {
      if (over() || sum.enumerated >= opts.maxItems * 4) break;
      const page = await deps.library.page({ after, first: 200, includeVideos: settings.policy.includeVideos });
      const fresh = page.assets.filter((a) => modifiedMs(a) > highWater);
      if (fresh.length) {
        await deps.db.upsertLocal(fresh.map((a) => {
          const r = applyRules(a, settings.rules);
          return { ...a, state: r.excluded ? 'excluded' as const : 'new' as const };
        }));
        sum.enumerated += fresh.length;
        newest = Math.max(newest, ...fresh.map(modifiedMs).filter(Number.isFinite));
        progress({ phase: 'enumerate', done: sum.enumerated, total: 0 });
      }
      // Reached already-walked assets (descending order: everything after is older too) or the end.
      if (fresh.length < page.assets.length || !page.hasNextPage || !page.assets.length) { walkDone = true; break; }
      after = page.endCursor;
    }
    if (walkDone) {
      if (newest > highWater) await deps.db.setSyncState(SYNC_KEYS.enumerateHighWater, String(newest));
      if (resume) await deps.db.setSyncState(SYNC_KEYS.enumerateResume, null);
      if (provenanceWalk === 'started') { provenanceWalk = 'done'; await deps.db.setSyncState(SYNC_KEYS.provenanceWalk, provenanceWalk); }
    } else {
      sum.stoppedEarly = true;
      await deps.db.setSyncState(SYNC_KEYS.enumerateResume, JSON.stringify({ after, newest, highWater } satisfies EnumerateResume));
    }

    // 2. reconcile (weekly): deletions on the phone propagate as soft deletes (§18.7)
    const lastRec = Number((await deps.db.getSyncState(SYNC_KEYS.lastReconcile)) ?? 0);
    if (!over() && groupId && now() - lastRec > RECONCILE_EVERY_MS) {
      progress({ phase: 'reconcile', done: 0, total: 0 });
      try {
        const present = new Set(await deps.library.allIds());
        // Enrollment imports live in app storage, not the library; they are never "gone from the phone".
        for (const id of await deps.db.allLocalIds()) if (isEnrollImport(id)) present.add(id);
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

    // 3b. regrade (§7.4, one-off after the re-walk): tell the server what the phone now knows about
    // assets it already has; the server regrades origin and re-places the blob. No state changes here.
    if (!provenanceDone && provenanceWalk === 'done') {
      for (;;) {
        if (over()) { sum.stoppedEarly = true; break; }
        const rows = await deps.db.listRegrade(200);
        if (!rows.length) { await deps.db.setSyncState(SYNC_KEYS.provenanceVersion, PROVENANCE_VERSION); break; }
        progress({ phase: 'manifest', done: 0, total: rows.length });
        try {
          await deps.api.manifest(groupId, { deviceId, assets: rows.map((a) => toManifestItem(a, a.md5)) });
          await deps.db.markRegraded(rows.map((a) => a.localId));
          sum.manifested += rows.length;
        } catch (e) { fail(e); break; }
      }
    }

    // 4. previews: prepared and presigned in batches, uploaded a few at a time (the wait is R2 and
    // the API, not the phone's CPU)
    const cond = await deps.conditions();
    const toPreview = await deps.db.listByState('manifested', opts.maxItems);
    const enrollFirst = [...toPreview].sort((x, y) => Number(pendingEnroll.includes(y.localId)) - Number(pendingEnroll.includes(x.localId)));
    const budgetGate = () => { if (over()) { sum.stoppedEarly = true; return true; } return false; };
    await uploadMany(deps, enrollFirst, 'preview', groupId, {
      concurrency: concurrency.preview,
      gate: budgetGate,
      allow: (a) => { const d = decide(cond, settings.policy, { isVideo: a.isVideo, size: a.size }); if (!d.allowPreview) log('preview deferred', { reason: d.reason }); return d.allowPreview ? 'ok' : 'stop'; },
      progress: (done, total) => progress({ phase: 'preview', done, total }),
      onDone: async (a) => { pendingUploads.delete(a.localId); await deps.db.setState(a.localId, { state: 'preview_uploaded', lastError: null, attempts: 0 }); sum.previews++; },
      onFail: async (a, e) => { await markFailure(deps, a, e); fail(e); },
    });

    // 5. originals, by policy
    const toOriginal = await deps.db.listByState('preview_uploaded', opts.maxItems);
    await uploadMany(deps, toOriginal, 'original', groupId, {
      concurrency: concurrency.original,
      gate: budgetGate,
      allow: (a) => { const d = decide(cond, settings.policy, { isVideo: a.isVideo, size: a.size }); return d.allowOriginal ? 'ok' : a.isVideo && d.reason?.includes('cap') ? 'skip' : 'stop'; },
      progress: (done, total) => progress({ phase: 'original', done, total }),
      onDone: async (a) => { await deps.db.setState(a.localId, { state: 'original_uploaded', lastError: null, attempts: 0 }); sum.originals++; },
      onFail: async (a, e) => { await markFailure(deps, a, e); fail(e); },
    });

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

type UploadHooks = {
  concurrency: number;
  gate: () => boolean;
  allow: (a: LocalAsset) => 'ok' | 'skip' | 'stop';
  progress: (done: number, total: number) => void;
  onDone: (a: LocalAsset) => Promise<void>;
  onFail: (a: LocalAsset, e: unknown) => Promise<void>;
};

/**
 * Upload `assets` of one kind: in batches of PRESIGN_BATCH, prepare the files, presign the ones
 * without a valid target in ONE /sync/uploads call, then PUT + complete a few at a time.
 */
async function uploadMany(deps: SyncDeps, assets: LocalAsset[], kind: 'preview' | 'original', groupId: string, h: UploadHooks): Promise<void> {
  let done = 0;
  let stopped = false;
  for (let start = 0; start < assets.length && !stopped; start += PRESIGN_BATCH) {
    if (h.gate()) return;
    const batch: LocalAsset[] = [];
    for (const a of assets.slice(start, start + PRESIGN_BATCH)) {
      const v = h.allow(a);
      if (v === 'stop') { stopped = true; break; }
      if (v === 'ok') batch.push(a);
    }
    if (!batch.length) continue;
    // prepare (native image work) for the whole batch
    const prepared: Array<{ a: LocalAsset; file: PreparedUpload; target: import('@minnegela/shared').UploadTarget | null }> = [];
    for (const a of batch) {
      if (!a.serverAssetId) { await h.onFail(a, new Error('no server asset id')); continue; }
      try {
        const file = kind === 'preview' ? await deps.uploader.preparePreview(a) : await deps.uploader.prepareOriginal(a);
        const pre = kind === 'preview' ? pendingUploads.get(a.localId) : undefined;
        prepared.push({ a, file, target: pre && Date.parse(pre.expiresAt) > Date.now() + 60_000 ? pre : null });
      } catch (e) { await h.onFail(a, e); }
    }
    // one presign call for everything that needs one
    const need = prepared.filter((p) => !p.target);
    if (need.length) {
      try {
        const res = await deps.api.uploads(groupId, need.map((p) => ({ assetId: p.a.serverAssetId!, kind, bytes: p.file.bytes, mime: p.file.mime })));
        const byId = new Map(res.items.map((i) => [i.assetId, i.upload]));
        for (const p of need) p.target = byId.get(p.a.serverAssetId!) ?? null;
      } catch (e) {
        for (const p of need) { await p.file.cleanup(); await h.onFail(p.a, e); }
        if (isTransient(e)) return;   // rate limited or server trouble: stop the phase, next pass retries
        continue;
      }
    }
    // upload + complete, a few at a time
    await runPool(prepared, h.concurrency, async (p) => {
      h.progress(done++, assets.length);
      try {
        if (!p.target) throw new Error('server did not issue an upload URL (asset not yours or deleted)');
        await deps.uploader.put(p.target, p.file);
        await deps.api.complete(p.a.serverAssetId!, kind, p.file.sha256, p.file.bytes);
        await h.onDone(p.a);
      } catch (e) { await h.onFail(p.a, e); } finally { await p.file.cleanup(); }
      return 'ok';
    }, h.gate);
  }
}

async function markFailure(deps: SyncDeps, a: LocalAsset, e: unknown) {
  const attempts = isTransient(e) ? a.attempts : a.attempts + 1;
  await deps.db.setState(a.localId, { attempts, lastError: e instanceof Error ? e.message : String(e), state: attempts >= MAX_ATTEMPTS ? 'failed' : a.state });
}

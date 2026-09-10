import { describe, it, expect } from 'vitest';
import { runSync, resetEnumeration, SYNC_KEYS } from '@/sync/runner';
import { makeDeps, FakeLibrary, FakeApi, FakeUploader, asset } from './fakes';

const run = (deps: ReturnType<typeof makeDeps>['deps'], o: Partial<{ budgetMs: number; maxItems: number }> = {}) => runSync(deps, { budgetMs: o.budgetMs ?? 10_000, maxItems: o.maxItems ?? 100 });

describe('sync runner (§16.3)', () => {
  it('enumerates, manifests, uploads previews and originals in one pass, applying rules', async () => {
    const lib = new FakeLibrary([asset(1), asset(2), asset(3, { isScreenshot: true, filename: 'Screenshot.png', mime: 'image/png' })]);
    const { deps, db, api, uploader } = makeDeps({ library: lib });
    const s = await run(deps);
    expect(s).toMatchObject({ enumerated: 3, manifested: 2, previews: 2, originals: 2, failed: 0 });
    expect((await db.get('L3'))!.state).toBe('excluded');
    expect(api.manifests).toHaveLength(1);
    expect(api.manifests[0]!.assets.map((a) => a.localId).sort()).toEqual(['L1', 'L2']);
    expect(uploader.puts.sort()).toEqual(['original-srv-L1', 'original-srv-L2', 'prev-L1', 'prev-L2']);
    expect(api.completed.filter((c) => c.kind === 'preview')).toHaveLength(2);
    expect((await db.get('L1'))!.state).toBe('original_uploaded');
    expect(await db.getSyncState(SYNC_KEYS.enumerateHighWater)).toBe(String(Date.parse(asset(3).createdAt)));
    expect(await db.getSyncState(SYNC_KEYS.enumerateResume)).toBeNull();
  });

  it('walks newest-modified first and stops at the high-water mark instead of re-reading the library', async () => {
    const lib = new FakeLibrary(Array.from({ length: 450 }, (_, i) => asset(i + 1)));
    const { deps, db } = makeDeps({ library: lib });
    expect((await run(deps, { maxItems: 500 })).enumerated).toBe(450);
    expect(lib.pages).toBe(3);
    lib.assets.push(asset(451));
    lib.pages = 0;
    expect((await run(deps)).enumerated).toBe(1);
    expect(lib.pages).toBe(1);                                    // first page already reached known assets
    expect((await db.counts()).total).toBe(451);
  });

  it('undated files (Snapchat-style, modified today) do not hide older camera photos', async () => {
    // Bug this guards: an enumeration keyed on creation time jumped its cursor to "today" on
    // page 1 because undated files sorted first, so no older camera photo was ever indexed.
    const camera = Array.from({ length: 250 }, (_, i) => asset(i + 1, { modifiedAt: asset(i + 1).createdAt }));
    const today = new Date(Date.UTC(2026, 8, 8, 12)).toISOString();
    const undated = Array.from({ length: 10 }, (_, i) => asset(900 + i, { filename: `Snapchat-${i}.jpg`, createdAt: today, modifiedAt: today }));
    const { deps, db } = makeDeps({ library: new FakeLibrary([...camera, ...undated]) });
    expect((await run(deps, { maxItems: 500 })).enumerated).toBe(260);
    expect((await db.counts()).total).toBe(260);
    expect(await db.get('L1')).not.toBeNull();
    expect(await db.get('L909')).not.toBeNull();
  });

  it('an enumeration that runs out of budget resumes next pass and still reaches the oldest assets', async () => {
    let t = 0;
    const lib = new FakeLibrary(Array.from({ length: 500 }, (_, i) => asset(i + 1)));
    const slowPage = lib.page.bind(lib);
    lib.page = async (o) => { t += 600; return slowPage(o); };
    const { deps, db } = makeDeps({ library: lib, now: () => t });
    const s1 = await run(deps, { budgetMs: 500, maxItems: 500 });
    expect(s1.enumerated).toBe(200);
    expect(s1.stoppedEarly).toBe(true);
    expect(await db.getSyncState(SYNC_KEYS.enumerateHighWater)).toBeNull();     // mark only moves on a completed walk
    expect(await db.getSyncState(SYNC_KEYS.enumerateResume)).not.toBeNull();
    t = 0;
    const s2 = await run(deps, { budgetMs: 100_000, maxItems: 500 });
    expect(s2.enumerated).toBe(300);
    expect((await db.counts()).total).toBe(500);
    expect(await db.getSyncState(SYNC_KEYS.enumerateResume)).toBeNull();
    expect(await db.getSyncState(SYNC_KEYS.enumerateHighWater)).toBe(String(Date.parse(asset(500).createdAt)));
    t = 0;
    expect((await run(deps, { budgetMs: 100_000, maxItems: 500 })).enumerated).toBe(0);
  });

  it('resetEnumeration makes the next pass re-walk everything without touching upload state', async () => {
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1), asset(2)]) });
    await run(deps);
    expect((await db.get('L1'))!.state).toBe('original_uploaded');
    await resetEnumeration(db);
    const s = await run(deps);
    expect(s.enumerated).toBe(2);
    expect(s.manifested).toBe(0);
    expect((await db.get('L1'))!.state).toBe('original_uploaded');
  });

  it('is idempotent: a second pass with nothing new does nothing', async () => {
    const { deps, api, uploader } = makeDeps({ library: new FakeLibrary([asset(1)]) });
    await run(deps);
    const s = await run(deps);
    expect(s).toMatchObject({ enumerated: 0, manifested: 0, previews: 0, originals: 0 });
    expect(api.manifests).toHaveLength(1); expect(uploader.puts).toHaveLength(2);
  });

  it('picks up only assets newer than the cursor on later passes', async () => {
    const lib = new FakeLibrary([asset(1)]);
    const { deps, api } = makeDeps({ library: lib });
    await run(deps);
    lib.assets.push(asset(5));
    const s = await run(deps);
    expect(s.enumerated).toBe(1);
    expect(api.manifests[1]!.assets.map((a) => a.localId)).toEqual(['L5']);
  });

  it('respects the policy: previews on cellular, originals wait; resumes when conditions change', async () => {
    let cond = { online: true, wifi: false, charging: false };
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1)]), conditions: async () => cond });
    let s = await run(deps);
    expect(s).toMatchObject({ previews: 1, originals: 0 });
    expect((await db.get('L1'))!.state).toBe('preview_uploaded');
    cond = { online: true, wifi: true, charging: true };
    s = await run(deps);
    expect(s).toMatchObject({ previews: 0, originals: 1 });
    expect((await db.get('L1'))!.state).toBe('original_uploaded');
  });

  it('stops at the time budget and continues next pass', async () => {
    let t = 0;
    const now = () => t;
    const uploader = new FakeUploader();
    const slow: FakeUploader = Object.assign(uploader, { put: async (target: { key: string }) => { t += 400; uploader.puts.push(target.key); } });
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1), asset(2), asset(3), asset(4)]), uploader: slow, now });
    const s1 = await run(deps, { budgetMs: 1000 });
    expect(s1.stoppedEarly).toBe(true);
    expect(s1.previews + s1.originals).toBeLessThan(8);
    const s2 = await run(deps, { budgetMs: 100_000 });
    expect(s1.previews + s2.previews).toBe(4);
    expect(s1.originals + s2.originals).toBe(4);
    expect((await db.counts()).original_uploaded).toBe(4);
  });

  it('a failed upload keeps the row retryable, then parks it after 5 attempts', async () => {
    const uploader = new FakeUploader(); uploader.failFor.add('prev-L1');
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1)]), uploader });
    for (let i = 0; i < 4; i++) { const s = await run(deps); expect(s.failed).toBe(1); expect((await db.get('L1'))!.state).toBe('manifested'); }
    await run(deps);
    expect((await db.get('L1'))!.state).toBe('failed');
    expect((await db.get('L1'))!.lastError).toMatch(/put failed/);
  });

  it('skip answers create no uploads; want_original goes straight to the original', async () => {
    const api = new FakeApi(); api.answer = (id) => (id === 'L1' ? 'skip' : 'want_original');
    const { deps, uploader, db } = makeDeps({ library: new FakeLibrary([asset(1), asset(2)]), api });
    const s = await run(deps);
    expect(s).toMatchObject({ previews: 0, originals: 1 });
    expect(uploader.puts).toEqual(['original-srv-L2']);
    expect((await db.get('L1'))!.state).toBe('skipped');
  });

  it('weekly reconcile propagates phone deletions to the server', async () => {
    const lib = new FakeLibrary([asset(1), asset(2)]);
    const { deps, api, db } = makeDeps({ library: lib });
    await run(deps);
    lib.assets = [asset(2)];
    await db.setSyncState(SYNC_KEYS.lastReconcile, '0');
    await run(deps);
    expect(api.deleted).toEqual(['srv-L1']);
    expect((await db.get('L1'))!.state).toBe('deleted');
  });

  it('enrollment photos go first and enroll is retried until the server has faces', async () => {
    const api = new FakeApi(); api.enrollShouldFail = true;
    const lib = new FakeLibrary([asset(1), asset(2), asset(3)]);
    const { deps, settings } = makeDeps({ library: lib, api, settings: { enrollment: { pendingLocalIds: ['L1'], doneAt: null, lastError: null } } });
    let s = await run(deps);
    expect(s.enrolled).toBe(false);
    expect(settings().enrollment.lastError).toMatch(/No faces/);
    expect(api.manifests[0]!.assets[0]!.localId).toBe('L1');    // prioritized
    api.enrollShouldFail = false;
    s = await run(deps);
    expect(s.enrolled).toBe(true);
    expect(api.enrolls).toEqual([{ personId: 7, assetIds: ['srv-L1'] }]);
    expect(settings().enrollment.pendingLocalIds).toEqual([]);
    expect(settings().enrollment.doneAt).toBeTruthy();
  });

  it('without a group or device it records the problem and does not call the API', async () => {
    const { deps, api } = makeDeps({ library: new FakeLibrary([asset(1)]), settings: { groupId: null } });
    const s = await run(deps);
    expect(s.lastError).toMatch(/not configured/);
    expect(api.manifests).toHaveLength(0);
  });
});

describe('upload concurrency', () => {
  it('runPool keeps n in flight, preserves order, and honours stop and the gate', async () => {
    const { runPool } = await import('@/sync/runner');
    let inFlight = 0, peak = 0; const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6], 3, async (x) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; done.push(x);
      return 'ok';
    });
    expect(peak).toBe(3);
    expect(done.slice(0, 3).sort()).toEqual([1, 2, 3]);
    const seq: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6], 1, async (x) => { seq.push(x); return x === 4 ? 'stop' : 'ok'; });
    expect(seq).toEqual([1, 2, 3, 4]);                    // nothing launched after a stop
    const seen: number[] = [];
    await runPool([1, 2, 3], 2, async (x) => { seen.push(x); return 'ok'; }, () => seen.length >= 1);
    expect(seen).toEqual([1]);
  });

  it('uploads several previews at once and the totals still add up', async () => {
    let inFlight = 0, peak = 0;
    const uploader = new FakeUploader();
    uploader.put = async (t) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; uploader.puts.push(t.key); };
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1), asset(2), asset(3), asset(4), asset(5), asset(6)]), uploader });
    const s = await run(deps);
    expect(s).toMatchObject({ previews: 6, originals: 6, failed: 0 });
    expect(peak).toBeGreaterThanOrEqual(2);
    expect((await db.counts()).original_uploaded).toBe(6);
  });
});

describe('presign batching and rate limits', () => {
  it('presigns a batch of originals in one /sync/uploads call instead of one per asset', async () => {
    const api = new FakeApi();
    let calls = 0; const orig = api.uploads.bind(api);
    api.uploads = async (g, items) => { calls++; return orig(g, items); };
    const lib = new FakeLibrary(Array.from({ length: 20 }, (_, i) => asset(i + 1)));
    const { deps } = makeDeps({ library: lib, api });
    const s = await run(deps);
    expect(s).toMatchObject({ previews: 20, originals: 20, failed: 0 });
    expect(calls).toBe(Math.ceil(20 / 8));                 // previews use manifest targets; originals presign per batch
  });

  it('a 429 on presign stops the phase without burning attempts; the next pass succeeds', async () => {
    const api = new FakeApi();
    let fail = true; const orig = api.uploads.bind(api);
    api.uploads = async (g, items) => { if (fail) { const e = new Error('Too Many Requests') as Error & { status: number }; e.status = 429; throw e; } return orig(g, items); };
    const { deps, db } = makeDeps({ library: new FakeLibrary([asset(1), asset(2)]), api });
    let s = await run(deps);
    expect(s.previews).toBe(2); expect(s.originals).toBe(0); expect(s.failed).toBe(2);
    expect((await db.get('L1'))!.attempts).toBe(0);           // transient: not counted
    expect((await db.get('L1'))!.state).toBe('preview_uploaded');
    fail = false;
    s = await run(deps);
    expect(s.originals).toBe(2);
  });
});

describe('provenance regrade (§7.4)', () => {
  it('an upgraded app re-walks the library once and re-manifests what the server already has', async () => {
    const { PROVENANCE_VERSION } = await import('@/sync/runner');
    const lib = new FakeLibrary([asset(1), asset(2)]);
    const { deps, db, api } = makeDeps({ library: lib });
    // an install that synced before provenance existed: rows known to the server, no signals, no version marker
    await db.upsertLocal([asset(1), asset(2)]);
    await db.setState('L1', { state: 'preview_uploaded', serverAssetId: 'A1' });
    await db.setState('L2', { state: 'skipped', serverAssetId: 'A2' });
    await db.setSyncState(SYNC_KEYS.enumerateHighWater, String(Date.now()));
    await run(deps);
    expect(await db.getSyncState(SYNC_KEYS.provenanceWalk)).toBe('done');
    expect(await db.getSyncState(SYNC_KEYS.provenanceVersion)).toBe(PROVENANCE_VERSION);
    expect(api.manifests).toHaveLength(1);
    expect(api.manifests[0]!.assets.map((a) => a.localId).sort()).toEqual(['L1', 'L2']);
    // the regrade answer did not reset states (the pass then carried L1 on to its original as usual)
    expect((await db.get('L1'))!.state).toBe('original_uploaded');
    expect((await db.get('L2'))!.state).toBe('skipped');
    await run(deps);
    expect(api.manifests).toHaveLength(1);
  });

  it('a fresh install never regrades', async () => {
    const { PROVENANCE_VERSION } = await import('@/sync/runner');
    const { deps, db, api } = makeDeps({ library: new FakeLibrary([asset(1)]) });
    await run(deps);
    expect(await db.getSyncState(SYNC_KEYS.provenanceVersion)).toBe(PROVENANCE_VERSION);
    expect(await db.getSyncState(SYNC_KEYS.provenanceWalk)).toBeNull();
    expect(api.manifests).toHaveLength(1);
  });
});

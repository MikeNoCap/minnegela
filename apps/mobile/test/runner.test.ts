import { describe, it, expect } from 'vitest';
import { runSync, SYNC_KEYS } from '@/sync/runner';
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
    expect(await db.getSyncState(SYNC_KEYS.cursorCreatedAfter)).toBe(String(Date.parse(asset(3).createdAt)));
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

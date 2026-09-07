import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import { seedFixture, type Fixture } from '../src/seed.js';
import { withViewer, visibleEventsWhere, visibleAssetsWhere, type ViewerCtx } from '../src/viewer.js';
import { enqueue, claimJobs, completeJob, failJob } from '../src/jobs.js';
import * as s from '../src/schema/index.js';

/**
 * Runs against a real Postgres. Requires DATABASE_URL_ADMIN (+ DATABASE_URL for the api role, + DATABASE_URL_WORKER).
 * Every event of the six-branch fixture is checked from every member's point of view, through RLS
 * (api role, no explicit predicate) and through the explicit predicate builders (worker role, no RLS).
 * The two must agree.
 */
const ADMIN = process.env.DATABASE_URL_ADMIN;
const API = process.env.DATABASE_URL ?? ADMIN?.replace('minnegela:minnegela@', 'minnegela_api:minnegela@');
const WORKER = process.env.DATABASE_URL_WORKER ?? ADMIN?.replace('minnegela:minnegela@', 'minnegela_worker:minnegela@');

describe.skipIf(!ADMIN)('presence-gated visibility', () => {
  let admin: DbHandle, api: DbHandle, worker: DbHandle, fx: Fixture;
  const ctx = (who: keyof Fixture['users'], personKnown = true): ViewerCtx => ({ groupId: fx.groupId, userId: fx.users[who].id, personId: personKnown ? fx.users[who].personId : null });

  beforeAll(async () => {
    await migrate(ADMIN!, { log: () => {} });
    admin = createDb(ADMIN!, { max: 2 }); api = createDb(API!, { max: 2 }); worker = createDb(WORKER!, { max: 2 });
    fx = await seedFixture(admin.db, { groupName: `test-${Date.now()}` });
  });
  afterAll(async () => {
    if (admin) { await admin.db.delete(s.groups).where(sql`id = ${fx.groupId}`); await admin.db.execute(sql`delete from users where id = any(${sql.raw(`array[${fx.userIds.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`); }
    await Promise.all([admin?.close(), api?.close(), worker?.close()]);
  });

  const expected: Record<keyof Fixture['events'], Array<keyof Fixture['users']>> = {
    sharedContrib: ['mikkel', 'emma'],
    faceParticipant: ['mikkel', 'jonas'],
    tagParticipant: ['emma', 'sander'],
    opened: ['mikkel', 'emma', 'jonas', 'sander'],
    solo: ['sander'],
  };

  async function eventsViaRls(who: keyof Fixture['users']) {
    return withViewer(api.db, ctx(who), async (tx) => (await tx.select({ id: s.events.id }).from(s.events)).map((r) => r.id));
  }
  async function eventsViaPredicate(who: keyof Fixture['users']) {
    return (await worker.db.select({ id: s.events.id }).from(s.events).where(visibleEventsWhere(ctx(who)))).map((r) => r.id);
  }

  for (const who of ['mikkel', 'emma', 'jonas', 'sander'] as const) {
    it(`${who} sees exactly the events they were part of (RLS and predicate agree)`, async () => {
      const want = (Object.keys(expected) as Array<keyof Fixture['events']>).filter((e) => expected[e].includes(who)).map((e) => fx.events[e]).sort();
      expect((await eventsViaRls(who)).sort()).toEqual(want);
      expect((await eventsViaPredicate(who)).sort()).toEqual(want);
    });
  }

  it('the triggers fed person_ids and contributor_ids', async () => {
    const [ev] = await worker.db.select().from(s.events).where(sql`id = ${fx.events.faceParticipant}`);
    expect(ev!.personIds).toEqual([fx.users.jonas.personId]);       // emma is only tier low
    expect(ev!.contributorIds).toEqual([fx.users.mikkel.id]);
    expect(ev!.nAssets).toBe(4);
    const [tagged] = await worker.db.select().from(s.events).where(sql`id = ${fx.events.tagParticipant}`);
    expect(tagged!.personIds).toEqual([fx.users.sander.personId]);
    const [shared] = await worker.db.select().from(s.events).where(sql`id = ${fx.events.sharedContrib}`);
    expect(shared!.contributorIds.sort()).toEqual([fx.users.mikkel.id, fx.users.emma.id].sort());
  });

  it('a member without an enrolled person still sees contributions and opened events', async () => {
    const ids = await withViewer(api.db, ctx('jonas', false), async (tx) => (await tx.select({ id: s.events.id }).from(s.events)).map((r) => r.id));
    expect(ids.sort()).toEqual([fx.events.opened].sort());   // faceParticipant needs the person link
  });

  it('assets follow their events; utility media stays with its owner', async () => {
    const mikkel = await withViewer(api.db, ctx('mikkel'), async (tx) => (await tx.select({ id: s.assets.id }).from(s.assets)).map((r) => r.id));
    expect(mikkel).toContain(fx.utilityAssetId);
    for (const a of fx.assetsByEvent[fx.events.sharedContrib]!) expect(mikkel).toContain(a);   // emma's photos from the shared night
    for (const a of fx.assetsByEvent[fx.events.solo]!) expect(mikkel).not.toContain(a);
    for (const a of fx.assetsByEvent[fx.events.tagParticipant]!) expect(mikkel).not.toContain(a);
    const sander = await withViewer(api.db, ctx('sander'), async (tx) => (await tx.select({ id: s.assets.id }).from(s.assets)).map((r) => r.id));
    expect(sander).not.toContain(fx.utilityAssetId);
    for (const a of fx.assetsByEvent[fx.events.tagParticipant]!) expect(sander).toContain(a);
    const viaPredicate = (await worker.db.select({ id: s.assets.id }).from(s.assets).where(visibleAssetsWhere(ctx('sander')))).map((r) => r.id);
    expect(viaPredicate.sort()).toEqual(sander.sort());
  });

  it('confirming a face flips visibility in the same transaction', async () => {
    expect(await eventsViaRls('emma')).not.toContain(fx.events.faceParticipant);
    await worker.db.update(s.faces).set({ tier: 'confirmed', matchSource: 'label' }).where(sql`person_id = ${fx.users.emma.personId}`);
    expect(await eventsViaRls('emma')).toContain(fx.events.faceParticipant);
    const assetIds = fx.assetsByEvent[fx.events.faceParticipant]!;
    const [asset] = await worker.db.select().from(s.assets).where(sql`id = ${assetIds[2]}`);
    expect(asset!.personIds).toEqual([fx.users.emma.personId]);
  });

  it('the api role cannot read the ml schema', async () => {
    await expect(api.sql`select count(*) from ml.face_embeddings`).rejects.toThrow(/permission denied/);
  });

  it('a query outside withViewer returns nothing, not everything', async () => {
    const rows = await api.db.select({ id: s.events.id }).from(s.events);
    expect(rows).toEqual([]);
  });

  it('jobs: enqueue with dedupe merges windows, claim locks, fail backs off', async () => {
    await enqueue(worker.db, 'recluster', { groupId: fx.groupId, from: '2026-03-14T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' }, { runAfterSeconds: 0 });
    await enqueue(worker.db, 'recluster', { groupId: fx.groupId, from: '2026-03-10T00:00:00.000Z', to: '2026-03-12T00:00:00.000Z' }, { runAfterSeconds: 0 });
    const pending = await worker.db.select().from(s.jobs).where(sql`dedupe_key = ${'recluster:' + fx.groupId} and done_at is null`);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({ from: '2026-03-10T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' });
    const claimed = await claimJobs(worker.db, ['recluster'], 'test-worker', 10);
    expect(claimed.map((j) => j.id)).toContain(pending[0]!.id);
    const again = await claimJobs(worker.db, ['recluster'], 'other-worker', 10);
    expect(again.map((j) => j.id)).not.toContain(pending[0]!.id);
    await failJob(worker.db, pending[0]!.id, new Error('boom'));
    const [after] = await worker.db.select().from(s.jobs).where(sql`id = ${pending[0]!.id}`);
    expect(after!.lockedBy).toBeNull(); expect(after!.error).toMatch(/boom/); expect(after!.doneAt).toBeNull();
    await completeJob(worker.db, pending[0]!.id);
    await worker.db.delete(s.jobs).where(sql`id = ${pending[0]!.id}`);
  });
});

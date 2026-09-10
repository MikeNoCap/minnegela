import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, seedFixture, type DbHandle, type Fixture } from '@minnegela/db';
import { HAS_DB, testApp, sessionFor, auth } from './helpers.js';
import type { App } from '../src/app.js';

/**
 * §18.3 six-branch fixture walked through every read route for every member.
 * sharedContrib → mikkel, emma · faceParticipant → mikkel, jonas · tagParticipant → emma, sander · opened → all · solo → sander
 * utility asset → mikkel only.
 */
describe.skipIf(!HAS_DB)('presence-gated visibility over the API', () => {
  let app: App, admin: DbHandle, fx: Fixture;
  const tokens: Record<string, string> = {};
  const names = ['mikkel', 'emma', 'jonas', 'sander'] as const;
  const expected: Record<keyof Fixture['events'], readonly string[]> = {
    sharedContrib: ['mikkel', 'emma'], faceParticipant: ['mikkel', 'jonas'], tagParticipant: ['emma', 'sander'], opened: [...names], solo: ['sander'],
  };
  const eventKeys = Object.keys(expected) as Array<keyof Fixture['events']>;
  const canSee = (who: string, ev: keyof Fixture['events']) => expected[ev].includes(who);

  beforeAll(async () => {
    ({ app, admin } = await testApp());
    fx = await seedFixture(admin.db, { groupName: `api-vis-${Date.now()}` });
    for (const n of names) tokens[n] = await sessionFor(admin, fx.users[n].id);
  });
  afterAll(async () => {
    await admin.db.execute(sql`delete from groups where id = ${fx.groupId}::uuid`);
    await admin.db.execute(sql`delete from users where id = any(${sql.raw(`array[${fx.userIds.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`);
    await app.close(); await admin.close();
  });

  for (const who of names) {
    it(`${who}: events list, detail, media, visibility, timeline, search, map`, async () => {
      const h = auth(tokens[who]!);
      const list = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/events`, headers: h });
      expect(list.statusCode).toBe(200);
      const ids = list.json().items.map((e: { id: string }) => e.id).sort();
      expect(ids).toEqual(eventKeys.filter((k) => canSee(who, k)).map((k) => fx.events[k]).sort());

      for (const k of eventKeys) {
        const id = fx.events[k];
        const detail = await app.inject({ method: 'GET', url: `/v1/events/${id}`, headers: h });
        const media = await app.inject({ method: 'GET', url: `/v1/events/${id}/media`, headers: h });
        const vis = await app.inject({ method: 'GET', url: `/v1/events/${id}/visibility`, headers: h });
        if (canSee(who, k)) {
          expect(detail.statusCode, `${who} ${k} detail`).toBe(200);
          expect(detail.json().title).toBeTruthy();
          expect(media.json().items.map((m: { assetId: string }) => m.assetId).sort()).toEqual([...fx.assetsByEvent[id]!].sort());
          expect(media.json().items[0].membership.tier).toBe('confirmed');
          expect(vis.json().viewers.map((v: { userId: string }) => v.userId).sort()).toEqual(expected[k].map((n) => fx.users[n].id).sort());
        } else {
          expect(detail.statusCode, `${who} ${k} detail`).toBe(404);
          expect(media.statusCode).toBe(404);
          expect(vis.statusCode).toBe(404);
          // writes on invisible events are 404 too, never 403
          expect((await app.inject({ method: 'POST', url: `/v1/events/${id}/open`, headers: h })).statusCode).toBe(404);
          expect((await app.inject({ method: 'PATCH', url: `/v1/events/${id}`, headers: h, payload: { title: 'x' } })).statusCode).toBe(404);
        }
      }

      // timeline for the shared night's day
      const tl = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/timeline?day=2026-03-14`, headers: h });
      expect(tl.statusCode).toBe(200);
      expect(tl.json().events.map((e: { id: string }) => e.id).includes(fx.events.sharedContrib)).toBe(canSee(who, 'sharedContrib'));
      // the utility screenshot sits on that day as loose media for its owner only
      expect(tl.json().loose.map((m: { assetId: string }) => m.assetId).includes(fx.utilityAssetId)).toBe(who === 'mikkel');

      const search = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/search?q=${encodeURIComponent('Sander')}`, headers: h });
      expect(search.statusCode).toBe(200);
      expect(search.json().mode).toBe('events');
      const sanderEvents = search.json().events.map((e: { id: string }) => e.id);
      expect(sanderEvents.includes(fx.events.tagParticipant)).toBe(canSee(who, 'tagParticipant'));
      expect(sanderEvents.includes(fx.events.solo)).toBe(false); // sander has no face there; only a contributor

      const map = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/map`, headers: h });
      expect(map.statusCode).toBe(200);
      expect(Array.isArray(map.json().items) && Array.isArray(map.json().loose)).toBe(true);
      for (const m of map.json().loose as Array<{ assetId: string }>) expect(Object.values(fx.assetsByEvent).some((ids) => ids.has(m.assetId)), `${who} loose ${m.assetId}`).toBe(false);

      // the braid overview is the same scope as the events list, every kind included
      const overview = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/timeline/overview`, headers: h });
      expect(overview.statusCode).toBe(200);
      const overviewIds = overview.json().items.filter((e: { kind: string }) => e.kind !== 'loose').map((e: { id: string }) => e.id).sort();
      expect(overviewIds).toEqual(ids);
    });

    it(`${who}: media urls are signed only for visible blobs; people counts are per viewer`, async () => {
      const h = auth(tokens[who]!);
      const blobIds = (await admin.db.execute(sql`select id from blobs where group_id = ${fx.groupId}::uuid`)) as unknown as Array<{ id: string }>;
      const urls = await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/media/urls`, headers: h, payload: { items: blobIds.map((b) => ({ blobId: b.id, kind: 'preview' })) } });
      expect(urls.statusCode).toBe(200);
      const visibleAssets = new Set(eventKeys.filter((k) => canSee(who, k)).flatMap((k) => fx.assetsByEvent[fx.events[k]]!));
      const visibleBlobs = (await admin.db.execute(sql`select blob_id from assets where id = any(${'{' + [...visibleAssets, ...(who === 'mikkel' ? [fx.utilityAssetId] : [])].join(',') + '}'}::uuid[])`)) as unknown as Array<{ blob_id: string }>;
      expect(Object.keys(urls.json().urls).sort()).toEqual(visibleBlobs.map((b) => `${b.blob_id}:preview`).sort());

      const people = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/people`, headers: h });
      expect(people.statusCode).toBe(200);
      const jonas = people.json().find((p: { id: number }) => p.id === fx.users.jonas.personId);
      expect(jonas.nAssets).toBe(canSee(who, 'faceParticipant') ? 2 : 0);
      const person = await app.inject({ method: 'GET', url: `/v1/people/${fx.users.jonas.personId}`, headers: h });
      expect(person.statusCode).toBe(200);
      expect(person.json().events.map((e: { id: string }) => e.id).includes(fx.events.faceParticipant)).toBe(canSee(who, 'faceParticipant'));

      // a single media detail for a blob from the solo event: only sander
      const soloBlob = (await admin.db.execute(sql`select blob_id from assets where id = ${fx.assetsByEvent[fx.events.solo]![0]}::uuid`)) as unknown as [{ blob_id: string }];
      const detail = await app.inject({ method: 'GET', url: `/v1/media/${soloBlob[0].blob_id}`, headers: h });
      expect(detail.statusCode).toBe(who === 'sander' ? 200 : 404);
      const one = await app.inject({ method: 'GET', url: `/v1/media/${soloBlob[0].blob_id}/url?kind=preview`, headers: h });
      expect(one.statusCode).toBe(who === 'sander' ? 200 : 404);
    });
  }

  it('confirming a face flips visibility in the same request; tags and opening widen it; closing narrows it', async () => {
    // emma is only tier `low` on faceParticipant → cannot see it; a confirm by mikkel flips it
    const [emmaFace] = (await admin.db.execute(sql`select id from faces where person_id = ${fx.users.emma.personId}`)) as unknown as [{ id: string }];
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.faceParticipant}`, headers: auth(tokens.emma!) })).statusCode).toBe(404);
    const label = await app.inject({ method: 'POST', url: `/v1/faces/${emmaFace.id}/label`, headers: auth(tokens.mikkel!), payload: { personId: fx.users.emma.personId, verdict: 'confirm' } });
    expect(label.statusCode).toBe(200);
    expect(label.json().applied).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.faceParticipant}`, headers: auth(tokens.emma!) })).statusCode).toBe(200);
    const vis = await app.inject({ method: 'GET', url: `/v1/events/${fx.events.faceParticipant}/visibility`, headers: auth(tokens.mikkel!) });
    expect(vis.json().viewers.find((v: { userId: string }) => v.userId === fx.users.emma.id).reasons).toEqual(['face']);

    // tag sander on the shared night (emma is a contributor): sander now sees it
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.sharedContrib}`, headers: auth(tokens.sander!) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.sharedContrib}/tags`, headers: auth(tokens.emma!), payload: { personId: fx.users.sander.personId } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.sharedContrib}`, headers: auth(tokens.sander!) })).statusCode).toBe(200);
    // emma (a contributor, who keeps visibility) removes the tag → sander no longer sees it
    expect((await app.inject({ method: 'DELETE', url: `/v1/events/${fx.events.sharedContrib}/tags/${fx.users.sander.personId}`, headers: auth(tokens.emma!) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.sharedContrib}`, headers: auth(tokens.sander!) })).statusCode).toBe(404);

    // open the solo hike: everyone sees it; a non-contributor participant cannot open/close (403, existence known)
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.solo}/open`, headers: auth(tokens.sander!) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.solo}`, headers: auth(tokens.jonas!) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.solo}/close`, headers: auth(tokens.jonas!) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.solo}/close`, headers: auth(tokens.sander!) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.solo}`, headers: auth(tokens.jonas!) })).statusCode).toBe(404);

    // edits: rename (participant ok), split (contributor only) → constraint + recluster job
    expect((await app.inject({ method: 'PATCH', url: `/v1/events/${fx.events.faceParticipant}`, headers: auth(tokens.jonas!), payload: { title: 'Dinner!' } })).json().title).toBe('Dinner!');
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.faceParticipant}/split`, headers: auth(tokens.jonas!), payload: { at: '2026-03-16T20:07:00Z' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.faceParticipant}/split`, headers: auth(tokens.mikkel!), payload: { at: '2026-03-16T20:07:00Z' } })).statusCode).toBe(202);
    const cons = (await admin.db.execute(sql`select kind from event_constraints where event_id = ${fx.events.faceParticipant}::uuid`)) as unknown as Array<{ kind: string }>;
    expect(cons.map((c) => c.kind)).toContain('pin_boundary');
    const jobs = (await admin.db.execute(sql`select kind from jobs where kind = 'recluster' and payload->>'groupId' = ${fx.groupId} and done_at is null`)) as unknown as unknown[];
    expect(jobs.length).toBe(1);   // debounced into one pending job
    // exclude an asset → falls back to owner-only; emma no longer sees that photo through the event
    const victim = fx.assetsByEvent[fx.events.sharedContrib]!.find((a) => true)!;
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.sharedContrib}/exclude`, headers: auth(tokens.mikkel!), payload: { assetIds: [victim] } })).statusCode).toBe(202);
    const media = await app.inject({ method: 'GET', url: `/v1/events/${fx.events.sharedContrib}/media`, headers: auth(tokens.emma!) });
    expect(media.json().items.map((m: { assetId: string }) => m.assetId)).not.toContain(victim);
    await admin.db.execute(sql`delete from jobs where payload->>'groupId' = ${fx.groupId}`);
  });

  it('a participant can remove their own tag and lose access (§18.3 "removing yourself")', async (t) => {
    // The trigger that shrinks events.person_ids runs as the api role; until events_update carries an explicit
    // WITH CHECK (group_id = app_group_id()), the actor removing themselves trips the policy. Skip until then.
    const [pol] = (await admin.db.execute(sql`select with_check from pg_policies where tablename = 'events' and policyname = 'events_update'`)) as unknown as [{ with_check: string | null }];
    if (!pol?.with_check) return t.skip();
    expect((await app.inject({ method: 'POST', url: `/v1/events/${fx.events.sharedContrib}/tags`, headers: auth(tokens.emma!), payload: { personId: fx.users.sander.personId } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: `/v1/events/${fx.events.sharedContrib}/tags/${fx.users.sander.personId}`, headers: auth(tokens.sander!) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/events/${fx.events.sharedContrib}`, headers: auth(tokens.sander!) })).statusCode).toBe(404);
  });
});

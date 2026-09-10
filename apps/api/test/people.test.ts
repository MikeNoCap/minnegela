import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, seedFixture, type DbHandle, type Fixture } from '@minnegela/db';
import { HAS_DB, testApp, sessionFor, auth } from './helpers.js';
import type { App } from '../src/app.js';

/**
 * Naming faces must never mint a second profile for someone who already exists: a known name attaches,
 * a handled cluster refuses, and duplicates that slipped through can be merged away.
 */
describe.skipIf(!HAS_DB)('people: naming, cluster assignment, merging', () => {
  let app: App, admin: DbHandle, fx: Fixture, mikkel: string;
  beforeAll(async () => {
    ({ app, admin } = await testApp());
    fx = await seedFixture(admin.db, { groupName: `api-people-${Date.now()}` });
    mikkel = await sessionFor(admin, fx.users.mikkel.id);
  });
  afterAll(async () => {
    await admin.db.execute(sql`delete from groups where id = ${fx.groupId}::uuid`);
    await admin.db.execute(sql`delete from users where id = any(${sql.raw(`array[${fx.userIds.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`);
    await app.close(); await admin.close();
  });

  async function unnamedCluster(): Promise<{ id: string; faceIds: string[] }> {
    const blobs = (await admin.db.execute(sql`select b.id from blobs b join assets a on a.blob_id = b.id
      where a.owner_user_id = ${fx.users.mikkel.id}::uuid and b.group_id = ${fx.groupId}::uuid order by b.captured_at limit 2`)) as unknown as Array<{ id: string }>;
    expect(blobs).toHaveLength(2);
    const faces = (await admin.db.execute(sql`insert into faces (group_id, blob_id, box, det_score)
      select ${fx.groupId}::uuid, b, '{"x":0,"y":0,"w":50,"h":50}'::jsonb, 0.9 from unnest(${sql.raw(`array['${blobs[0]!.id}','${blobs[1]!.id}']::uuid[]`)}) as b returning id`)) as unknown as Array<{ id: string }>;
    const faceIds = faces.map((f) => f.id);
    const [uc] = (await admin.db.execute(sql`insert into unknown_clusters (group_id, face_ids, cover_face_id, n)
      values (${fx.groupId}::uuid, ${sql.raw(`array['${faceIds.join("','")}']::uuid[]`)}, ${faceIds[0]}::uuid, 2) returning id`)) as unknown as [{ id: string }];
    return { id: uc.id, faceIds };
  }
  const listed = async (clusterId: string) => {
    const r = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/review`, headers: auth(mikkel) });
    expect(r.statusCode).toBe(200);
    return r.json().unnamedClusters.some((c: { id: string }) => c.id === clusterId);
  };

  it('a known name attaches to that person; a handled cluster refuses; twins need an explicit choice and can be merged', async () => {
    const h = auth(mikkel);
    const c = await unnamedCluster();
    expect(await listed(c.id)).toBe(true);

    // "jonas" is already in the group (case and whitespace do not matter): no second Jonas, the cluster stays open.
    const dup = await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/people`, headers: h, payload: { name: ' jonas ', clusterId: c.id } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('person_name_exists');
    expect(dup.json().existingPersonId).toBe(fx.users.jonas.personId);
    expect(await listed(c.id)).toBe(true);

    // "This is Jonas": every face confirmed in one call, cluster gone from the queue.
    const assign = await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/review/clusters/${c.id}/assign`, headers: h, payload: { personId: fx.users.jonas.personId } });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().faces).toEqual({ labelled: 2, applied: 2 });
    const moved = (await admin.db.execute(sql`select person_id, tier from faces where id = any(${sql.raw(`array['${c.faceIds.join("','")}']::uuid[]`)})`)) as unknown as Array<{ person_id: number; tier: string }>;
    expect(moved.map((f) => [f.person_id, f.tier])).toEqual([[fx.users.jonas.personId, 'confirmed'], [fx.users.jonas.personId, 'confirmed']]);
    expect(await listed(c.id)).toBe(false);

    // A stale card (still on screen after the answer) cannot act on the same cluster twice, and no person is created by the failed attempt.
    const stale = await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/people`, headers: h, payload: { name: 'Someone new', clusterId: c.id } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('cluster_already_handled');
    expect((await admin.db.execute(sql`select 1 from persons where group_id = ${fx.groupId}::uuid and name = 'Someone new'`)).length).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/review/clusters/${c.id}/assign`, headers: h, payload: { personId: fx.users.jonas.personId } })).statusCode).toBe(409);

    // Two people really called Jonas: allowed when asked for explicitly; renaming onto a taken name is refused.
    const twin = await app.inject({ method: 'POST', url: `/v1/groups/${fx.groupId}/people`, headers: h, payload: { name: 'Jonas', allowDuplicate: true } });
    expect(twin.statusCode).toBe(201);
    const twinId = twin.json().id as number;
    const rename = await app.inject({ method: 'PATCH', url: `/v1/people/${twinId}`, headers: h, payload: { name: 'EMMA' } });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().existingPersonId).toBe(fx.users.emma.personId);

    // Merge the twin away into the member-linked Jonas.
    const merged = await app.inject({ method: 'PATCH', url: `/v1/people/${twinId}`, headers: h, payload: { mergeInto: fx.users.jonas.personId } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ id: fx.users.jonas.personId, mergedFrom: twinId });
    const people = await app.inject({ method: 'GET', url: `/v1/groups/${fx.groupId}/people`, headers: h });
    expect(people.json().filter((p: { name: string }) => p.name === 'Jonas')).toHaveLength(1);
  });
});

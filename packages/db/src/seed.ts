import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import * as s from './schema/index.js';

/**
 * The six-branch visibility fixture from §18.3, used by the visibility test suite and `pnpm db:seed`.
 * Members: mikkel (owner), emma, jonas, sander. Events:
 *   sharedContrib   mikkel + emma contributed, no faces            → mikkel, emma
 *   faceParticipant mikkel's photos; jonas recognized (high),
 *                   emma only at tier low                          → mikkel, jonas
 *   tagParticipant  emma's photos; sander tagged by emma           → emma, sander
 *   opened          jonas's photos, is_public_to_group             → everyone
 *   solo            sander alone, no faces                         → sander
 *   utility         mikkel's screenshot; no event                  → asset visible to mikkel only
 * Must run with a connection that bypasses RLS (admin or worker role).
 */
export type Fixture = {
  groupId: string;
  /** Every user row this fixture created; delete these (not by email pattern) when cleaning up. */
  userIds: string[];
  users: Record<'mikkel' | 'emma' | 'jonas' | 'sander', { id: string; personId: number; deviceId: string }>;
  events: Record<'sharedContrib' | 'faceParticipant' | 'tagParticipant' | 'opened' | 'solo', string>;
  utilityAssetId: string;
  assetsByEvent: Record<string, string[]>;
};

export async function seedFixture(db: Db, opts: { groupName?: string } = {}): Promise<Fixture> {
  const names = ['mikkel', 'emma', 'jonas', 'sander'] as const;
  // Unique emails per seed so concurrent test suites never share or delete each other's users.
  const tag = `${(opts.groupName ?? 'fixture').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const userRows = await db.insert(s.users).values(names.map((n) => ({ email: `${n}.${tag}@fixture.local`, displayName: n[0]!.toUpperCase() + n.slice(1), emailVerified: true }))).returning();
  const uid = Object.fromEntries(userRows.map((u) => [u.email.split('.')[0]!, u.id])) as Record<typeof names[number], string>;

  const [group] = await db.insert(s.groups).values({ name: opts.groupName ?? 'Fixture group', createdBy: uid.mikkel }).returning();
  const groupId = group!.id;
  await db.insert(s.groupMembers).values(names.map((n) => ({ groupId, userId: uid[n], role: (n === 'mikkel' ? 'owner' : 'member') as 'owner' | 'member', consentFacesAt: new Date() })));
  const personRows = await db.insert(s.persons).values(names.map((n) => ({ groupId, userId: uid[n], name: n[0]!.toUpperCase() + n.slice(1) }))).returning();
  const pid = Object.fromEntries(personRows.map((p) => [p.name!.toLowerCase(), p.id])) as Record<typeof names[number], number>;
  const deviceRows = await db.insert(s.devices).values(names.map((n) => ({ userId: uid[n], platform: 'cli' as const, name: `${n}-fixture` }))).returning();
  const did = Object.fromEntries(deviceRows.map((d) => [d.name.split('-')[0]!, d.id])) as Record<typeof names[number], string>;

  let counter = 0;
  const t0 = Date.parse('2026-03-14T20:00:00Z');
  async function addAssets(owner: typeof names[number], n: number, startMs: number, extra: Partial<typeof s.blobs.$inferInsert> = {}) {
    const ids: { assetId: string; blobId: string }[] = [];
    for (let i = 0; i < n; i++) {
      counter++;
      const capturedAt = new Date(startMs + i * 5 * 60_000);
      const [blob] = await db.insert(s.blobs).values({ groupId, mime: 'image/jpeg', width: 1600, height: 1200, capturedAt, sha256: Buffer.from(String(counter).padStart(64, '0'), 'hex'), sizeBytes: 1000, previewKey: `groups/${groupId}/prev/fixture${counter}.jpg`, derivedAt: new Date(), analyzedAt: new Date(), ...extra }).returning();
      const [asset] = await db.insert(s.assets).values({ groupId, blobId: blob!.id, ownerUserId: uid[owner], deviceId: did[owner], localId: `fixture-${counter}`, localCreatedAt: capturedAt, filename: `IMG_${counter}.jpg` }).returning();
      ids.push({ assetId: asset!.id, blobId: blob!.id });
    }
    return ids;
  }
  async function addEvent(name: string, members: { assetId: string; blobId: string }[], startMs: number, extra: Partial<typeof s.events.$inferInsert> = {}) {
    const [ev] = await db.insert(s.events).values({ groupId, titleAuto: { nb: name, en: name }, startAt: new Date(startMs), endAt: new Date(startMs + members.length * 5 * 60_000), confidence: 0.9, ...extra }).returning();
    await db.insert(s.eventAssets).values(members.map((m) => ({ eventId: ev!.id, assetId: m.assetId, blobId: m.blobId, confidence: 0.9, tier: 'confirmed' as const, source: 'auto' as const })));
    return ev!.id;
  }

  const assetsByEvent: Record<string, string[]> = {};

  // sharedContrib
  const a1 = [...(await addAssets('mikkel', 3, t0)), ...(await addAssets('emma', 3, t0 + 60_000))];
  const sharedContrib = await addEvent('Shared night', a1, t0);
  assetsByEvent[sharedContrib] = a1.map((a) => a.assetId);

  // faceParticipant: mikkel's photos with jonas (high) and emma (low)
  const t1 = t0 + 2 * 24 * 3600_000;
  const a2 = await addAssets('mikkel', 4, t1);
  const faceParticipant = await addEvent('Dinner with Jonas', a2, t1);
  assetsByEvent[faceParticipant] = a2.map((a) => a.assetId);
  await db.insert(s.faces).values([
    { groupId, blobId: a2[0]!.blobId, box: { x: 10, y: 10, w: 100, h: 100 }, detScore: 0.95, personId: pid.jonas, matchScore: 0.71, tier: 'high', matchSource: 'auto' },
    { groupId, blobId: a2[1]!.blobId, box: { x: 10, y: 10, w: 100, h: 100 }, detScore: 0.9, personId: pid.jonas, matchScore: 0.66, tier: 'high', matchSource: 'auto' },
    { groupId, blobId: a2[2]!.blobId, box: { x: 10, y: 10, w: 40, h: 40 }, detScore: 0.7, personId: pid.emma, matchScore: 0.44, tier: 'low', matchSource: 'auto', qualityFlags: ['too_small'] },
  ]);

  // tagParticipant: emma's photos; sander tagged
  const t2 = t0 + 4 * 24 * 3600_000;
  const a3 = await addAssets('emma', 3, t2);
  const tagParticipant = await addEvent('Cabin weekend', a3, t2);
  assetsByEvent[tagParticipant] = a3.map((a) => a.assetId);
  await db.insert(s.eventPersonTags).values({ eventId: tagParticipant, personId: pid.sander, byUserId: uid.emma });

  // opened: jonas's photos, opened to the group
  const t3 = t0 + 6 * 24 * 3600_000;
  const a4 = await addAssets('jonas', 5, t3);
  const opened = await addEvent('Copenhagen trip', a4, t3, { isPublicToGroup: true, openedByUserId: uid.jonas, openedAt: new Date() });
  assetsByEvent[opened] = a4.map((a) => a.assetId);

  // solo: sander alone
  const t4 = t0 + 8 * 24 * 3600_000;
  const a5 = await addAssets('sander', 3, t4);
  const solo = await addEvent('Sunday hike', a5, t4);
  assetsByEvent[solo] = a5.map((a) => a.assetId);

  // utility: mikkel's screenshot, never in an event
  const [util] = await addAssets('mikkel', 1, t0 + 3600_000, { isUtility: true, mime: 'image/png', tags: [{ tag: 'a screenshot', score: 0.41 }] });

  return {
    groupId,
    userIds: userRows.map((u) => u.id),
    users: Object.fromEntries(names.map((n) => [n, { id: uid[n], personId: pid[n], deviceId: did[n] }])) as Fixture['users'],
    events: { sharedContrib, faceParticipant, tagParticipant, opened, solo },
    utilityAssetId: util!.assetId,
    assetsByEvent,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL_WORKER;
  if (!url) { console.error('DATABASE_URL_ADMIN required'); process.exit(1); }
  const h = createDb(url, { max: 2, name: 'seed' });
  seedFixture(h.db, { groupName: 'Dev group' })
    .then((f) => { console.log(JSON.stringify({ groupId: f.groupId, users: f.users, events: f.events }, null, 2)); return h.close(); })
    .catch((e) => { console.error(e); process.exit(1); });
}

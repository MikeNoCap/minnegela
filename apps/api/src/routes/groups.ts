import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, queueDepths, groups, groupMembers, groupInvites, persons, devices, users, sql, RegisterDeviceRequest } from '../deps.js';
import { setViewer } from '../plugins/viewer.js';
import { audit } from '../audit.js';
import { forbidden, badRequest, notFound } from '../errors.js';
import { rows, iso } from '../dto.js';

const G = z.object({ g: z.string().uuid() });

export async function groupRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/v1/groups', { schema: { body: z.object({ name: z.string().min(1).max(100) }) } }, async (req, reply) => {
    const user = req.requireUser();
    const out = await withViewer(ctx.db, { groupId: '', userId: user.id, personId: null }, async (tx) => {
      // RETURNING would apply the select policy, which needs membership that does not exist yet: pick the id here.
      const id = randomUUID();
      await tx.insert(groups).values({ id, name: req.body.name, createdBy: user.id });
      await tx.insert(groupMembers).values({ groupId: id, userId: user.id, role: 'owner' });
      await setViewer(tx, { groupId: id, userId: user.id, personId: null });
      const [p] = await tx.insert(persons).values({ groupId: id, userId: user.id, name: user.displayName || user.email.split('@')[0]! }).returning();
      await audit(tx, { groupId: id, userId: user.id }, 'group.create', { type: 'group', id }, { name: req.body.name }, req);
      return { id, name: req.body.name, role: 'owner' as const, personId: p!.id };
    });
    return reply.status(201).send(out);
  });

  r.get('/v1/groups/:g', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const [g] = await tx.select().from(groups).where(sql`${groups.id} = ${v.groupId}::uuid`);
      if (!g) throw notFound('Group not found');
      const [{ n }] = (await tx.execute(sql`select count(*)::int as n from group_members where group_id = ${v.groupId}::uuid`)) as unknown as [{ n: number }];
      return { id: g.id, name: g.name, settings: g.settings, createdAt: g.createdAt.toISOString(), role: v.role, personId: v.personId, nMembers: n };
    });
  });

  r.patch('/v1/groups/:g', { schema: { params: G, body: z.object({ name: z.string().min(1).max(100).optional(), settings: z.object({ cluster_unknown_faces: z.boolean().optional() }).optional() }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('Owner only');
    return withViewer(ctx.db, v, async (tx) => {
      const [g] = await tx.update(groups).set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.settings ? { settings: sql`settings || ${JSON.stringify(req.body.settings)}::jsonb` } : {}) }).where(sql`${groups.id} = ${v.groupId}::uuid`).returning();
      await audit(tx, v, 'group.update', { type: 'group', id: v.groupId }, req.body, req);
      return { id: g!.id, name: g!.name, settings: g!.settings };
    });
  });

  r.post('/v1/groups/:g/invites', { schema: { params: G } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('Owner only');
    const code = randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
    await withViewer(ctx.db, v, async (tx) => {
      await tx.insert(groupInvites).values({ code, groupId: v.groupId, createdBy: v.userId, expiresAt });
      await audit(tx, v, 'invite.create', { type: 'invite', id: code }, null, req);
    });
    return reply.status(201).send({ code, expiresAt: expiresAt.toISOString() });
  });

  r.delete('/v1/groups/:g/invites/:code', { schema: { params: G.extend({ code: z.string() }) } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('Owner only');
    await withViewer(ctx.db, v, (tx) => tx.update(groupInvites).set({ revokedAt: new Date() }).where(sql`${groupInvites.code} = ${req.params.code} and ${groupInvites.groupId} = ${v.groupId}::uuid`));
    return reply.status(204).send();
  });

  r.post('/v1/invites/:code/accept', { schema: { params: z.object({ code: z.string() }) } }, async (req) => {
    const user = req.requireUser();
    return withViewer(ctx.db, { groupId: '', userId: user.id, personId: null }, async (tx) => {
      let groupId: string;
      try {
        const [row] = (await tx.execute(sql`select app_accept_invite(${req.params.code}) as gid`)) as unknown as [{ gid: string }];
        groupId = row.gid;
      } catch (e) {
        if (String((e as Error).message).includes('invalid_invite') || String((e as { cause?: { message?: string } }).cause?.message).includes('invalid_invite')) throw badRequest('Invite is invalid, used or expired');
        throw e;
      }
      await setViewer(tx, { groupId, userId: user.id, personId: null });
      let [p] = await tx.select({ id: persons.id }).from(persons).where(sql`${persons.groupId} = ${groupId}::uuid and ${persons.userId} = ${user.id}::uuid`);
      if (!p) [p] = await tx.insert(persons).values({ groupId, userId: user.id, name: user.displayName || user.email.split('@')[0]! }).returning({ id: persons.id });
      await audit(tx, { groupId, userId: user.id }, 'group.join', { type: 'group', id: groupId }, { code: req.params.code }, req);
      const [g] = await tx.select({ name: groups.name }).from(groups).where(sql`${groups.id} = ${groupId}::uuid`);
      return { groupId, name: g?.name ?? '', personId: p!.id };
    });
  });

  r.get('/v1/groups/:g/members', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, (tx) => rows<{ userId: string; displayName: string; email: string; role: 'owner' | 'member'; personId: number | null; consentFacesAt: string | null; joinedAt: string }>(tx, sql`
      select gm.user_id as "userId", u.display_name as "displayName", u.email, gm.role, p.id as "personId", gm.consent_faces_at as "consentFacesAt", gm.joined_at as "joinedAt"
      from group_members gm join users u on u.id = gm.user_id left join persons p on p.group_id = gm.group_id and p.user_id = gm.user_id
      where gm.group_id = ${v.groupId}::uuid order by gm.joined_at`).then((list) => list.map((m) => ({ ...m, consentFacesAt: m.consentFacesAt ? new Date(m.consentFacesAt).toISOString() : null, joinedAt: new Date(m.joinedAt).toISOString() }))));
  });

  r.patch('/v1/groups/:g/members/me', { schema: { params: G, body: z.object({ consentFaces: z.boolean() }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const [m] = await tx.update(groupMembers).set({ consentFacesAt: req.body.consentFaces ? new Date() : null }).where(sql`${groupMembers.groupId} = ${v.groupId}::uuid and ${groupMembers.userId} = ${v.userId}::uuid`).returning();
      if (!req.body.consentFaces && v.personId !== null) await enqueue(tx, 'identify', { groupId: v.groupId, personId: v.personId }); // worker drops prototypes/labels for withdrawn consent
      await audit(tx, v, req.body.consentFaces ? 'consent.faces.granted' : 'consent.faces.withdrawn', { type: 'user', id: v.userId }, null, req);
      return { consentFacesAt: m?.consentFacesAt?.toISOString() ?? null };
    });
  });

  r.delete('/v1/groups/:g/members/me', { schema: { params: G, body: z.object({ takeMedia: z.boolean().default(false) }).optional() } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    const takeMedia = req.body?.takeMedia ?? false;
    await withViewer(ctx.db, v, async (tx) => {
      if (takeMedia) {
        const mine = await rows<{ id: string }>(tx, sql`update assets set deleted_at = now() where group_id = ${v.groupId}::uuid and owner_user_id = ${v.userId}::uuid and deleted_at is null returning id`);
        for (const a of mine) await enqueue(tx, 'hard_delete', { assetId: a.id }, { runAfterSeconds: 7 * 24 * 3600 });
        await enqueue(tx, 'recluster', { groupId: v.groupId, full: true }, { runAfterSeconds: 60 });
      }
      if (v.personId !== null) {
        await tx.update(persons).set({ userId: null }).where(sql`${persons.id} = ${v.personId}`);
        await enqueue(tx, 'identify', { groupId: v.groupId, personId: v.personId });
      }
      await audit(tx, v, 'group.leave', { type: 'group', id: v.groupId }, { takeMedia }, req);
      await tx.delete(groupMembers).where(sql`${groupMembers.groupId} = ${v.groupId}::uuid and ${groupMembers.userId} = ${v.userId}::uuid`);
    });
    return reply.status(204).send();
  });

  r.get('/v1/groups/:g/devices', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, (tx) => rows(tx, sql`select d.id, d.user_id as "userId", u.display_name as "displayName", d.platform, d.name, d.clock_offset_s as "clockOffsetS", d.last_sync_at as "lastSyncAt", d.created_at as "createdAt"
      from devices d join users u on u.id = d.user_id join group_members gm on gm.user_id = d.user_id and gm.group_id = ${v.groupId}::uuid order by d.created_at`));
  });

  r.post('/v1/groups/:g/devices', { schema: { params: G, body: RegisterDeviceRequest } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    const d = await withViewer(ctx.db, v, async (tx) => {
      const [d] = await tx.insert(devices).values({ userId: v.userId, platform: req.body.platform, name: req.body.name, pushToken: req.body.pushToken ?? null }).returning();
      await audit(tx, v, 'device.register', { type: 'device', id: d!.id }, { platform: req.body.platform, name: req.body.name }, req);
      return d!;
    });
    return reply.status(201).send({ id: d.id, platform: d.platform, name: d.name, createdAt: d.createdAt.toISOString() });
  });

  r.get('/v1/groups/:g/status', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const queues = await queueDepths(tx);
      const [c] = await rows<{ assets: number; previews: number; originals: number; blobs: number; analyzed: number; events: number; bytes: string }>(tx, sql`select
          (select count(*)::int from assets where group_id = ${v.groupId}::uuid and deleted_at is null) as assets,
          (select count(*)::int from assets where group_id = ${v.groupId}::uuid and deleted_at is null and preview_uploaded_at is not null) as previews,
          (select count(*)::int from blobs where group_id = ${v.groupId}::uuid and storage_key is not null) as originals,
          (select count(*)::int from blobs where group_id = ${v.groupId}::uuid) as blobs,
          (select count(*)::int from blobs where group_id = ${v.groupId}::uuid and analyzed_at is not null) as analyzed,
          (select count(*)::int from events where group_id = ${v.groupId}::uuid and deleted_at is null and kind = 'event') as events,
          (select coalesce(sum(size_bytes),0)::bigint from blobs where group_id = ${v.groupId}::uuid) as bytes`);
      const devs = await rows<{ id: string; name: string; platform: string; ownerName: string; lastSyncAt: Date | null }>(tx, sql`select d.id, d.name, d.platform, u.display_name as "ownerName", d.last_sync_at as "lastSyncAt"
        from devices d join users u on u.id = d.user_id join group_members gm on gm.user_id = d.user_id and gm.group_id = ${v.groupId}::uuid order by d.created_at`);
      return {
        queues,
        devices: devs.map((d) => ({ ...d, lastSyncAt: iso(d.lastSyncAt) })),
        storage: { blobs: c!.blobs, bytes: Number(c!.bytes), originals: c!.originals, endpoint: ctx.cfg.S3_ENDPOINT, bucket: ctx.cfg.S3_BUCKET },
        analyzing: Math.max(0, c!.previews - c!.analyzed),
        counts: { assets: c!.assets, previews: c!.previews, analyzed: c!.analyzed, events: c!.events },
      };
    });
  });
}

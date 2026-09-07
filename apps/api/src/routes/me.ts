import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, groups, users, sql } from '../deps.js';
import { audit } from '../audit.js';

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me', async (req) => {
    const user = req.requireUser();
    const memberships = await req.memberships();
    const groupRows = memberships.length
      ? await withViewer(ctx.db, { groupId: '', userId: user.id, personId: null }, (tx) =>
          tx.select({ id: groups.id, name: groups.name }).from(groups).where(sql`${groups.id} = any(${sql.raw(`array[${memberships.map((m) => `'${m.groupId}'`).join(',')}]::uuid[]`)})`))
      : [];
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      groups: memberships.map((m) => ({ id: m.groupId, name: groupRows.find((g) => g.id === m.groupId)?.name ?? '', role: m.role, personId: m.personId, consentFacesAt: m.consentFacesAt })),
    };
  });

  /** Profile edits. Code sign-in from the phone creates the user without a name; the app sets it here. */
  r.patch('/v1/me', { schema: { body: z.object({ displayName: z.string().trim().min(1).max(80).optional(), birthday: z.string().date().nullable().optional() }) } }, async (req) => {
    const user = req.requireUser();
    const set: Partial<{ displayName: string; birthday: string | null; updatedAt: Date }> = { updatedAt: new Date() };
    if (req.body.displayName !== undefined) set.displayName = req.body.displayName;
    if (req.body.birthday !== undefined) set.birthday = req.body.birthday;
    await ctx.db.update(users).set(set).where(sql`${users.id} = ${user.id}::uuid`);
    return { id: user.id, email: user.email, displayName: set.displayName ?? user.displayName, birthday: req.body.birthday ?? null };
  });

  /** Account deletion: recorded with a 7-day grace; the hard delete is an ops job (see README). */
  r.delete('/v1/me', async (req, reply) => {
    const user = req.requireUser();
    for (const m of await req.memberships()) {
      await withViewer(ctx.db, { groupId: m.groupId, userId: user.id, personId: m.personId }, (tx) => audit(tx, { groupId: m.groupId, userId: user.id }, 'account.delete_requested', { type: 'user', id: user.id }, { graceDays: 7 }, req));
    }
    return reply.status(202).send({ status: 'scheduled', graceDays: 7 });
  });

  r.post('/v1/me/export', { schema: { body: z.object({ groupId: z.string().uuid().optional() }).optional() } }, async (req, reply) => {
    const user = req.requireUser();
    const targets = (await req.memberships()).filter((m) => !req.body?.groupId || m.groupId === req.body.groupId);
    for (const m of targets) {
      await withViewer(ctx.db, { groupId: m.groupId, userId: user.id, personId: m.personId }, async (tx) => {
        await enqueue(tx, 'export', { userId: user.id, groupId: m.groupId });
        await audit(tx, { groupId: m.groupId, userId: user.id }, 'export.requested', { type: 'user', id: user.id }, null, req);
      });
    }
    return reply.status(202).send({ status: 'queued', groups: targets.map((m) => m.groupId) });
  });
}

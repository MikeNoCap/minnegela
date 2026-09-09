import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, queueDepths, sql } from '../deps.js';
import { audit } from '../audit.js';
import { forbidden } from '../errors.js';
import { rows, intArr, bigintArr } from '../dto.js';

const G = z.object({ g: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/groups/:g/jobs', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => ({
      queues: await queueDepths(tx),
      parked: await rows(tx, sql`select id, kind, payload, attempts, error, done_at as "doneAt", created_at as "createdAt" from jobs where done_at is not null and error is not null and payload->>'groupId' = ${v.groupId} order by done_at desc limit 50`),
      running: await rows(tx, sql`select id, kind, payload, attempts, locked_by as "lockedBy", locked_at as "lockedAt" from jobs where done_at is null and locked_by is not null and payload->>'groupId' = ${v.groupId} order by locked_at limit 50`),
    }));
  });

  r.post('/v1/groups/:g/jobs/retry', { schema: { params: G, body: z.object({ jobIds: z.array(z.number().int()).max(500).optional() }).optional() } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('owner_only', 'Owner only');
    return withViewer(ctx.db, v, async (tx) => {
      const ids = req.body?.jobIds;
      const retried = await rows<{ id: number }>(tx, sql`update jobs set done_at = null, error = null, locked_by = null, locked_at = null, attempts = 0, run_after = now()
        where done_at is not null and error is not null and payload->>'groupId' = ${v.groupId} ${ids?.length ? sql`and id = any(${bigintArr(ids)})` : sql``} returning id`);
      await audit(tx, v, 'jobs.retry', null, { n: retried.length }, req);
      return { retried: retried.map((j) => Number(j.id)) };
    });
  });

  r.post('/v1/groups/:g/recluster', { schema: { params: G } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('owner_only', 'Owner only');
    await withViewer(ctx.db, v, async (tx) => {
      await enqueue(tx, 'recluster', { groupId: v.groupId, full: true }, { runAfterSeconds: 0, priority: 5 });
      await audit(tx, v, 'recluster.full', null, null, req);
    });
    return reply.status(202).send({ status: 'queued' });
  });

  r.get('/v1/groups/:g/audit', { schema: { params: G, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    if (v.role !== 'owner') throw forbidden('owner_only', 'Owner only');
    return withViewer(ctx.db, v, async (tx) => ({
      items: await rows(tx, sql`select a.id, a.user_id as "userId", u.display_name as "userName", a.action, a.target_type as "targetType", a.target_id as "targetId", a.meta, a.ip, a.at
        from audit_log a left join users u on u.id = a.user_id where a.group_id = ${v.groupId}::uuid ${req.query.before ? sql`and a.id < ${req.query.before}` : sql``} order by a.id desc limit ${req.query.limit}`),
    }));
  });
}

import { sql, type Tx, type ViewerCtx } from '@minnegela/db';
import type { FastifyRequest } from 'fastify';

/** §18.8 One row per action. Media-URL signing is logged once per batch, not per thumbnail. */
export async function audit(tx: Tx, ctx: ViewerCtx | { groupId: string | null; userId: string }, action: string, target: { type: string; id: string | null } | null, meta: Record<string, unknown> | null, req?: FastifyRequest): Promise<void> {
  const ua = req?.headers['user-agent']?.slice(0, 400) ?? null;
  const ip = req?.ip ?? null;
  await tx.execute(sql`insert into audit_log (group_id, user_id, action, target_type, target_id, meta, ip, ua)
    values (${ctx.groupId || null}::uuid, ${ctx.userId}::uuid, ${action}, ${target?.type ?? null}, ${target?.id ?? null}, ${meta ? JSON.stringify(meta) : null}::jsonb, ${ip}::inet, ${ua})`);
}

import { sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Tx } from './client.js';
import { events, assets } from './schema/index.js';

/** Who is looking. Built once per request by the API's membership middleware (§18.3). */
export type ViewerCtx = { groupId: string; userId: string; personId: number | null };

/**
 * The only way for API code to get a group-scoped transaction. Sets the per-transaction
 * settings the RLS policies read, then hands the transaction to the callback.
 */
export async function withViewer<T>(db: Db, ctx: ViewerCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.group_id', ${ctx.groupId}, true),
      set_config('app.user_id', ${ctx.userId}, true),
      set_config('app.person_id', ${ctx.personId === null ? '' : String(ctx.personId)}, true)`);
    return fn(tx);
  });
}

/**
 * The presence predicate, written out so the planner can use the GIN indexes and so the intent
 * is visible in code review. `e` lets callers apply it to an aliased events table.
 */
export function visibleEventsWhere(ctx: ViewerCtx, e: typeof events | ReturnType<typeof alias<typeof events, string>> = events): SQL {
  const personTerm = ctx.personId === null ? sql`false` : sql`${ctx.personId}::int = any(${e.personIds})`;
  return sql`(${e.groupId} = ${ctx.groupId}::uuid and ${e.deletedAt} is null and (
      ${ctx.userId}::uuid = any(${e.contributorIds})
      or ${personTerm}
      or ${e.isPublicToGroup} = true))`;
}

/** Subquery of visible event ids: `where e.id in (visibleEvents(ctx))`. */
export function visibleEventIds(ctx: ViewerCtx): SQL {
  return sql`(select ${events.id} from ${events} where ${visibleEventsWhere(ctx)})`;
}

/**
 * An asset is visible if the viewer owns it or it belongs to at least one visible event
 * (any tier, including `uncertain`).
 */
export function visibleAssetsWhere(ctx: ViewerCtx, a: typeof assets = assets): SQL {
  const e = alias(events, 'vis_e');
  return sql`(${a.groupId} = ${ctx.groupId}::uuid and ${a.deletedAt} is null and (
      ${a.ownerUserId} = ${ctx.userId}::uuid
      or exists (select 1 from event_assets vis_ea join events vis_e on ${e.id} = vis_ea.event_id
                 where vis_ea.asset_id = ${a.id} and ${visibleEventsWhere(ctx, e)})))`;
}

export function visibleAssetIds(ctx: ViewerCtx): SQL {
  return sql`(select ${assets.id} from ${assets} where ${visibleAssetsWhere(ctx)})`;
}

/** A blob is visible if any visible asset references it. */
export function visibleBlobIds(ctx: ViewerCtx): SQL {
  return sql`(select ${assets.blobId} from ${assets} where ${visibleAssetsWhere(ctx)})`;
}

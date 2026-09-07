import { sql, enqueue, groups, blobs, assets } from '@minnegela/db';
import { JobPayloads } from '@minnegela/shared';
import { eq } from '@minnegela/db';
import type { Ctx } from '../context.js';

type P = ReturnType<typeof JobPayloads.reconcile_staging.parse>;

/**
 * §13.1: R2 never calls back. Nightly, list the staging prefix: objects whose upload was completed but never
 * derived get a job; orphans older than 7 days are deleted.
 */
export async function reconcileStaging(ctx: Ctx, payload: P): Promise<void> {
  const { db, storage, log } = ctx;
  const gids = payload.groupId ? [payload.groupId] : (await db.select({ id: groups.id }).from(groups)).map((g) => g.id);
  const cutoff = Date.now() - 7 * 86400_000;
  let deleted = 0, enqueued = 0;
  for (const g of gids) {
    const objs = await storage.list(`groups/${g}/staging/`);
    for (const o of objs) {
      const m = /staging\/(preview|original)\/([0-9a-f-]{36})\./.exec(o.key);
      if (!m) continue;
      const kind = m[1] as 'preview' | 'original', assetId = m[2]!;
      const [asset] = await db.select({ blobId: assets.blobId, previewUploadedAt: assets.previewUploadedAt, originalUploadedAt: assets.originalUploadedAt }).from(assets).where(eq(assets.id, assetId));
      const completed = asset && (kind === 'preview' ? asset.previewUploadedAt : asset.originalUploadedAt);
      const pending = await db.execute(sql`select 1 from jobs where kind = 'derive' and done_at is null and payload->>'stagingKey' = ${o.key} limit 1`);
      if (completed && !(pending as unknown[]).length) {
        const [blob] = await db.select({ derivedAt: blobs.derivedAt, storageKey: blobs.storageKey }).from(blobs).where(eq(blobs.id, asset.blobId));
        const alreadyDone = blob && (kind === 'preview' ? blob.derivedAt : blob.storageKey);
        if (alreadyDone) { await storage.delete([o.key]); deleted++; continue; }
        await enqueue(db, 'derive', { blobId: asset.blobId, groupId: g, kind, stagingKey: o.key });
        enqueued++;
      } else if (!completed && o.lastModified.getTime() < cutoff) {
        await storage.delete([o.key]); deleted++;
      }
    }
  }
  log.info({ groups: gids.length, deleted, enqueued }, 'reconcile-staging: done');
}

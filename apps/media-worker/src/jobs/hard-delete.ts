import { sql, eq, and, ne, enqueue, assets, blobs, derivatives, faces, eventAssets } from '@minnegela/db';
import { JobPayloads, WBS } from '@minnegela/shared';
import type { Ctx } from '../context.js';

type P = ReturnType<typeof JobPayloads.hard_delete.parse>;

/** §18.7: after the 7-day grace, remove the asset; the blob and everything derived from it go when unreferenced. */
export async function hardDelete(ctx: Ctx, payload: P): Promise<void> {
  const { db, storage, log } = ctx;
  const [asset] = await db.select().from(assets).where(eq(assets.id, payload.assetId));
  if (!asset) return;
  if (!asset.deletedAt) { log.warn({ assetId: asset.id }, 'hard-delete: asset is not soft-deleted, skipping'); return; }
  const [blob] = await db.select().from(blobs).where(eq(blobs.id, asset.blobId));
  const others = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.blobId, asset.blobId), ne(assets.id, asset.id)));
  const t = blob?.capturedAt ?? asset.localCreatedAt;
  await db.transaction(async (tx) => {
    await tx.delete(eventAssets).where(eq(eventAssets.assetId, asset.id));
    await tx.delete(assets).where(eq(assets.id, asset.id));
    if (!others.length && blob) {
      const keys = [blob.storageKey, blob.previewKey, blob.thumbKey].filter((k): k is string => !!k);
      const ders = await tx.select({ key: derivatives.storageKey }).from(derivatives).where(eq(derivatives.blobId, blob.id));
      const crops = await tx.select({ key: faces.cropKey }).from(faces).where(eq(faces.blobId, blob.id));
      keys.push(...ders.map((d) => d.key), ...crops.map((c) => c.key).filter((k): k is string => !!k));
      await tx.delete(blobs).where(eq(blobs.id, blob.id));   // cascades faces, embeddings, derivatives
      await tx.update(blobs).set({ variantOf: null }).where(eq(blobs.variantOf, blob.id));
      await storage.delete([...new Set(keys)]);
    }
    await enqueue(tx, 'recluster', { groupId: asset.groupId, from: new Date(t.getTime() - WBS.reclusterPadHours * 3600_000).toISOString(), to: new Date(t.getTime() + WBS.reclusterPadHours * 3600_000).toISOString() }, { runAfterSeconds: WBS.reclusterDebounceSeconds });
  });
  await db.execute(sql`select 1`);
  log.info({ assetId: asset.id, blobRemoved: !others.length }, 'hard-delete: done');
}

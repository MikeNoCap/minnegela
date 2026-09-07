import { PassThrough } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import archiver from 'archiver';
import { eq, and, isNull, assets, blobs, faces, eventAssets, events } from '@minnegela/db';
import { JobPayloads } from '@minnegela/shared';
import type { Ctx } from '../context.js';

type P = ReturnType<typeof JobPayloads.export.parse>;

/** §18.7 GDPR portability: a zip of the user's originals (previews when no original) plus JSON metadata. */
export async function exportUser(ctx: Ctx, payload: P): Promise<string> {
  const { db, storage, log } = ctx;
  const rows = await db.select({ asset: assets, blob: blobs }).from(assets).innerJoin(blobs, eq(blobs.id, assets.blobId))
    .where(and(eq(assets.ownerUserId, payload.userId), eq(assets.groupId, payload.groupId), isNull(assets.deletedAt)));
  const key = `exports/${payload.userId}/${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const pass = new PassThrough();
  const upload = new Upload({ client: storage.client, params: { Bucket: storage.bucket, Key: key, Body: pass, ContentType: 'application/zip' } });
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.pipe(pass);
  const meta: unknown[] = [];
  const done = upload.done();
  for (const { asset, blob } of rows) {
    const src = blob.storageKey ?? blob.previewKey;
    if (src) {
      const local = await storage.get(src);
      zip.file(local, { name: `media/${asset.filename ?? asset.id}${blob.storageKey ? '' : '.preview.jpg'}` });
    }
    const fs = await db.select({ box: faces.box, tier: faces.tier, personId: faces.personId }).from(faces).where(eq(faces.blobId, blob.id));
    const evs = await db.select({ eventId: eventAssets.eventId, tier: eventAssets.tier, title: events.titleAuto }).from(eventAssets).innerJoin(events, eq(events.id, eventAssets.eventId)).where(eq(eventAssets.assetId, asset.id));
    meta.push({ assetId: asset.id, filename: asset.filename, localId: asset.localId, createdAt: asset.localCreatedAt, capturedAt: blob.capturedAt, lat: blob.lat, lon: blob.lon, camera: [blob.cameraMake, blob.cameraModel], tags: blob.tags, faces: fs, events: evs });
  }
  zip.append(JSON.stringify(meta, null, 2), { name: 'metadata.json' });
  await zip.finalize();
  await done;
  log.info({ userId: payload.userId, n: rows.length, key }, 'export: done');
  return key;
}

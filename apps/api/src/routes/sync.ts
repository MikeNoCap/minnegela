import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, blobs, assets, devices, sql, ManifestRequest, ManifestResponse, UploadsRequest, UploadsResponse, CompleteRequest, STORAGE_KEYS, UPLOAD, WBS, type ManifestResponse as ManifestResponseT, type UploadTarget } from '../deps.js';
import { extFor } from '../storage.js';
import { audit } from '../audit.js';
import { badRequest, notFound } from '../errors.js';
import { rows, asDate, uuidArr } from '../dto.js';

const G = z.object({ g: z.string().uuid() });
const ID = z.object({ id: z.string().uuid() });

export async function syncRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * The md5 pre-check must see every blob in the group, but blobs_select only shows blobs the viewer
   * already has an asset or a shared event for. packages/db can provide `app_find_blob(gid, md5, size)`
   * as a SECURITY DEFINER function; until it exists the check only matches the caller's own blobs and
   * the worker's SHA-256 merge in `derive` dedupes cross-user copies after upload instead.
   */
  let hasFindBlob: boolean | null = null;
  const findBlobByMd5 = async (tx: Parameters<Parameters<typeof withViewer>[2]>[0], groupId: string, md5: Buffer, size: number): Promise<string | null> => {
    if (hasFindBlob === null) {
      const [f] = await rows<{ ok: boolean }>(tx, sql`select to_regproc('app_find_blob') is not null as ok`);
      hasFindBlob = !!f?.ok;
      if (!hasFindBlob) app.log.warn('app_find_blob() missing: manifest md5 skip only matches the caller\'s own blobs');
    }
    const [hit] = hasFindBlob
      ? await rows<{ id: string | null }>(tx, sql`select app_find_blob(${groupId}::uuid, ${md5}, ${size}::bigint) as id`)
      : await rows<{ id: string }>(tx, sql`select id from blobs where group_id = ${groupId}::uuid and md5 = ${md5} and size_bytes = ${size} limit 1`);
    return hit?.id ?? null;
  };

  const presignStaging = async (groupId: string, assetId: string, kind: 'preview' | 'original', mime: string, bytes?: number): Promise<UploadTarget> => {
    const ext = kind === 'preview' ? 'jpg' : extFor(mime);
    const key = STORAGE_KEYS.staging(groupId, assetId, kind, ext);
    const cap = kind === 'preview' ? UPLOAD.maxPreviewBytes : UPLOAD.maxOriginalBytes;
    if (bytes !== undefined && bytes > cap) throw badRequest(`${kind} exceeds the size cap`);
    return ctx.storage.presignPut(key, { contentLength: bytes, contentType: kind === 'preview' ? 'image/jpeg' : mime });
  };

  /** §13.1 The phone (or CLI) describes a batch of assets; the server says what it wants. */
  r.post('/v1/groups/:g/sync/manifest', { schema: { params: G, body: ManifestRequest, response: { 200: ManifestResponse } }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const [dev] = await tx.select({ id: devices.id }).from(devices).where(sql`${devices.id} = ${req.body.deviceId}::uuid and ${devices.userId} = ${v.userId}::uuid`);
      if (!dev) throw notFound('Device not found');
      const results: ManifestResponseT['results'] = [];
      for (const item of req.body.assets) {
        const [existing] = await rows<{ id: string; blob_id: string; preview_uploaded_at: Date | null; original_uploaded_at: Date | null; preview_key: string | null; storage_key: string | null; mime: string }>(tx, sql`
          select a.id, a.blob_id, a.preview_uploaded_at, a.original_uploaded_at, b.preview_key, b.storage_key, b.mime
          from assets a join blobs b on b.id = a.blob_id where a.device_id = ${dev.id}::uuid and a.local_id = ${item.localId} and a.deleted_at is null`);
        if (existing) {
          const hasPreview = existing.preview_uploaded_at !== null || existing.preview_key !== null;
          const hasOriginal = existing.original_uploaded_at !== null || existing.storage_key !== null;
          if (!hasPreview) {
            results.push({ localId: item.localId, assetId: existing.id, action: 'want_preview', upload: await presignStaging(v.groupId, existing.id, 'preview', item.mime) });
          } else if (!hasOriginal) {
            // Preview is in; the original is requested by policy (Wi-Fi + charging) through /sync/uploads,
            // which binds the exact content length, so no upload target is issued here.
            results.push({ localId: item.localId, assetId: existing.id, action: 'want_original' });
          } else {
            results.push({ localId: item.localId, assetId: existing.id, action: 'skip' });
          }
          continue;
        }
        const md5 = item.md5 ? Buffer.from(item.md5, 'hex') : null;
        let blobId: string | null = null;
        let skip = false;
        if (md5) {
          const dup = await findBlobByMd5(tx, v.groupId, md5, item.size);
          if (dup) { blobId = dup; skip = true; }
        }
        if (!blobId) {
          // A blob is only visible once an asset references it, so RETURNING is not available here.
          blobId = randomUUID();
          await tx.insert(blobs).values({
            id: blobId, groupId: v.groupId, mime: item.mime, md5, sizeBytes: item.size, width: item.w ?? null, height: item.h ?? null,
            durationMs: item.dur !== undefined ? Math.round(item.dur * 1000) : null, capturedAt: new Date(item.createdAt),
            lat: item.gps?.lat ?? null, lon: item.gps?.lon ?? null, gpsAccuracyM: item.gps?.accuracyM ?? null,
          });
        }
        const [a] = await tx.insert(assets).values({
          groupId: v.groupId, blobId, ownerUserId: v.userId, deviceId: dev.id, localId: item.localId, filename: item.filename ?? null,
          albumNames: item.albums, localCreatedAt: new Date(item.createdAt), localModifiedAt: item.modifiedAt ? new Date(item.modifiedAt) : null, isFavorite: item.isFavorite,
          previewUploadedAt: skip ? new Date() : null,
        }).returning({ id: assets.id });
        if (skip) {
          // The bytes already exist in the group (AirDrop, shared album): nothing to upload, but the timeline changes.
          await enqueue(tx, 'recluster', { groupId: v.groupId, from: new Date(Date.parse(item.createdAt) - WBS.reclusterPadHours * 3600_000).toISOString(), to: new Date(Date.parse(item.createdAt) + WBS.reclusterPadHours * 3600_000).toISOString() }, { runAfterSeconds: WBS.reclusterDebounceSeconds });
          results.push({ localId: item.localId, assetId: a!.id, action: 'skip' });
        } else {
          results.push({ localId: item.localId, assetId: a!.id, action: 'want_preview', upload: await presignStaging(v.groupId, a!.id, 'preview', item.mime) });
        }
      }
      await tx.update(devices).set({ lastSyncAt: new Date() }).where(sql`${devices.id} = ${dev.id}::uuid`);
      return { results };
    });
  });

  /** Presigned PUTs for a batch (previews re-issued after expiry, or originals per the phone's policy). */
  r.post('/v1/groups/:g/sync/uploads', { schema: { params: G, body: UploadsRequest, response: { 200: UploadsResponse } }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const ids = req.body.items.map((i) => i.assetId);
      const mine = await rows<{ id: string; mime: string }>(tx, sql`select a.id, b.mime from assets a join blobs b on b.id = a.blob_id where a.id = any(${uuidArr(ids)}) and a.owner_user_id = ${v.userId}::uuid and a.group_id = ${v.groupId}::uuid and a.deleted_at is null`);
      const byId = new Map(mine.map((m) => [m.id, m]));
      const items = [];
      for (const it of req.body.items) {
        const m = byId.get(it.assetId);
        if (!m) continue; // not yours: silently omitted
        items.push({ assetId: it.assetId, kind: it.kind, upload: await presignStaging(v.groupId, it.assetId, it.kind, it.mime || m.mime, it.bytes) });
      }
      return { items };
    });
  });

  /** The phone says an upload landed. R2 does not call back; this is the only completion signal. */
  r.post('/v1/assets/:id/complete', { schema: { params: ID, body: CompleteRequest } }, async (req) => {
    const { ctx: v, found: a } = await req.ctxWhere(async (tx) => {
      const [a] = await rows<{ id: string; blob_id: string; mime: string }>(tx, sql`select a.id, a.blob_id, b.mime from assets a join blobs b on b.id = a.blob_id where a.id = ${req.params.id}::uuid and a.deleted_at is null`);
      return a;
    });
    return withViewer(ctx.db, v, async (tx) => {
      const ext = req.body.kind === 'preview' ? 'jpg' : extFor(a.mime);
      const stagingKey = STORAGE_KEYS.staging(v.groupId, a.id, req.body.kind, ext);
      const col = req.body.kind === 'preview' ? sql`preview_uploaded_at` : sql`original_uploaded_at`;
      const updated = await rows<{ id: string }>(tx, sql`update assets set ${col} = now() where id = ${a.id}::uuid and owner_user_id = ${v.userId}::uuid returning id`);
      if (!updated.length) throw notFound();
      await enqueue(tx, 'derive', { blobId: a.blob_id, groupId: v.groupId, kind: req.body.kind, stagingKey }, { priority: req.body.kind === 'preview' ? 10 : 0 });
      return { assetId: a.id, blobId: a.blob_id, kind: req.body.kind, stagingKey, queued: 'derive' };
    });
  });

  r.delete('/v1/assets/:id', { schema: { params: ID } }, async (req, reply) => {
    const { ctx: v, found: a } = await req.ctxWhere(async (tx) => {
      const [a] = await rows<{ id: string; captured_at: Date | null }>(tx, sql`select a.id, b.captured_at from assets a join blobs b on b.id = a.blob_id where a.id = ${req.params.id}::uuid and a.owner_user_id = app_user_id() and a.deleted_at is null`);
      return a;
    });
    await withViewer(ctx.db, v, async (tx) => {
      await tx.execute(sql`update assets set deleted_at = now() where id = ${a.id}::uuid`);
      await tx.execute(sql`delete from event_assets where asset_id = ${a.id}::uuid`);
      await enqueue(tx, 'hard_delete', { assetId: a.id }, { runAfterSeconds: 7 * 24 * 3600 });
      const t = asDate(a.captured_at)?.getTime() ?? Date.now();
      await enqueue(tx, 'recluster', { groupId: v.groupId, from: new Date(t - WBS.reclusterPadHours * 3600_000).toISOString(), to: new Date(t + WBS.reclusterPadHours * 3600_000).toISOString() }, { runAfterSeconds: WBS.reclusterDebounceSeconds });
      await audit(tx, v, 'asset.delete', { type: 'asset', id: a.id }, null, req);
    });
    return reply.status(204).send();
  });

  r.patch('/v1/assets/:id', { schema: { params: ID, body: z.object({ visibility: z.enum(['group', 'hidden']) }) } }, async (req) => {
    const { ctx: v, found: a } = await req.ctxWhere(async (tx) => {
      const [a] = await rows<{ id: string; captured_at: Date | null }>(tx, sql`select a.id, b.captured_at from assets a join blobs b on b.id = a.blob_id where a.id = ${req.params.id}::uuid and a.owner_user_id = app_user_id() and a.deleted_at is null`);
      return a;
    });
    return withViewer(ctx.db, v, async (tx) => {
      await tx.execute(sql`update assets set visibility = ${req.body.visibility}, excluded_reason = ${req.body.visibility === 'hidden' ? 'user_hid' : null} where id = ${a.id}::uuid`);
      if (req.body.visibility === 'hidden') await tx.execute(sql`delete from event_assets where asset_id = ${a.id}::uuid`);
      const t = asDate(a.captured_at)?.getTime() ?? Date.now();
      await enqueue(tx, 'recluster', { groupId: v.groupId, from: new Date(t - WBS.reclusterPadHours * 3600_000).toISOString(), to: new Date(t + WBS.reclusterPadHours * 3600_000).toISOString() }, { runAfterSeconds: WBS.reclusterDebounceSeconds });
      await audit(tx, v, req.body.visibility === 'hidden' ? 'asset.hide' : 'asset.unhide', { type: 'asset', id: a.id }, null, req);
      return { id: a.id, visibility: req.body.visibility };
    });
  });
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { sql, eq, and, ne, isNotNull, enqueue, blobs, assets, derivatives } from '@minnegela/db';
import { STORAGE_KEYS, PREVIEW, THUMB, JobPayloads } from '@minnegela/shared';
import type { Ctx } from '../context.js';
import { readMetadata, looksLikeScreenshot, looksReencoded, type Metadata } from '../metadata.js';
import { phash } from '../phash.js';
import { quality } from '../quality.js';
import { deriveVideo } from './derive-video.js';

export type DerivePayload = ReturnType<typeof JobPayloads.derive.parse>;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
export const extFor = (mime: string) => EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * §8.2 / §11 time rules. Returns the RAW capture instant (no device clock correction: the ML worker's
 * `recluster` applies devices.clock_offset_s at read time), its zone and whether the time is trustworthy.
 *   EXIF with explicit offset > OS creation date (absolute) > EXIF wall clock as UTC > upload time
 */
export function resolveCapture(m: Pick<Metadata, 'capturedAt' | 'capturedTz' | 'exifHasOffset'>, osCreatedAt: Date | null, uploadedAt: Date, isUtility: boolean, isVideo: boolean) {
  let capturedAt: Date, tz: string | null = null, uncertain = false;
  if (m.capturedAt && m.exifHasOffset) {
    capturedAt = m.capturedAt; tz = m.capturedTz;
    if (osCreatedAt && Math.abs(osCreatedAt.getTime() - capturedAt.getTime()) > 24 * 3600_000) uncertain = true;
  } else if (osCreatedAt) {
    capturedAt = osCreatedAt;
    if (m.capturedAt) {
      // EXIF wall clock (read as UTC) minus the true instant ≈ the zone offset, rounded to 15 min
      const diffMin = Math.round((m.capturedAt.getTime() - osCreatedAt.getTime()) / 60_000 / 15) * 15;
      if (Math.abs(diffMin) <= 14 * 60) {
        const sign = diffMin < 0 ? '-' : '+';
        const a = Math.abs(diffMin);
        tz = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
      } else uncertain = true;
    } else if (!isUtility && !isVideo) uncertain = true; // received media (messenger strips EXIF)
  } else if (m.capturedAt) {
    capturedAt = m.capturedAt; uncertain = true;
  } else {
    capturedAt = uploadedAt; uncertain = true;
  }
  return { capturedAt, tz, uncertain };
}

export async function derive(ctx: Ctx, payload: DerivePayload): Promise<void> {
  const { db, storage, log } = ctx;
  const [blob] = await db.select().from(blobs).where(eq(blobs.id, payload.blobId));
  if (!blob) { log.warn({ payload }, 'derive: blob gone, skipping'); return; }
  const isVideo = blob.mime.startsWith('video/');
  if (isVideo && payload.kind === 'original') return deriveVideo(ctx, payload, blob);

  const local = await storage.get(payload.stagingKey);
  const bytes = await readFile(local);
  const sha = sha256Hex(bytes);
  const firstDerive = !blob.derivedAt;

  if (firstDerive) {
    if (blob.sha256 && Buffer.from(blob.sha256).toString('hex') !== sha) {
      throw new Error(`sha256 mismatch for blob ${blob.id}: recorded ${Buffer.from(blob.sha256).toString('hex')}, uploaded ${sha}`);
    }
    // exact duplicate already in the group (§14): repoint assets, drop this blob and the upload
    const [existing] = await db.select({ id: blobs.id }).from(blobs).where(and(eq(blobs.groupId, blob.groupId), eq(blobs.sha256, Buffer.from(sha, 'hex')), ne(blobs.id, blob.id), isNotNull(blobs.derivedAt)));
    if (existing) {
      await db.transaction(async (tx) => {
        await tx.update(assets).set({ blobId: existing.id }).where(eq(assets.blobId, blob.id));
        await tx.delete(blobs).where(eq(blobs.id, blob.id));
      });
      await storage.delete([payload.stagingKey]);
      log.info({ blobId: blob.id, existing: existing.id }, 'derive: exact duplicate merged');
      return;
    }
  }

  const blobSha = firstDerive ? sha : Buffer.from(blob.sha256!).toString('hex');
  const g = blob.groupId;
  const assetRows = await db.select({ id: assets.id, localCreatedAt: assets.localCreatedAt }).from(assets).where(eq(assets.blobId, blob.id)).orderBy(assets.createdAt);
  const osCreatedAt = assetRows[0]?.localCreatedAt ?? null;

  let meta: Metadata | null = null;
  try { meta = await readMetadata(local); } catch (e) { if (payload.kind === 'preview' && !isVideo) throw e; log.warn({ err: e, blobId: blob.id }, 'derive: could not decode original; keeping existing preview'); }

  const update: Partial<typeof blobs.$inferInsert> = {};
  if (meta) {
    const utility = !isVideo && looksLikeScreenshot(meta);
    const reencoded = !isVideo && !utility && looksReencoded(meta);
    // a phone-made poster frame carries no EXIF, so a video never counts as "received media" here
    const t = resolveCapture(meta, osCreatedAt, blob.createdAt, utility, isVideo);
    // originals carry full EXIF: refresh metadata; a preview only sets what it knows
    Object.assign(update, {
      width: meta.width, height: meta.height,
      capturedAt: t.capturedAt, capturedTz: t.tz ?? blob.capturedTz,
      lat: meta.lat ?? blob.lat, lon: meta.lon ?? blob.lon,
      cameraMake: meta.cameraMake ?? blob.cameraMake, cameraModel: meta.cameraModel ?? blob.cameraModel,
      exif: meta.exif ?? blob.exif,
      // §7.4: messenger re-encodes get no vote on boundaries
      timeUncertain: t.uncertain || reencoded,
    });
    if (firstDerive || payload.kind === 'original') update.isUtility = utility || blob.isUtility;
  }

  // derivatives
  const derivRows: Array<typeof derivatives.$inferInsert> = [];
  const longEdge = meta ? Math.max(meta.width, meta.height) : 0;
  const prevKey = STORAGE_KEYS.preview(g, blobSha);
  const thumbKey = STORAGE_KEYS.thumb(g, blobSha);
  const needPreview = firstDerive || (payload.kind === 'original' && !!meta && Math.max(blob.width ?? 0, blob.height ?? 0) < PREVIEW.longEdgePx && longEdge > Math.max(blob.width ?? 0, blob.height ?? 0));
  if (meta && needPreview) {
    let previewBuf: Buffer;
    let pw: number, ph: number;
    if (longEdge > PREVIEW.longEdgePx || payload.kind === 'original' || meta.format !== 'jpeg' || meta.orientation !== 1) {
      const out = await sharp(local).autoOrient().resize(PREVIEW.longEdgePx, PREVIEW.longEdgePx, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: PREVIEW.jpegQuality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      previewBuf = out.data; pw = out.info.width; ph = out.info.height;
    } else {
      previewBuf = bytes; pw = meta.width; ph = meta.height; // phone-made 1600 px preview: use as-is
    }
    await storage.put(prevKey, previewBuf, 'image/jpeg');
    derivRows.push({ blobId: blob.id, kind: 'preview1600', storageKey: prevKey, width: pw, height: ph, bytes: previewBuf.length });
    const thumb = await sharp(previewBuf).resize(THUMB.longEdgePx, THUMB.longEdgePx, { fit: 'inside' }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    await storage.put(thumbKey, thumb.data, 'image/webp');
    derivRows.push({ blobId: blob.id, kind: 'thumb320', storageKey: thumbKey, width: thumb.info.width, height: thumb.info.height, bytes: thumb.data.length });
    update.previewKey = prevKey; update.thumbKey = thumbKey;
    if (firstDerive) {
      update.phash = await phash(previewBuf);
      update.quality = await quality(previewBuf);
    }
  }

  if (payload.kind === 'original') {
    const origKey = STORAGE_KEYS.original(g, blobSha, extFor(blob.mime));
    await storage.move(payload.stagingKey, origKey);
    update.storageKey = origKey; update.sizeBytes = bytes.length;
    if (!isVideo) update.exif = meta?.exif ?? blob.exif;
  } else {
    await storage.delete([payload.stagingKey]);
    if (firstDerive) update.sizeBytes = blob.sizeBytes ?? bytes.length;
  }
  if (firstDerive) { update.sha256 = Buffer.from(sha, 'hex'); update.derivedAt = new Date(); }

  await db.transaction(async (tx) => {
    await tx.update(blobs).set(update).where(eq(blobs.id, blob.id));
    for (const d of derivRows) {
      await tx.insert(derivatives).values(d).onConflictDoUpdate({ target: [derivatives.blobId, derivatives.kind, derivatives.frameIndex], set: { storageKey: d.storageKey, width: d.width, height: d.height, bytes: d.bytes } });
    }
    if (payload.kind === 'original') await tx.update(assets).set({ originalUploadedAt: sql`coalesce(original_uploaded_at, now())` }).where(eq(assets.blobId, blob.id));
    if (firstDerive) {
      await enqueue(tx, 'analyze', { blobId: blob.id, groupId: g }, { priority: isVideo ? -5 : 0 });
      await enqueue(tx, 'dedupe', { blobId: blob.id, groupId: g });
    }
  });
  log.info({ blobId: blob.id, kind: payload.kind, firstDerive, utility: update.isUtility, capturedAt: update.capturedAt }, 'derive: done');
}

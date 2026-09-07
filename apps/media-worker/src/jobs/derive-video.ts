import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sql, eq, enqueue, blobs, assets, derivatives } from '@minnegela/db';
import { STORAGE_KEYS, PREVIEW, THUMB, VIDEO } from '@minnegela/shared';
import type { Ctx } from '../context.js';
import { ffprobe, extractFrame, transcode720 } from '../ffmpeg.js';
import { phash } from '../phash.js';
import { quality } from '../quality.js';
import { sha256Hex, extFor, type DerivePayload } from './derive.js';

/** §13.2 video stage: poster + ≤ 8 frames, preview from the poster, 720p transcode. Lowest priority by design. */
export async function deriveVideo(ctx: Ctx, payload: DerivePayload, blob: typeof blobs.$inferSelect): Promise<void> {
  const { db, storage, cfg, log } = ctx;
  const local = await storage.get(payload.stagingKey);
  const bytes = await readFile(local);
  const sha = sha256Hex(bytes);
  const firstDerive = !blob.derivedAt;
  if (firstDerive && blob.sha256 && Buffer.from(blob.sha256).toString('hex') !== sha) throw new Error(`sha256 mismatch for video blob ${blob.id}`);
  const blobSha = firstDerive ? sha : Buffer.from(blob.sha256!).toString('hex');
  const g = blob.groupId;
  const probe = await ffprobe(cfg.ffmpeg.probe, local);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mn-video-'));
  try {
    const dur = probe.durationMs / 1000;
    const n = Math.min(VIDEO.frames, Math.max(1, Math.floor(dur)));
    const derivRows: Array<typeof derivatives.$inferInsert> = [];
    const posterAt = Math.min(1, dur * 0.1);
    const posterPath = path.join(tmp, 'poster.jpg');
    await extractFrame(cfg.ffmpeg.bin, local, posterAt, posterPath);
    const posterKey = STORAGE_KEYS.poster(g, blobSha);
    const posterBuf = await readFile(posterPath);
    await storage.put(posterKey, posterBuf, 'image/jpeg');
    derivRows.push({ blobId: blob.id, kind: 'poster', storageKey: posterKey, bytes: posterBuf.length });
    for (let i = 0; i < n; i++) {
      const at = ((i + 0.5) / n) * dur;
      const fp = path.join(tmp, `f${i}.jpg`);
      await extractFrame(cfg.ffmpeg.bin, local, at, fp);
      const key = STORAGE_KEYS.frame(g, blobSha, i);
      const fb = await readFile(fp);
      await storage.put(key, fb, 'image/jpeg');
      derivRows.push({ blobId: blob.id, kind: 'frame', frameIndex: i, storageKey: key, bytes: fb.length });
    }
    const prev = await sharp(posterBuf).resize(PREVIEW.longEdgePx, PREVIEW.longEdgePx, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: PREVIEW.jpegQuality }).toBuffer({ resolveWithObject: true });
    const prevKey = STORAGE_KEYS.preview(g, blobSha);
    await storage.put(prevKey, prev.data, 'image/jpeg');
    derivRows.push({ blobId: blob.id, kind: 'preview1600', storageKey: prevKey, width: prev.info.width, height: prev.info.height, bytes: prev.data.length });
    const thumb = await sharp(prev.data).resize(THUMB.longEdgePx, THUMB.longEdgePx, { fit: 'inside' }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const thumbKey = STORAGE_KEYS.thumb(g, blobSha);
    await storage.put(thumbKey, thumb.data, 'image/webp');
    derivRows.push({ blobId: blob.id, kind: 'thumb320', storageKey: thumbKey, width: thumb.info.width, height: thumb.info.height, bytes: thumb.data.length });

    const out720 = path.join(tmp, '720.mp4');
    await transcode720(cfg.ffmpeg.bin, local, out720, cfg.ffmpeg.nvenc);
    const v720Key = STORAGE_KEYS.video720(g, blobSha);
    const v720 = await readFile(out720);
    await storage.put(v720Key, v720, 'video/mp4');
    derivRows.push({ blobId: blob.id, kind: 'video720', storageKey: v720Key, bytes: v720.length, height: Math.min(720, probe.height) });

    const origKey = STORAGE_KEYS.original(g, blobSha, extFor(blob.mime));
    await storage.move(payload.stagingKey, origKey);

    const [asset] = await db.select({ localCreatedAt: assets.localCreatedAt }).from(assets).where(eq(assets.blobId, blob.id)).orderBy(assets.createdAt).limit(1);
    // raw capture time; devices.clock_offset_s is applied by recluster at read time
    const capturedAt = probe.creationTime ?? asset?.localCreatedAt ?? blob.capturedAt ?? blob.createdAt;
    const update: Partial<typeof blobs.$inferInsert> = {
      width: probe.width || blob.width, height: probe.height || blob.height, durationMs: probe.durationMs,
      capturedAt, lat: probe.lat ?? blob.lat, lon: probe.lon ?? blob.lon,
      previewKey: prevKey, thumbKey, storageKey: origKey, sizeBytes: bytes.length,
      exif: { ...(blob.exif ?? {}), codec: probe.codec, rotation: probe.rotation },
    };
    if (firstDerive) { update.sha256 = Buffer.from(sha, 'hex'); update.derivedAt = new Date(); update.phash = await phash(prev.data); update.quality = await quality(prev.data); }

    await db.transaction(async (tx) => {
      await tx.update(blobs).set(update).where(eq(blobs.id, blob.id));
      for (const d of derivRows) await tx.insert(derivatives).values(d).onConflictDoUpdate({ target: [derivatives.blobId, derivatives.kind, derivatives.frameIndex], set: { storageKey: d.storageKey, width: d.width, height: d.height, bytes: d.bytes } });
      await tx.update(assets).set({ originalUploadedAt: sql`coalesce(original_uploaded_at, now())` }).where(eq(assets.blobId, blob.id));
      // frames are new evidence for faces/CLIP: the ML worker analyzes frame_index ≥ 0 once they exist
      await enqueue(tx, 'analyze', { blobId: blob.id, groupId: g }, { priority: -5 });
      if (firstDerive) await enqueue(tx, 'dedupe', { blobId: blob.id, groupId: g });
    });
    log.info({ blobId: blob.id, durationMs: probe.durationMs, frames: n }, 'derive-video: done');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

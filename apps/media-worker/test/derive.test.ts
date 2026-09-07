import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { createDb, sql, eq, type DbHandle, users, groups, groupMembers, devices, blobs, assets, derivatives, jobs } from '@minnegela/db';
import { STORAGE_KEYS } from '@minnegela/shared';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { log } from '../src/log.js';
import { derive, sha256Hex } from '../src/jobs/derive.js';
import { dedupe } from '../src/jobs/dedupe.js';
import { titles } from '../src/jobs/titles.js';
import { hardDelete } from '../src/jobs/hard-delete.js';
import type { Ctx } from '../src/context.js';
import { makePhoto } from './fixtures.js';

const ADMIN = process.env.DATABASE_URL_ADMIN;
const WORKER = process.env.DATABASE_URL_WORKER;

describe.skipIf(!ADMIN || !WORKER || !process.env.S3_ENDPOINT)('derive / dedupe / titles against Postgres + MinIO', () => {
  let admin: DbHandle, worker: DbHandle, ctx: Ctx;
  let groupId: string, userId: string, deviceId: string;
  const cacheDir = `/tmp/claude-1000/-home-miklath-dev-Minnegela/8c84e3dc-c1f8-4f81-a264-95749c767039/scratchpad/mw-cache-${process.pid}`;

  beforeAll(async () => {
    admin = createDb(ADMIN!, { max: 2 }); worker = createDb(WORKER!, { max: 4 });
    const cfg = loadConfig({ ...process.env, WORKER_CACHE_DIR: cacheDir, GEOCODE: '0' });
    ctx = { db: worker.db, storage: Storage.fromConfig(cfg), cfg, log: log.child({ test: true }) };
    log.level = 'warn';
    const [u] = await admin.db.insert(users).values({ email: `mw-${Date.now()}@fixture.local`, displayName: 'Mikkel', birthday: '1994-03-14' }).returning();
    userId = u!.id;
    const [g] = await admin.db.insert(groups).values({ name: `mw-test-${Date.now()}`, createdBy: userId }).returning();
    groupId = g!.id;
    await admin.db.insert(groupMembers).values({ groupId, userId, role: 'owner' });
    const [d] = await admin.db.insert(devices).values({ userId, platform: 'cli', name: 'test' }).returning();
    deviceId = d!.id;
  });
  afterAll(async () => {
    await admin.db.delete(groups).where(eq(groups.id, groupId));
    await admin.db.delete(users).where(eq(users.id, userId));
    await admin.db.execute(sql`delete from jobs where payload->>'groupId' = ${groupId}`);
    await Promise.all([admin.close(), worker.close()]);
  });

  async function stage(buf: Buffer, opts: { mime?: string; kind?: 'preview' | 'original'; localCreatedAt?: Date; localId?: string; knownSha?: boolean } = {}) {
    const mime = opts.mime ?? 'image/jpeg';
    const [blob] = await admin.db.insert(blobs).values({ groupId, mime, sizeBytes: buf.length, md5: Buffer.alloc(16, 1), sha256: opts.knownSha === false ? null : Buffer.from(sha256Hex(buf), 'hex') }).returning();
    const [asset] = await admin.db.insert(assets).values({ groupId, blobId: blob!.id, ownerUserId: userId, deviceId, localId: opts.localId ?? `l-${blob!.id}`, localCreatedAt: opts.localCreatedAt ?? new Date('2026-03-14T20:30:10Z'), filename: 'IMG_1.jpg', previewUploadedAt: new Date() }).returning();
    const kind = opts.kind ?? 'preview';
    const stagingKey = STORAGE_KEYS.staging(groupId, asset!.id, kind, mime === 'image/png' ? 'png' : 'jpg');
    await ctx.storage.put(stagingKey, buf, mime);
    return { blobId: blob!.id, assetId: asset!.id, stagingKey, kind };
  }

  it('derives a preview upload: metadata, derivatives, staging removed, jobs enqueued', async () => {
    const buf = await makePhoto(11, { width: 1600, height: 1200, exif: { DateTimeOriginal: '2026:03:14 21:30:00', OffsetTimeOriginal: '+01:00', lat: '59.9', lon: '10.75' } });
    const s = await stage(buf);
    await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey });
    const [b] = await worker.db.select().from(blobs).where(eq(blobs.id, s.blobId));
    expect(b!.derivedAt).not.toBeNull();
    expect(b!.width).toBe(1600); expect(b!.height).toBe(1200);
    expect(b!.capturedAt!.toISOString()).toBe('2026-03-14T20:30:00.000Z');
    expect(b!.capturedTz).toBe('+01:00');
    expect(b!.lat).toBeCloseTo(59.9, 3); expect(b!.lon).toBeCloseTo(10.75, 3);
    expect(b!.cameraMake).toBe('Apple');
    expect(b!.phash).toHaveLength(64);
    expect(b!.isUtility).toBe(false); expect(b!.timeUncertain).toBe(false);
    expect(b!.quality?.sharpness).toBeGreaterThan(0);
    expect(b!.previewKey).toBe(STORAGE_KEYS.preview(groupId, sha256Hex(buf)));
    expect(await ctx.storage.head(b!.previewKey!)).not.toBeNull();
    expect(await ctx.storage.head(b!.thumbKey!)).not.toBeNull();
    expect(await ctx.storage.head(s.stagingKey)).toBeNull();
    const ders = await worker.db.select().from(derivatives).where(eq(derivatives.blobId, s.blobId));
    expect(ders.map((d) => d.kind).sort()).toEqual(['preview1600', 'thumb320']);
    const js = await worker.db.select().from(jobs).where(sql`payload->>'blobId' = ${s.blobId} and done_at is null`);
    expect(js.map((j) => j.kind).sort()).toEqual(['analyze', 'dedupe']);
    // a preview larger than 1600 px is downscaled; a 1600 one is stored as-is (same bytes)
    const stored = await ctx.storage.getBuffer(b!.previewKey!);
    expect(stored.equals(buf)).toBe(true);
  });

  it('a later original refreshes metadata, stores at orig/, does not re-enqueue analyze', async () => {
    const preview = await makePhoto(12, { width: 1600, height: 1200, exif: {} });
    const s = await stage(preview);
    await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey });
    await admin.db.execute(sql`delete from jobs where payload->>'blobId' = ${s.blobId}`);
    const original = await makePhoto(12, { width: 4000, height: 3000, exif: { Model: 'iPhone 15 Pro' } });
    const origKey = STORAGE_KEYS.staging(groupId, s.assetId, 'original', 'jpg');
    await ctx.storage.put(origKey, original, 'image/jpeg');
    await derive(ctx, { blobId: s.blobId, groupId, kind: 'original', stagingKey: origKey });
    const [b] = await worker.db.select().from(blobs).where(eq(blobs.id, s.blobId));
    expect(b!.storageKey).toBe(STORAGE_KEYS.original(groupId, sha256Hex(preview), 'jpg'));
    expect(b!.width).toBe(4000); expect(b!.cameraModel).toBe('iPhone 15 Pro');
    expect(await ctx.storage.head(b!.storageKey!)).not.toBeNull();
    const [a] = await worker.db.select().from(assets).where(eq(assets.id, s.assetId));
    expect(a!.originalUploadedAt).not.toBeNull();
    const js = await worker.db.select().from(jobs).where(sql`payload->>'blobId' = ${s.blobId} and kind = 'analyze'`);
    expect(js).toHaveLength(0);
  });

  it('exact duplicate across devices merges into the existing blob', async () => {
    const buf = await makePhoto(13, { width: 1600, height: 1200, exif: {} });
    const s1 = await stage(buf, { localId: 'dup-a' });
    await derive(ctx, { blobId: s1.blobId, groupId, kind: 'preview', stagingKey: s1.stagingKey });
    const s2 = await stage(buf, { localId: 'dup-b', knownSha: false }); // the API only knew the md5
    await derive(ctx, { blobId: s2.blobId, groupId, kind: 'preview', stagingKey: s2.stagingKey });
    const [a2] = await worker.db.select().from(assets).where(eq(assets.id, s2.assetId));
    expect(a2!.blobId).toBe(s1.blobId);
    expect(await worker.db.select().from(blobs).where(eq(blobs.id, s2.blobId))).toHaveLength(0);
    expect(await ctx.storage.head(s2.stagingKey)).toBeNull();
  });

  it('screenshots are utility; messenger re-encodes are time-uncertain', async () => {
    const png = await makePhoto(14, { width: 1179, height: 2556, format: 'png' });
    const s = await stage(png, { mime: 'image/png' });
    await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey });
    const [b] = await worker.db.select().from(blobs).where(eq(blobs.id, s.blobId));
    expect(b!.isUtility).toBe(true);
    const wa = await sharp(await makePhoto(15, { width: 1280, height: 960 })).jpeg({ quality: 70 }).toBuffer(); // no EXIF at all
    const s2 = await stage(wa);
    await derive(ctx, { blobId: s2.blobId, groupId, kind: 'preview', stagingKey: s2.stagingKey });
    const [b2] = await worker.db.select().from(blobs).where(eq(blobs.id, s2.blobId));
    expect(b2!.isUtility).toBe(false); expect(b2!.timeUncertain).toBe(true);
  });

  it('dedupe links a re-encoded copy and a burst', async () => {
    const orig = await makePhoto(16, { width: 1600, height: 1200, exif: { DateTimeOriginal: '2026:03:14 22:00:00' } });
    const copy = await sharp(orig).resize(1280).jpeg({ quality: 60 }).toBuffer();
    // a burst frame: the same scene a few seconds later, camera moved a little (≈ 8 bits of pHash away)
    const burst = await sharp(await makePhoto(16, { width: 1600, height: 1200 })).extract({ left: 96, top: 72, width: 1504, height: 1128 }).resize(1600, 1200).jpeg({ quality: 90 })
      .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15' }, IFD2: { DateTimeOriginal: '2026:03:14 22:00:03', OffsetTimeOriginal: '+01:00' } } as never).toBuffer();
    const sa = await stage(orig, { localCreatedAt: new Date('2026-03-14T21:00:00Z') });
    const sb = await stage(copy, { localCreatedAt: new Date('2026-03-15T09:00:00Z') });
    const sc = await stage(burst, { localCreatedAt: new Date('2026-03-14T21:00:03Z') });
    for (const s of [sa, sb, sc]) await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey });
    await dedupe(ctx, { blobId: sb.blobId, groupId });
    await dedupe(ctx, { blobId: sc.blobId, groupId });
    const [a] = await worker.db.select().from(blobs).where(eq(blobs.id, sa.blobId));
    const [b] = await worker.db.select().from(blobs).where(eq(blobs.id, sb.blobId));
    const [c] = await worker.db.select().from(blobs).where(eq(blobs.id, sc.blobId));
    expect(b!.variantOf).toBe(sa.blobId);
    expect(a!.variantOf).toBeNull();
    expect(c!.nearDupGroupId).not.toBeNull();
    expect(a!.nearDupGroupId).toBe(c!.nearDupGroupId);
  });

  it('titles: creates a place, picks a cover, and names the event by rule', async () => {
    const t = new Date('2026-03-14T20:00:00Z');
    const bufs = await Promise.all([1, 2, 3].map((i) => makePhoto(20 + i, { width: 1600, height: 1200, exif: { DateTimeOriginal: `2026:03:14 21:0${i}:00`, lat: '59.91', lon: '10.76' } })));
    const staged = [];
    for (const b of bufs) { const s = await stage(b, { localCreatedAt: t }); await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey }); staged.push(s); }
    const [ev] = await worker.db.execute(sql`insert into events (group_id, start_at, end_at, tz, center_lat, center_lon) values (${groupId}, ${t.toISOString()}::timestamptz, ${new Date(t.getTime() + 3600_000).toISOString()}::timestamptz, 'Europe/Oslo', 59.91, 10.76) returning id`) as unknown as Array<{ id: string }>;
    for (const s of staged) await worker.db.execute(sql`insert into event_assets (event_id, asset_id, blob_id, confidence, tier, source) values (${ev!.id}, ${s.assetId}, ${s.blobId}, 0.9, 'confirmed', 'auto')`);
    await titles(ctx, { groupId, eventIds: [ev!.id] });
    const [row] = await worker.db.execute(sql`select e.title_auto, e.place_id, e.cover_blob_id, p.n_events from events e join places p on p.id = e.place_id where e.id = ${ev!.id}`) as unknown as Array<{ title_auto: string; place_id: string; cover_blob_id: string; n_events: number }>;
    expect(row!.title_auto).toBe('Saturday evening');   // 21:00 local on 14 March 2026 (a Saturday), no city without geocoding
    expect(row!.place_id).toBeTruthy(); expect(row!.n_events).toBe(1);
    expect(staged.map((s) => s.blobId)).toContain(row!.cover_blob_id);
    await worker.db.execute(sql`update places set name = 'Blå' where id = ${row!.place_id}`);
    await titles(ctx, { groupId, eventIds: [ev!.id] });
    const [row2] = await worker.db.execute(sql`select title_auto from events where id = ${ev!.id}`) as unknown as Array<{ title_auto: string }>;
    expect(row2!.title_auto).toBe('Blå, Saturday evening');
  });

  it('hard delete removes the blob and its objects when unreferenced', async () => {
    const buf = await makePhoto(30, { width: 1600, height: 1200, exif: {} });
    const s = await stage(buf);
    await derive(ctx, { blobId: s.blobId, groupId, kind: 'preview', stagingKey: s.stagingKey });
    const [b] = await worker.db.select().from(blobs).where(eq(blobs.id, s.blobId));
    await admin.db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, s.assetId));
    await hardDelete(ctx, { assetId: s.assetId });
    expect(await worker.db.select().from(blobs).where(eq(blobs.id, s.blobId))).toHaveLength(0);
    expect(await ctx.storage.head(b!.previewKey!)).toBeNull();
    const js = await worker.db.select().from(jobs).where(sql`kind = 'recluster' and payload->>'groupId' = ${groupId} and done_at is null`);
    expect(js).toHaveLength(1);
  });
});

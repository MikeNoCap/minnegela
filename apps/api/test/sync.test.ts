import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { sql, type DbHandle } from '@minnegela/db';
import { HAS_DB, testApp, cleanupUsers, createUser, sessionFor, auth } from './helpers.js';
import type { App } from '../src/app.js';

// A tiny (but real) JPEG: SOI, APP0, and EOI. Enough for storage; derive would reject it, which is fine here.
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

describe.skipIf(!HAS_DB)('sync protocol', () => {
  let app: App, admin: DbHandle, tokenA: string, tokenB: string, groupId: string, devA: string, devB: string;
  beforeAll(async () => {
    ({ app, admin } = await testApp());
    const a = await createUser(admin, `synca-${Date.now()}@apitest.local`, 'A');
    const b = await createUser(admin, `syncb-${Date.now()}@apitest.local`, 'B');
    tokenA = await sessionFor(admin, a); tokenB = await sessionFor(admin, b);
    groupId = (await app.inject({ method: 'POST', url: '/v1/groups', headers: auth(tokenA), payload: { name: 'Sync' } })).json().id;
    const { code } = (await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/invites`, headers: auth(tokenA), payload: {} })).json();
    await app.inject({ method: 'POST', url: `/v1/invites/${code}/accept`, headers: auth(tokenB) });
    devA = (await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/devices`, headers: auth(tokenA), payload: { platform: 'cli', name: 'a' } })).json().id;
    devB = (await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/devices`, headers: auth(tokenB), payload: { platform: 'cli', name: 'b' } })).json().id;
  });
  afterAll(async () => { await cleanupUsers(admin, '%@apitest.local'); await app.close(); await admin.close(); });

  const md5 = createHash('md5').update(JPEG).digest('hex');
  const sha256 = createHash('sha256').update(JPEG).digest('hex');
  const item = (localId: string) => ({ localId, md5, size: JPEG.length, mime: 'image/jpeg', createdAt: '2026-03-14T21:30:00+01:00', gps: { lat: 59.92, lon: 10.76 }, w: 4000, h: 3000, albums: ['Camera Roll'], filename: 'IMG_0001.jpg' });

  it('manifest → presigned PUT → complete → derive job; same content from another phone is skipped', async () => {
    const m1 = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devA, assets: [item('ph-1')] } });
    expect(m1.statusCode).toBe(200);
    const [r1] = m1.json().results;
    expect(r1.action).toBe('want_preview');
    expect(r1.upload.url).toContain('/staging/preview/');

    // the same manifest again is idempotent and re-issues the URL
    const again = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devA, assets: [item('ph-1')] } });
    expect(again.json().results[0]).toMatchObject({ assetId: r1.assetId, action: 'want_preview' });

    // wrong device (belongs to B) → 404
    expect((await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devB, assets: [item('x')] } })).statusCode).toBe(404);

    // upload straight to storage with the presigned URL
    const put = await fetch(r1.upload.url, { method: 'PUT', headers: r1.upload.headers, body: JPEG });
    expect(put.status).toBe(200);
    expect(await app.ctx.storage.head(r1.upload.key)).toMatchObject({ size: JPEG.length });

    const done = await app.inject({ method: 'POST', url: `/v1/assets/${r1.assetId}/complete`, headers: auth(tokenA), payload: { kind: 'preview', sha256, bytes: JPEG.length } });
    expect(done.statusCode).toBe(200);
    expect(done.json().queued).toBe('derive');
    const jobs = (await admin.db.execute(sql`select kind, payload from jobs where kind = 'derive' and payload->>'blobId' = ${done.json().blobId}`)) as unknown as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ groupId, kind: 'preview', stagingKey: r1.upload.key });
    const [asset] = (await admin.db.execute(sql`select preview_uploaded_at, local_created_at from assets where id = ${r1.assetId}::uuid`)) as unknown as [{ preview_uploaded_at: Date; local_created_at: Date }];
    expect(asset.preview_uploaded_at).toBeTruthy();
    expect(new Date(asset.local_created_at).toISOString()).toBe('2026-03-14T20:30:00.000Z');

    // B cannot complete A's asset
    expect((await app.inject({ method: 'POST', url: `/v1/assets/${r1.assetId}/complete`, headers: auth(tokenB), payload: { kind: 'preview', sha256, bytes: JPEG.length } })).statusCode).toBe(404);

    // after the preview exists, the manifest answers skip
    const m3 = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devA, assets: [item('ph-1')] } });
    expect(m3.json().results[0].action).toBe('skip');

    // A's own second copy of the same bytes: skipped, points at the same blob
    const mA2 = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devA, assets: [item('ph-copy')] } });
    expect(mA2.json().results[0].action).toBe('skip');
    const [copy] = (await admin.db.execute(sql`select blob_id from assets where id = ${mA2.json().results[0].assetId}::uuid`)) as unknown as [{ blob_id: string }];
    expect(copy.blob_id).toBe(done.json().blobId);

    // B has the same bytes (AirDrop): asset created, nothing uploaded — needs app_find_blob() in packages/db
    const [fn] = (await admin.db.execute(sql`select to_regproc('app_find_blob') is not null as ok`)) as unknown as [{ ok: boolean }];
    const mB = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenB), payload: { deviceId: devB, assets: [item('b-1')] } });
    const [rB] = mB.json().results;
    if (fn.ok) {
      expect(rB.action).toBe('skip');
      const [bAsset] = (await admin.db.execute(sql`select blob_id from assets where id = ${rB.assetId}::uuid`)) as unknown as [{ blob_id: string }];
      expect(bAsset.blob_id).toBe(done.json().blobId);
    } else {
      expect(rB.action).toBe('want_preview');   // cross-user copy is merged later by derive's SHA-256 check
    }

    // originals go through /sync/uploads with an exact size, then complete
    const up = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/uploads`, headers: auth(tokenA), payload: { items: [{ assetId: r1.assetId, kind: 'original', bytes: JPEG.length, mime: 'image/jpeg' }, { assetId: rB.assetId, kind: 'original', bytes: 1, mime: 'image/jpeg' }] } });
    expect(up.json().items).toHaveLength(1);   // B's asset silently omitted
    const put2 = await fetch(up.json().items[0].upload.url, { method: 'PUT', headers: up.json().items[0].upload.headers, body: JPEG });
    expect(put2.status).toBe(200);
    const wrongSize = await fetch(up.json().items[0].upload.url, { method: 'PUT', headers: { ...up.json().items[0].upload.headers, 'content-length': String(JPEG.length + 1) }, body: Buffer.concat([JPEG, Buffer.from([0])]) });
    expect(wrongSize.status).toBeGreaterThanOrEqual(400);

    // delete → soft delete + hard_delete job in 7 days
    expect((await app.inject({ method: 'DELETE', url: `/v1/assets/${r1.assetId}`, headers: auth(tokenA) })).statusCode).toBe(204);
    const hd = (await admin.db.execute(sql`select run_after > now() + interval '6 days' as later from jobs where kind = 'hard_delete' and payload->>'assetId' = ${r1.assetId}`)) as unknown as Array<{ later: boolean }>;
    expect(hd).toEqual([{ later: true }]);
    await app.ctx.storage.delete([r1.upload.key, up.json().items[0].upload.key]);
  });

  it('validates the manifest body', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/groups/${groupId}/sync/manifest`, headers: auth(tokenA), payload: { deviceId: devA, assets: [{ localId: 'x', size: -1, mime: 'image/jpeg', createdAt: 'not a date' }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues.length).toBeGreaterThan(0);
  });
});

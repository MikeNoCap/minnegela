import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, sql, visibleBlobIds, visibleAssetsWhere, assets, DEDUPE, MediaUrlsRequest, SignedUrlKind, type ViewerCtx, type Tx } from '../deps.js';
import { audit } from '../audit.js';
import { rows, iso, MEDIA_COLUMNS, toMediaItem, titleSql, type MediaRow, A, mediaRows, uuidArr, ts } from '../dto.js';

const G = z.object({ g: z.string().uuid() });
const BLOB = z.object({ blobId: z.string().uuid() });
type Kind = z.infer<typeof SignedUrlKind>;

type BlobKeys = { id: string; thumb_key: string | null; preview_key: string | null; storage_key: string | null; video720: string | null; poster: string | null };

/** Keys for visible blobs only; the visibility check happens here, before any signing. */
async function keysForVisible(tx: Tx, ctx: ViewerCtx, blobIds: string[]): Promise<Map<string, BlobKeys>> {
  const list = await rows<BlobKeys>(tx, sql`select b.id, b.thumb_key, b.preview_key, b.storage_key,
      (select storage_key from derivatives d where d.blob_id = b.id and d.kind = 'video720' limit 1) as video720,
      (select storage_key from derivatives d where d.blob_id = b.id and d.kind = 'poster' limit 1) as poster
    from blobs b where b.id = any(${uuidArr(blobIds)}) and b.id in ${visibleBlobIds(ctx)}`);
  return new Map(list.map((b) => [b.id, b]));
}
const keyFor = (b: BlobKeys, kind: Kind) => ({ thumb: b.thumb_key ?? b.preview_key, preview: b.preview_key, orig: b.storage_key, video720: b.video720, poster: b.poster })[kind];

export async function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/media/:blobId', { schema: { params: BLOB } }, async (req) => {
    const { ctx: v, found: m } = await req.ctxWhere(async (tx, c) => {
      const [m] = await mediaRows<MediaRow & { camera_make: string | null; camera_model: string | null; city: string | null; near_dup_group_id: string | null; quality: unknown; has_emb: boolean }>(tx, sql`
        select ${MEDIA_COLUMNS}, b.camera_make, b.camera_model, b.city, b.near_dup_group_id, b.quality, (b.clip_emb is not null) as has_emb
        from assets a join blobs b on b.id = a.blob_id where b.id = ${req.params.blobId}::uuid and ${visibleAssetsWhere(c, A)}
        order by (a.owner_user_id = ${c.userId}::uuid) desc limit 1`);
      return m;
    });
    return withViewer(ctx.db, v, async (tx) => {
      const owners = await rows<{ user_id: string; display_name: string; asset_id: string }>(tx, sql`select a.owner_user_id as user_id, u.display_name, a.id as asset_id from assets a join users u on u.id = a.owner_user_id where a.blob_id = ${m.blob_id}::uuid and a.deleted_at is null`);
      const faces = await rows<{ id: number | null; name: string | null; user_id: string | null; cover_face_id: string | null; hidden: boolean | null; tier: string | null; face_id: string; box: unknown }>(tx, sql`select p.id, p.name, p.user_id, p.cover_face_id, p.hidden, f.tier, f.id as face_id, f.box from faces f left join persons p on p.id = f.person_id where f.blob_id = ${m.blob_id}::uuid order by f.det_score desc`);
      const evs = await rows<{ event_id: string; tier: string; confidence: number; title: string | null; start_at: Date; place_name: string | null }>(tx, sql`select ea.event_id, ea.tier, ea.confidence, ${titleSql(req.locale)} as title, e.start_at, pl.name as place_name from event_assets ea join events e on e.id = ea.event_id left join places pl on pl.id = e.place_id where ea.blob_id = ${m.blob_id}::uuid and e.deleted_at is null order by ea.confidence desc`);
      const mediaByBlob = async (ids: string[]) => ids.length ? mediaRows(tx, sql`select distinct on (b.id) ${MEDIA_COLUMNS} from assets a join blobs b on b.id = a.blob_id where b.id = any(${uuidArr(ids)}) and ${visibleAssetsWhere(v, A)} order by b.id, (a.owner_user_id = ${v.userId}::uuid) desc`) : [];
      const similarIds = m.has_emb ? (await rows<{ id: string }>(tx, sql`select b.id from blobs b where b.id <> ${m.blob_id}::uuid and b.clip_emb is not null and b.id in ${visibleBlobIds(v)} order by b.clip_emb <=> (select clip_emb from blobs where id = ${m.blob_id}::uuid) limit 12`)).map((s) => s.id) : [];
      const angleIds = m.captured_at ? (await rows<{ id: string }>(tx, sql`
        select distinct b.id from blobs b join assets a on a.blob_id = b.id
        where b.id <> ${m.blob_id}::uuid and b.id in ${visibleBlobIds(v)} and a.owner_user_id <> ${m.owner_user_id}::uuid and a.deleted_at is null
          and b.captured_at between ${ts(m.captured_at)} - make_interval(secs => ${DEDUPE.otherAngleMaxSeconds}) and ${ts(m.captured_at)} + make_interval(secs => ${DEDUPE.otherAngleMaxSeconds})
          and (b.lat is null or ${m.lat}::double precision is null or earth_distance(ll_to_earth(b.lat, b.lon), ll_to_earth(${m.lat}, ${m.lon})) <= ${DEDUPE.otherAngleMaxMeters})
          ${m.has_emb ? sql`and (b.clip_emb is null or 1 - (b.clip_emb <=> (select clip_emb from blobs where id = ${m.blob_id}::uuid)) >= ${DEDUPE.otherAngleClipCos})` : sql``}
        limit 8`)).map((s) => s.id) : [];
      const stackIds = m.near_dup_group_id ? (await rows<{ id: string }>(tx, sql`select id from blobs where near_dup_group_id = ${m.near_dup_group_id}::uuid and id <> ${m.blob_id}::uuid and id in ${visibleBlobIds(v)} limit 20`)).map((s) => s.id) : [];
      const [similar, otherAngles, stack] = await Promise.all([mediaByBlob(similarIds), mediaByBlob(angleIds), mediaByBlob(stackIds)]);
      const byId = (list: MediaRow[], ids: string[]) => ids.map((id) => list.find((x) => x.blob_id === id)).filter((x): x is MediaRow => !!x).map(toMediaItem);
      const owner = owners.find((o) => o.user_id === m.owner_user_id) ?? owners[0];
      const people = faces.filter((f) => f.id !== null).reduce<Array<{ id: number; name: string | null; userId: string | null; coverFaceId: string | null; hidden: boolean; tier: string | null }>>((acc, f) => {
        if (!acc.some((x) => x.id === f.id)) acc.push({ id: f.id!, name: f.name, userId: f.user_id, coverFaceId: f.cover_face_id, hidden: f.hidden ?? false, tier: f.tier });
        return acc;
      }, []);
      return {
        ...toMediaItem(m), ownerName: owner?.display_name ?? null, placeName: evs[0]?.place_name ?? null, city: m.city,
        camera: m.camera_make || m.camera_model ? { make: m.camera_make, model: m.camera_model } : null, quality: m.quality,
        owners: owners.map((o) => ({ userId: o.user_id, displayName: o.display_name, assetId: o.asset_id })),
        people,
        faces: faces.map((f) => ({ faceId: f.face_id, personId: f.id, name: f.name, tier: f.tier, box: f.box })),
        events: evs.map((e) => ({ id: e.event_id, eventId: e.event_id, title: e.title ?? iso(e.start_at)!.slice(0, 10), tier: e.tier, confidence: e.confidence })),
        similar: byId(similar, similarIds), otherAngles: byId(otherAngles, angleIds), stack: byId(stack, stackIds),
      };
    });
  });

  r.get('/v1/media/:blobId/url', { schema: { params: BLOB, querystring: z.object({ kind: SignedUrlKind.default('preview') }) }, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { found } = await req.ctxWhere(async (tx, c) => (await keysForVisible(tx, c, [req.params.blobId])).get(req.params.blobId));
    const key = keyFor(found, req.query.kind);
    if (!key) return { url: null, kind: req.query.kind };
    return { url: await ctx.storage.presignGet(key), kind: req.query.kind };
  });

  /** One signature batch per grid render; invisible blobs are silently omitted (§18.6). */
  r.post('/v1/groups/:g/media/urls', { schema: { params: G, body: MediaUrlsRequest }, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const keys = await keysForVisible(tx, v, [...new Set(req.body.items.map((i) => i.blobId))]);
      const urls: Record<string, string> = {};
      await Promise.all(req.body.items.map(async (it) => {
        const b = keys.get(it.blobId);
        const key = b && keyFor(b, it.kind);
        if (key) urls[`${it.blobId}:${it.kind}`] = await ctx.storage.presignGet(key);
      }));
      await audit(tx, v, 'media.sign', null, { requested: req.body.items.length, signed: Object.keys(urls).length }, req);
      return { urls };
    });
  });
}

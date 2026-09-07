import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, sql, visibleBlobIds, visibleAssetsWhere, visibleEventsWhere, assets, events, type ViewerCtx, type Tx } from '../deps.js';
import { audit } from '../audit.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { rows, EVENT_COLUMNS, MEDIA_COLUMNS, toEventCard, toMediaItem, visibleEventsFrom, type EventRow, type MediaRow, E, A, eventRows, mediaRows, uuidArr } from '../dto.js';

const G = z.object({ g: z.string().uuid() });
const PID = z.object({ id: z.coerce.number().int() });
type PersonRow = { id: number; name: string | null; user_id: string | null; cover_face_id: string | null; hidden: boolean; group_id: string };

async function findPerson(tx: Tx, ctx: ViewerCtx, id: number): Promise<PersonRow | undefined> {
  const [p] = await rows<PersonRow>(tx, sql`select id, name, user_id, cover_face_id, hidden, group_id from persons where id = ${id} and group_id = ${ctx.groupId}::uuid`);
  return p;
}

/** Record confirmations and apply them where RLS allows (see README: faces need an update policy for the immediate flip). */
async function confirmFaces(tx: Tx, ctx: ViewerCtx, faceIds: string[], personId: number): Promise<{ labelled: number; applied: number }> {
  if (!faceIds.length) return { labelled: 0, applied: 0 };
  const labelled = await rows<{ face_id: string }>(tx, sql`insert into face_labels (face_id, person_id, verdict, by_user_id)
    select f.id, ${personId}, 'confirm', ${ctx.userId}::uuid from faces f where f.id = any(${uuidArr(faceIds)})
    on conflict (face_id, person_id) do update set verdict = 'confirm', by_user_id = excluded.by_user_id, created_at = now() returning face_id`);
  const applied = await rows<{ id: string }>(tx, sql`update faces set person_id = ${personId}, tier = 'confirmed', match_source = 'label', match_score = 1 where id = any(${uuidArr(faceIds)}) returning id`);
  return { labelled: labelled.length, applied: applied.length };
}

export async function peopleRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/groups/:g/people', { schema: { params: G, querystring: z.object({ includeHidden: z.coerce.boolean().default(false) }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const list = await rows<PersonRow & { n_assets: number; n_events: number }>(tx, sql`select p.id, p.name, p.user_id, p.cover_face_id, p.hidden, p.group_id,
          (select count(*)::int from assets a where a.person_ids @> array[p.id]::int[] and ${visibleAssetsWhere(v, A)}) as n_assets,
          (select count(*)::int from events e where e.person_ids @> array[p.id]::int[] and ${visibleEventsWhere(v, E)}) as n_events
        from persons p where p.group_id = ${v.groupId}::uuid ${req.query.includeHidden ? sql`` : sql`and not p.hidden`} order by n_assets desc, p.name`);
      return list.map((p) => ({ id: p.id, name: p.name, userId: p.user_id, coverFaceId: p.cover_face_id, hidden: p.hidden, nAssets: p.n_assets, nEvents: p.n_events }));
    });
  });

  r.get('/v1/people/:id', { schema: { params: PID } }, async (req) => {
    const { ctx: v, found: p } = await req.ctxWhere((tx, c) => findPerson(tx, c, req.params.id));
    return withViewer(ctx.db, v, async (tx) => {
      const evs = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(v)} and e.person_ids @> array[${p.id}]::int[] and e.kind <> 'loose' order by e.start_at desc limit 100`);
      const co = await rows<{ id: number; name: string | null; n: number }>(tx, sql`select q.id, q.name, count(*)::int as n
        from persons q join events e on e.person_ids @> array[${p.id}, q.id]::int[]
        where q.group_id = ${v.groupId}::uuid and q.id <> ${p.id} and not q.hidden and ${visibleEventsWhere(v, E)}
        group by q.id, q.name order by n desc limit 20`);
      const [counts] = await rows<{ n_assets: number }>(tx, sql`select count(*)::int as n_assets from assets a where a.person_ids @> array[${p.id}]::int[] and ${visibleAssetsWhere(v, A)}`);
      const media = await mediaRows(tx, sql`select ${MEDIA_COLUMNS} from assets a join blobs b on b.id = a.blob_id where a.person_ids @> array[${p.id}]::int[] and ${visibleAssetsWhere(v, A)} order by b.captured_at desc nulls last limit 200`);
      return { id: p.id, name: p.name, userId: p.user_id, coverFaceId: p.cover_face_id, hidden: p.hidden, nAssets: counts?.n_assets ?? 0, events: evs.map(toEventCard), coAppearances: co.map((c) => ({ personId: c.id, name: c.name, count: c.n, n: c.n })), media: media.map(toMediaItem) };
    });
  });

  r.post('/v1/groups/:g/people', { schema: { params: G, body: z.object({ name: z.string().min(1).max(100), clusterId: z.string().uuid().optional() }) } }, async (req, reply) => {
    const v = await req.ctxFor(req.params.g);
    const out = await withViewer(ctx.db, v, async (tx) => {
      const [p] = await rows<{ id: number }>(tx, sql`insert into persons (group_id, name) values (${v.groupId}::uuid, ${req.body.name}) returning id`);
      let faces = { labelled: 0, applied: 0 };
      if (req.body.clusterId) {
        const [uc] = await rows<{ face_ids: string[] }>(tx, sql`select array(select f.id from faces f where f.id = any(uc.face_ids) and f.blob_id in ${visibleBlobIds(v)}) as face_ids from unknown_clusters uc where uc.id = ${req.body.clusterId}::uuid`);
        if (!uc) throw notFound('Cluster not found');
        faces = await confirmFaces(tx, v, uc.face_ids, p!.id);
        await tx.execute(sql`update unknown_clusters set dismissed = true where id = ${req.body.clusterId}::uuid`);
      }
      await enqueue(tx, 'identify', { groupId: v.groupId, personId: p!.id }, { runAfterSeconds: 30 });
      await audit(tx, v, 'person.create', { type: 'person', id: String(p!.id) }, { name: req.body.name, clusterId: req.body.clusterId ?? null, faces }, req);
      return { id: p!.id, name: req.body.name, faces };
    });
    return reply.status(201).send(out);
  });

  r.patch('/v1/people/:id', { schema: { params: PID, body: z.object({ name: z.string().min(1).max(100).optional(), hidden: z.boolean().optional(), mergeInto: z.number().int().optional() }) } }, async (req) => {
    const { ctx: v, found: p } = await req.ctxWhere((tx, c) => findPerson(tx, c, req.params.id));
    return withViewer(ctx.db, v, async (tx) => {
      if (req.body.mergeInto !== undefined) {
        if (p.user_id) throw badRequest('A member-linked person cannot be merged away');
        const target = await findPerson(tx, v, req.body.mergeInto);
        if (!target) throw badRequest('Unknown target person');
        const faceIds = (await rows<{ id: string }>(tx, sql`select id from faces where person_id = ${p.id}`)).map((f) => f.id);
        const faces = await confirmFaces(tx, v, faceIds, target.id);
        await tx.execute(sql`update event_person_tags set person_id = ${target.id} where person_id = ${p.id} and not exists (select 1 from event_person_tags t2 where t2.event_id = event_person_tags.event_id and t2.person_id = ${target.id})`);
        const deleted = await rows<{ id: number }>(tx, sql`delete from persons where id = ${p.id} returning id`);
        if (!deleted.length) await tx.execute(sql`update persons set hidden = true, name = ${`(merged) ${p.name ?? ''}`} where id = ${p.id}`);
        await enqueue(tx, 'identify', { groupId: v.groupId, personId: target.id }, { runAfterSeconds: 30 });
        await audit(tx, v, 'person.merge', { type: 'person', id: String(p.id) }, { into: target.id, faces }, req);
        return { id: target.id, mergedFrom: p.id, faces };
      }
      if (req.body.name !== undefined) await tx.execute(sql`update persons set name = ${req.body.name} where id = ${p.id}`);
      if (req.body.hidden !== undefined) await tx.execute(sql`update persons set hidden = ${req.body.hidden} where id = ${p.id}`);
      await audit(tx, v, 'person.update', { type: 'person', id: String(p.id) }, req.body, req);
      const after = await findPerson(tx, v, p.id);
      return { id: p.id, name: after?.name ?? null, hidden: after?.hidden ?? false, userId: after?.user_id ?? null };
    });
  });

  /** §5.3 Enrollment: 3–5 reference photos (or explicit face ids) become the first confirmed faces. */
  r.post('/v1/people/:id/enroll', { schema: { params: PID, body: z.object({ assetIds: z.array(z.string().uuid()).max(20).optional(), faceIds: z.array(z.string().uuid()).max(50).optional() }) } }, async (req) => {
    const { ctx: v, found: p } = await req.ctxWhere((tx, c) => findPerson(tx, c, req.params.id));
    if (p.user_id && p.user_id !== v.userId && v.role !== 'owner') throw forbidden('Only that member can enroll their own identity');
    return withViewer(ctx.db, v, async (tx) => {
      let faceIds = req.body.faceIds ?? [];
      if (req.body.assetIds?.length) {
        // The largest face on each reference photo is the person.
        const found = await rows<{ id: string }>(tx, sql`select distinct on (f.blob_id) f.id from assets a join faces f on f.blob_id = a.blob_id
          where a.id = any(${uuidArr(req.body.assetIds)}) and ${visibleAssetsWhere(v, A)} order by f.blob_id, ((f.box->>'w')::float * (f.box->>'h')::float) desc`);
        faceIds = [...new Set([...faceIds, ...found.map((f) => f.id)])];
      }
      if (!faceIds.length) throw badRequest('No faces found on the reference photos yet; they may still be analyzing');
      const faces = await confirmFaces(tx, v, faceIds, p.id);
      if (p.user_id === v.userId) await tx.execute(sql`update group_members set consent_faces_at = coalesce(consent_faces_at, now()) where group_id = ${v.groupId}::uuid and user_id = ${v.userId}::uuid`);
      await enqueue(tx, 'identify', { groupId: v.groupId, personId: p.id }, { runAfterSeconds: 5 });
      await audit(tx, v, 'person.enroll', { type: 'person', id: String(p.id) }, { faces }, req);
      return { personId: p.id, ...faces, queued: 'identify' };
    });
  });

  r.get('/v1/groups/:g/review', { schema: { params: G } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const unnamed = await rows<{ id: string; n: number; cover_face_id: string | null; visible_faces: string[] }>(tx, sql`select uc.id, uc.n, uc.cover_face_id,
          array(select f.id from faces f where f.id = any(uc.face_ids) and f.blob_id in ${visibleBlobIds(v)}) as visible_faces
        from unknown_clusters uc where uc.group_id = ${v.groupId}::uuid and not uc.dismissed order by uc.n desc limit 50`);
      const low = await rows<{ id: string; blob_id: string; box: unknown; person_id: number; name: string | null; tier: string; match_score: number | null }>(tx, sql`
        select f.id, f.blob_id, f.box, f.person_id, p.name, f.tier, f.match_score from faces f join persons p on p.id = f.person_id
        where f.group_id = ${v.groupId}::uuid and f.tier in ('low', 'probable') and f.blob_id in ${visibleBlobIds(v)}
          and not exists (select 1 from face_labels fl where fl.face_id = f.id and fl.person_id = f.person_id)
        order by f.match_score desc nulls last limit 100`);
      const splits = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(v)} and cardinality(e.suggested_splits) > 0 order by e.start_at desc limit 50`);
      return {
        unnamedClusters: unnamed.filter((u) => u.visible_faces.length).map((u) => ({ id: u.id, n: u.n, coverFaceId: u.cover_face_id, faceIds: u.visible_faces })),
        lowConfidenceFaces: low.map((f) => ({ id: f.id, blobId: f.blob_id, box: f.box, personId: f.person_id, personName: f.name, matchScore: f.match_score, tier: f.tier })),
        suggestedSplits: splits.map((e) => ({ eventId: e.id, title: toEventCard(e).title, at: (e.suggested_splits ?? []).map((d) => d.toISOString()) })),
      };
    });
  });

  r.post('/v1/groups/:g/review/clusters/:clusterId/dismiss', { schema: { params: G.extend({ clusterId: z.string().uuid() }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const done = await rows<{ id: string }>(tx, sql`update unknown_clusters set dismissed = true where id = ${req.params.clusterId}::uuid and group_id = ${v.groupId}::uuid returning id`);
      if (!done.length) throw notFound('Cluster not found');
      await audit(tx, v, 'cluster.dismiss', { type: 'cluster', id: req.params.clusterId }, null, req);
      return { id: req.params.clusterId, dismissed: true };
    });
  });

  /** Face crops are the one thing streamed through the API (review queue <img> tags with credentials). */
  r.get('/v1/faces/:id/crop', { schema: { params: z.object({ id: z.string().uuid() }) }, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { found } = await req.ctxWhere(async (tx) => {
      const [f] = await rows<{ id: string; crop_key: string | null }>(tx, sql`select id, crop_key from faces where id = ${req.params.id}::uuid`);
      return f;
    });
    if (!found.crop_key) throw notFound('No crop for this face yet');
    const obj = await ctx.storage.getObject(found.crop_key);
    if (!obj) throw notFound('Crop missing in storage');
    reply.header('content-type', obj.contentType).header('cache-control', 'private, max-age=3600');
    if (obj.contentLength) reply.header('content-length', String(obj.contentLength));
    return reply.send(obj.body);
  });

  r.post('/v1/faces/:id/label', { schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ personId: z.number().int(), verdict: z.enum(['confirm', 'reject']) }) } }, async (req) => {
    const { ctx: v, found: f } = await req.ctxWhere(async (tx) => {
      const [f] = await rows<{ id: string; blob_id: string; person_id: number | null }>(tx, sql`select id, blob_id, person_id from faces where id = ${req.params.id}::uuid`);
      return f;
    });
    return withViewer(ctx.db, v, async (tx) => {
      const p = await findPerson(tx, v, req.body.personId);
      if (!p) throw badRequest('Unknown person');
      let applied = 0;
      if (req.body.verdict === 'confirm') {
        applied = (await confirmFaces(tx, v, [f.id], p.id)).applied;
      } else {
        await tx.execute(sql`insert into face_labels (face_id, person_id, verdict, by_user_id) values (${f.id}::uuid, ${p.id}, 'reject', ${v.userId}::uuid)
          on conflict (face_id, person_id) do update set verdict = 'reject', by_user_id = excluded.by_user_id, created_at = now()`);
        if (f.person_id === p.id) applied = (await rows<{ id: string }>(tx, sql`update faces set person_id = null, tier = null, match_source = null where id = ${f.id}::uuid returning id`)).length;
      }
      await enqueue(tx, 'identify', { groupId: v.groupId, blobId: f.blob_id }, { runAfterSeconds: 2 });
      await audit(tx, v, `face.${req.body.verdict}`, { type: 'face', id: f.id }, { personId: p.id, applied }, req);
      return { faceId: f.id, personId: p.id, verdict: req.body.verdict, applied: applied > 0, queued: 'identify' };
    });
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, enqueue, sql, encodeCursor, decodeCursor, WBS, INTEREST, visibleEventsWhere, visibleAssetsWhere, events, assets, type ViewerCtx, type Tx } from '../deps.js';
import { audit } from '../audit.js';
import { forbidden, badRequest, notFound } from '../errors.js';
import { rows, iso, EVENT_COLUMNS, MEDIA_COLUMNS, toEventCard, eventTitle, toMediaItem, confidenceKey, titleSql, visibleEventsFrom, type EventRow, type MediaRow, E, A, eventRows, mediaRows, uuidArr, intArr, ts } from '../dto.js';

const G = z.object({ g: z.string().uuid() });
const ID = z.object({ id: z.string().uuid() });
const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

/** Look up one visible event by id in the viewer's scope. */
export async function findEvent(tx: Tx, ctx: ViewerCtx, id: string): Promise<EventRow | undefined> {
  const [e] = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(ctx)} and e.id = ${id}::uuid`);
  return e;
}

async function reclusterAround(tx: Tx, groupId: string, from: Date, to: Date) {
  await enqueue(tx, 'recluster', { groupId, from: new Date(from.getTime() - WBS.reclusterPadHours * 3600_000).toISOString(), to: new Date(to.getTime() + WBS.reclusterPadHours * 3600_000).toISOString() }, { runAfterSeconds: WBS.reclusterDebounceSeconds });
}

export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/groups/:g/events', { schema: { params: G, querystring: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), people: csv.optional(), peopleMode: z.enum(['all', 'any']).default('all'), place: z.string().uuid().optional(), contributor: z.string().uuid().optional(), kind: z.enum(['event', 'trip', 'loose']).optional(), quiet: z.enum(['hide', 'only', 'all']).default('hide'), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    const q = req.query;
    const cur = decodeCursor<{ s: string; id: string }>(q.cursor);
    const people = q.people?.map(Number).filter((n) => Number.isInteger(n)) ?? [];
    // §9.11 quiet events: scored below INTEREST.quiet (unscored events stay visible), folded out of the river by default
    const quietWhere = sql`(e.interest is not null and e.interest < ${INTEREST.quiet})`;
    const quietFilter = q.quiet === 'hide' ? sql`and not ${quietWhere}` : q.quiet === 'only' ? sql`and ${quietWhere}` : sql``;
    const filters = sql`
        ${q.kind ? sql`and e.kind = ${q.kind}` : sql`and e.kind <> 'loose'`}
        ${q.from ? sql`and e.end_at >= ${ts(q.from)}` : sql``} ${q.to ? sql`and e.start_at <= ${ts(q.to)}` : sql``}
        ${people.length ? (q.peopleMode === 'any' ? sql`and e.person_ids && ${intArr(people)}` : sql`and e.person_ids @> ${intArr(people)}`) : sql``}
        ${q.place ? sql`and e.place_id = ${q.place}::uuid` : sql``} ${q.contributor ? sql`and ${q.contributor}::uuid = any(e.contributor_ids)` : sql``}`;
    return withViewer(ctx.db, v, async (tx) => {
      const list = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(v)} ${filters} ${quietFilter}
        ${cur ? sql`and (e.start_at, e.id) < (${cur.s}::timestamptz, ${cur.id}::uuid)` : sql``}
        order by e.start_at desc, e.id desc limit ${q.limit + 1}`);
      const page = list.slice(0, q.limit);
      const last = page[page.length - 1];
      // first page only: how many events the default view folds away, so the UI can offer them
      const quietCount = q.quiet === 'hide' && !cur
        ? (await rows<{ n: number }>(tx, sql`select count(*)::int as n from events e left join places p on p.id = e.place_id where ${visibleEventsWhere(v, E)} ${filters} and ${quietWhere}`))[0]?.n ?? 0
        : null;
      return { items: page.map((e) => toEventCard(e, req.locale)), nextCursor: list.length > q.limit && last ? encodeCursor({ s: last.start_at.toISOString(), id: last.id }) : null, quietCount };
    });
  });

  r.get('/v1/groups/:g/timeline', { schema: { params: G, querystring: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tz: z.string().default('UTC') }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const dayStart = sql`(${req.query.day}::date::timestamp at time zone ${req.query.tz})`;
      const dayEnd = sql`((${req.query.day}::date + 1)::timestamp at time zone ${req.query.tz})`;
      const evs = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(v)} and e.end_at >= ${dayStart} and e.start_at < ${dayEnd} order by e.start_at`);
      const loose = await mediaRows(tx, sql`select ${MEDIA_COLUMNS} from assets a join blobs b on b.id = a.blob_id
        where ${visibleAssetsWhere(v, A)} and b.captured_at >= ${dayStart} and b.captured_at < ${dayEnd}
          and not exists (select 1 from event_assets ea join events e on e.id = ea.event_id where ea.asset_id = a.id and e.kind <> 'loose' and e.deleted_at is null)
        order by b.captured_at limit 500`);
      return { day: req.query.day, events: evs.map((e) => toEventCard(e, req.locale)), loose: loose.map(toMediaItem) };
    });
  });

  /**
   * Everything the timeline explorer needs in one round trip: every visible event (all kinds, quiet ones too) as a
   * compact row, newest first. A friend group produces a few thousand events over years, which fits comfortably.
   */
  r.get('/v1/groups/:g/timeline/overview', { schema: { params: G, querystring: z.object({ limit: z.coerce.number().int().min(1).max(20000).default(8000) }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const list = await rows<EventRow & { city: string | null }>(tx, sql`select ${EVENT_COLUMNS}, p.city ${visibleEventsFrom(v)} order by e.start_at desc, e.id desc limit ${req.query.limit}`);
      const items = list.map((r) => ({
        id: r.id, kind: r.kind, title: eventTitle({ ...r, start_at: new Date(r.start_at) }, req.locale),
        startAt: iso(r.start_at)!, endAt: iso(r.end_at)!,
        center: r.center_lat !== null && r.center_lon !== null ? { lat: r.center_lat, lon: r.center_lon } : null,
        placeName: r.place_name, city: r.city, contributorIds: r.contributor_ids, personIds: r.person_ids,
        nAssets: r.n_assets, nVideos: r.n_videos, coverBlobId: r.cover_blob_id, isPublicToGroup: r.is_public_to_group, interest: r.interest,
      }));
      return { items, span: items.length ? { from: items[items.length - 1]!.startAt, to: items[0]!.endAt } : null };
    });
  });

  /** Event pins (with enough to draw a photo marker) plus geotagged loose media points, both in the viewer's scope. */
  r.get('/v1/groups/:g/map', { schema: { params: G, querystring: z.object({ bbox: z.string().regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), loose: z.coerce.boolean().default(true) }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    const bb = req.query.bbox?.split(',').map(Number) as [number, number, number, number] | undefined;
    return withViewer(ctx.db, v, async (tx) => {
      const pins = await rows<{ id: string; kind: 'event' | 'trip' | 'loose'; title: string | null; lat: number; lon: number; n_assets: number; n_videos: number; start_at: Date; end_at: Date; cover_blob_id: string | null; person_ids: number[]; contributor_ids: string[]; place_name: string | null; city: string | null }>(tx, sql`
        select e.id, e.kind, ${titleSql(req.locale)} as title, e.center_lat as lat, e.center_lon as lon, e.n_assets, e.n_videos, e.start_at, e.end_at, e.cover_blob_id, e.person_ids, e.contributor_ids, p.name as place_name, p.city
        from events e left join places p on p.id = e.place_id where ${visibleEventsWhere(v, E)} and e.center_lat is not null and e.kind <> 'loose'
        ${bb ? sql`and e.center_lat between ${bb[1]} and ${bb[3]} and e.center_lon between ${bb[0]} and ${bb[2]}` : sql``}
        ${req.query.from ? sql`and e.end_at >= ${ts(req.query.from)}` : sql``} ${req.query.to ? sql`and e.start_at <= ${ts(req.query.to)}` : sql``}
        order by e.start_at desc limit 2000`);
      const items = pins.map((p) => ({
        id: p.id, kind: p.kind, title: p.title ?? iso(p.start_at)!.slice(0, 10), lat: p.lat, lon: p.lon, nAssets: p.n_assets, nVideos: p.n_videos,
        startAt: iso(p.start_at)!, endAt: iso(p.end_at)!, coverBlobId: p.cover_blob_id, personIds: p.person_ids ?? [], contributorIds: p.contributor_ids ?? [], placeName: p.place_name, city: p.city,
      }));
      // Loose photos with a location: the small dots between the pins. Same visibility predicate as everywhere else.
      const loose = req.query.loose ? await mediaRows(tx, sql`select ${MEDIA_COLUMNS} from assets a join blobs b on b.id = a.blob_id
        where ${visibleAssetsWhere(v, A)} and b.lat is not null and b.lon is not null and a.deleted_at is null
          and not exists (select 1 from event_assets ea join events e on e.id = ea.event_id where ea.asset_id = a.id and e.kind <> 'loose' and e.deleted_at is null)
          ${bb ? sql`and b.lat between ${bb[1]} and ${bb[3]} and b.lon between ${bb[0]} and ${bb[2]}` : sql``}
          ${req.query.from ? sql`and b.captured_at >= ${ts(req.query.from)}` : sql``} ${req.query.to ? sql`and b.captured_at <= ${ts(req.query.to)}` : sql``}
        order by b.captured_at desc limit 3000`) : [];
      return { items, pins: items, loose: loose.map(toMediaItem) };
    });
  });

  r.get('/v1/events/:id', { schema: { params: ID } }, async (req) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    return withViewer(ctx.db, v, async (tx) => {
      const moments = await rows<{ id: string; start_at: Date; end_at: Date; label: string | null; n_assets: number; blob_ids: string[] }>(tx, sql`select id, start_at, end_at, label, n_assets, blob_ids from moments where event_id = ${e.id}::uuid order by start_at`);
      const participants = e.person_ids.length ? await rows<{ id: number; name: string | null; user_id: string | null; cover_face_id: string | null; hidden: boolean }>(tx, sql`select id, name, user_id, cover_face_id, hidden from persons where id = any(${intArr(e.person_ids)}) order by name`) : [];
      const contributors = await rows<{ user_id: string; display_name: string; n: number }>(tx, sql`select a.owner_user_id as user_id, u.display_name, count(*)::int as n from event_assets ea join assets a on a.id = ea.asset_id join users u on u.id = a.owner_user_id where ea.event_id = ${e.id}::uuid and a.deleted_at is null group by 1, 2 order by n desc`);
      return {
        ...toEventCard(e, req.locale),
        moments: moments.map((m) => ({ id: m.id, startAt: iso(m.start_at)!, endAt: iso(m.end_at)!, label: m.label, nAssets: m.n_assets, blobIds: m.blob_ids })),
        participants: participants.map((p) => ({ id: p.id, name: p.name, userId: p.user_id, coverFaceId: p.cover_face_id, hidden: p.hidden })),
        contributors: contributors.map((c) => ({ userId: c.user_id, displayName: c.display_name, nAssets: c.n })),
        suggestedSplits: (e.suggested_splits ?? []).map((d) => d.toISOString()),
        confidenceKey: confidenceKey(e.confidence, e.suggested_splits?.length ?? 0),
      };
    });
  });

  r.get('/v1/events/:id/media', { schema: { params: ID, querystring: z.object({ tier: z.enum(['confirmed', 'probable', 'uncertain']).optional(), person: z.coerce.number().int().optional(), type: z.enum(['photo', 'video']).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) } }, async (req) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    const q = req.query;
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    return withViewer(ctx.db, v, async (tx) => {
      const list = await mediaRows(tx, sql`select ${MEDIA_COLUMNS}, ea.event_id, ea.confidence as ea_confidence, ea.tier as ea_tier, ea.source as ea_source
        from event_assets ea join assets a on a.id = ea.asset_id join blobs b on b.id = a.blob_id
        where ea.event_id = ${e.id}::uuid and a.deleted_at is null
        ${q.tier ? sql`and ea.tier = ${q.tier}` : sql``}
        ${q.person !== undefined ? sql`and a.person_ids @> array[${q.person}]::int[]` : sql``}
        ${q.type === 'video' ? sql`and b.duration_ms is not null` : q.type === 'photo' ? sql`and b.duration_ms is null` : sql``}
        ${cur ? sql`and (coalesce(b.captured_at, 'epoch'::timestamptz), a.id) > (${cur.t}::timestamptz, ${cur.id}::uuid)` : sql``}
        order by coalesce(b.captured_at, 'epoch'::timestamptz), a.id limit ${q.limit + 1}`);
      const page = list.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(toMediaItem), nextCursor: list.length > q.limit && last ? encodeCursor({ t: (last.captured_at ?? new Date(0)).toISOString(), id: last.asset_id }) : null };
    });
  });

  r.patch('/v1/events/:id', { schema: { params: ID, body: z.object({ title: z.string().max(200).nullable().optional(), frozen: z.boolean().optional(), startAt: z.coerce.date().optional(), endAt: z.coerce.date().optional(), coverBlobId: z.string().uuid().nullable().optional(), interest: z.enum(['keep', 'quiet', 'auto']).optional() }) } }, async (req) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    const b = req.body;
    const isContributor = e.contributor_ids.includes(v.userId);
    if ((b.frozen !== undefined || b.startAt || b.endAt) && !isContributor) throw forbidden('boundary_edits_contributors_only', 'Boundary edits are for contributors');
    return withViewer(ctx.db, v, async (tx) => {
      if (b.title !== undefined) await tx.execute(sql`update events set title_manual = ${b.title} where id = ${e.id}::uuid`);
      if (b.coverBlobId !== undefined) await tx.execute(sql`update events set cover_blob_id = ${b.coverBlobId}::uuid where id = ${e.id}::uuid`);
      if (b.interest !== undefined) {
        // apply immediately so the feed reacts; the titles job re-scores with the same override and updates the place's routine factor
        const manual = b.interest === 'keep' ? 1 : b.interest === 'quiet' ? -1 : null;
        const now = manual === 1 ? Math.max(e.interest ?? 0, INTEREST.manualHigh) : manual === -1 ? Math.min(e.interest ?? 1, INTEREST.manualLow) : e.interest;
        await tx.execute(sql`update events set interest_manual = ${manual}, interest = ${now} where id = ${e.id}::uuid`);
        await enqueue(tx, 'titles', { groupId: v.groupId, eventIds: [e.id] }, { runAfterSeconds: 2 });
      }
      if (b.frozen !== undefined) {
        await tx.execute(sql`update events set frozen = ${b.frozen} where id = ${e.id}::uuid`);
        if (b.frozen) await tx.execute(sql`insert into event_constraints (group_id, kind, event_id, by_user_id) values (${v.groupId}::uuid, 'frozen', ${e.id}::uuid, ${v.userId}::uuid)`);
        else await tx.execute(sql`delete from event_constraints where kind = 'frozen' and event_id = ${e.id}::uuid`);
      }
      if (b.startAt || b.endAt) {
        for (const at of [b.startAt, b.endAt].filter((d): d is Date => !!d)) await tx.execute(sql`insert into event_constraints (group_id, kind, event_id, at, by_user_id) values (${v.groupId}::uuid, 'pin_boundary', ${e.id}::uuid, ${ts(at)}, ${v.userId}::uuid)`);
        await reclusterAround(tx, v.groupId, b.startAt ?? e.start_at, b.endAt ?? e.end_at);
      }
      await audit(tx, v, 'event.update', { type: 'event', id: e.id }, b as Record<string, unknown>, req);
      const updated = await findEvent(tx, v, e.id);
      return toEventCard(updated ?? e, req.locale);
    });
  });

  const setOpen = (open: boolean) => async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    if (!e.contributor_ids.includes(v.userId)) throw forbidden('open_close_contributors_only', 'Only contributors can open or close an event');
    return withViewer(ctx.db, v, async (tx) => {
      await tx.execute(open
        ? sql`update events set is_public_to_group = true, opened_by_user_id = ${v.userId}::uuid, opened_at = now() where id = ${e.id}::uuid`
        : sql`update events set is_public_to_group = false, opened_by_user_id = null, opened_at = null where id = ${e.id}::uuid`);
      await audit(tx, v, open ? 'event.open' : 'event.close', { type: 'event', id: e.id }, { nAssets: e.n_assets, contributors: e.contributor_ids }, req);
      return { id: e.id, isPublicToGroup: open, nAssets: e.n_assets, contributorIds: e.contributor_ids };
    });
  };
  r.post('/v1/events/:id/open', { schema: { params: ID } }, setOpen(true));
  r.post('/v1/events/:id/close', { schema: { params: ID } }, setOpen(false));

  r.get('/v1/events/:id/visibility', { schema: { params: ID } }, async (req) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    return withViewer(ctx.db, v, async (tx) => {
      const members = await rows<{ user_id: string; display_name: string; person_id: number | null }>(tx, sql`select gm.user_id, u.display_name, p.id as person_id from group_members gm join users u on u.id = gm.user_id left join persons p on p.group_id = gm.group_id and p.user_id = gm.user_id where gm.group_id = ${v.groupId}::uuid`);
      const tagged = new Set((await rows<{ person_id: number }>(tx, sql`select person_id from event_person_tags where event_id = ${e.id}::uuid`)).map((t) => t.person_id));
      const faced = new Set((await rows<{ person_id: number }>(tx, sql`select distinct f.person_id from event_assets ea join faces f on f.blob_id = ea.blob_id where ea.event_id = ${e.id}::uuid and f.person_id is not null and f.tier in ('confirmed','high','probable')`)).map((t) => t.person_id));
      const opener = e.opened_by_user_id ? members.find((m) => m.user_id === e.opened_by_user_id) : null;
      const viewers = members.map((m) => {
        const reasons: Array<'contributor' | 'face' | 'tag' | 'opened'> = [];
        if (e.contributor_ids.includes(m.user_id)) reasons.push('contributor');
        if (m.person_id !== null && faced.has(m.person_id)) reasons.push('face');
        if (m.person_id !== null && tagged.has(m.person_id)) reasons.push('tag');
        if (e.is_public_to_group) reasons.push('opened');
        return { userId: m.user_id, displayName: m.display_name, reasons };
      }).filter((x) => x.reasons.length);
      return { viewers, isPublicToGroup: e.is_public_to_group, openedBy: opener && e.opened_at ? { userId: opener.user_id, displayName: opener.display_name, at: e.opened_at.toISOString() } : null };
    });
  });

  r.post('/v1/events/:id/tags', { schema: { params: ID, body: z.object({ personId: z.number().int() }) } }, async (req, reply) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    await withViewer(ctx.db, v, async (tx) => {
      const [p] = await rows<{ id: number }>(tx, sql`select id from persons where id = ${req.body.personId} and group_id = ${v.groupId}::uuid`);
      if (!p) throw badRequest('unknown_person', 'Unknown person');
      await tx.execute(sql`insert into event_person_tags (event_id, person_id, by_user_id) values (${e.id}::uuid, ${req.body.personId}, ${v.userId}::uuid) on conflict do nothing`);
      await audit(tx, v, 'event.tag', { type: 'event', id: e.id }, { personId: req.body.personId }, req);
    });
    return reply.status(201).send({ eventId: e.id, personId: req.body.personId });
  });

  r.delete('/v1/events/:id/tags/:personId', { schema: { params: ID.extend({ personId: z.coerce.number().int() }) } }, async (req, reply) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    await withViewer(ctx.db, v, async (tx) => {
      await tx.execute(sql`delete from event_person_tags where event_id = ${e.id}::uuid and person_id = ${req.params.personId}`);
      await audit(tx, v, 'event.untag', { type: 'event', id: e.id }, { personId: req.params.personId }, req);
    });
    return reply.status(204).send();
  });

  r.post('/v1/events/:id/split', { schema: { params: ID, body: z.object({ at: z.coerce.date() }) } }, async (req, reply) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    if (!e.contributor_ids.includes(v.userId)) throw forbidden('split_contributors_only', 'Only contributors can split an event');
    if (req.body.at <= e.start_at || req.body.at >= e.end_at) throw badRequest('split_point_outside_event', 'Split point must be inside the event');
    await withViewer(ctx.db, v, async (tx) => {
      await tx.execute(sql`insert into event_constraints (group_id, kind, event_id, at, by_user_id) values (${v.groupId}::uuid, 'pin_boundary', ${e.id}::uuid, ${ts(req.body.at)}, ${v.userId}::uuid)`);
      await tx.execute(sql`update events set suggested_splits = array_remove(suggested_splits, ${ts(req.body.at)}) where id = ${e.id}::uuid`);
      await reclusterAround(tx, v.groupId, e.start_at, e.end_at);
      await audit(tx, v, 'event.split', { type: 'event', id: e.id }, { at: req.body.at.toISOString() }, req);
    });
    return reply.status(202).send({ status: 'queued', eventId: e.id, at: req.body.at.toISOString() });
  });

  r.post('/v1/events/:id/merge', { schema: { params: ID, body: z.object({ withEventId: z.string().uuid() }) } }, async (req, reply) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    if (!e.contributor_ids.includes(v.userId)) throw forbidden('merge_contributors_only', 'Only contributors can merge events');
    return withViewer(ctx.db, v, async (tx) => {
      const other = await findEvent(tx, v, req.body.withEventId);
      if (!other) throw notFound('event_not_found', 'Event not found');
      const ids = (await rows<{ asset_id: string }>(tx, sql`select asset_id from event_assets where event_id in (${e.id}::uuid, ${other.id}::uuid)`)).map((x) => x.asset_id);
      await tx.execute(sql`insert into event_constraints (group_id, kind, event_id, asset_ids, by_user_id) values (${v.groupId}::uuid, 'keep_together', ${e.id}::uuid, ${uuidArr(ids)}, ${v.userId}::uuid)`);
      if (e.is_public_to_group || other.is_public_to_group) await tx.execute(sql`update events set is_public_to_group = true where id in (${e.id}::uuid, ${other.id}::uuid)`);
      const from = new Date(Math.min(e.start_at.getTime(), other.start_at.getTime())), to = new Date(Math.max(e.end_at.getTime(), other.end_at.getTime()));
      await reclusterAround(tx, v.groupId, from, to);
      const contributors = [...new Set([...e.contributor_ids, ...other.contributor_ids])], persons = [...new Set([...e.person_ids, ...other.person_ids])];
      await audit(tx, v, 'event.merge', { type: 'event', id: e.id }, { withEventId: other.id }, req);
      return reply.status(202).send({ status: 'queued', eventId: e.id, withEventId: other.id, contributorIds: contributors, personIds: persons, widensVisibility: contributors.length > e.contributor_ids.length || persons.length > e.person_ids.length });
    });
  });

  const ex = (kind: 'exclude' | 'include') => async (req: FastifyRequest<{ Params: { id: string }; Body: { assetIds: string[] } }>, reply: FastifyReply) => {
    const { ctx: v, found: e } = await req.ctxWhere((tx, c) => findEvent(tx, c, req.params.id));
    await withViewer(ctx.db, v, async (tx) => {
      const visible = await rows<{ id: string; blob_id: string }>(tx, sql`select a.id, a.blob_id from assets a where a.id = any(${uuidArr(req.body.assetIds)}) and ${visibleAssetsWhere(v, A)}`);
      if (!visible.length) throw badRequest('no_assets_in_scope', 'No such assets in your scope');
      const ids = visible.map((a) => a.id);
      await tx.execute(sql`insert into event_constraints (group_id, kind, event_id, asset_ids, by_user_id) values (${v.groupId}::uuid, ${kind}, ${e.id}::uuid, ${uuidArr(ids)}, ${v.userId}::uuid)`);
      if (kind === 'exclude') await tx.execute(sql`delete from event_assets where event_id = ${e.id}::uuid and asset_id = any(${uuidArr(ids)})`);
      else for (const a of visible) await tx.execute(sql`insert into event_assets (event_id, asset_id, blob_id, confidence, tier, source) values (${e.id}::uuid, ${a.id}::uuid, ${a.blob_id}::uuid, 1, 'confirmed', 'manual') on conflict (event_id, asset_id) do update set tier = 'confirmed', source = 'manual', confidence = 1`);
      await reclusterAround(tx, v.groupId, e.start_at, e.end_at);
      await audit(tx, v, `event.${kind}`, { type: 'event', id: e.id }, { assetIds: ids }, req);
    });
    return reply.status(202).send({ status: 'applied', eventId: e.id, assetIds: req.body.assetIds });
  };
  r.post('/v1/events/:id/exclude', { schema: { params: ID, body: z.object({ assetIds: z.array(z.string().uuid()).min(1).max(500) }) } }, ex('exclude'));
  r.post('/v1/events/:id/include', { schema: { params: ID, body: z.object({ assetIds: z.array(z.string().uuid()).min(1).max(500) }) } }, ex('include'));
}

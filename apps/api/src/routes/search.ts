import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, sql, visibleEventsWhere, visibleAssetsWhere, events, assets, type SearchChip } from '../deps.js';
import { rows, EVENT_COLUMNS, MEDIA_COLUMNS, toEventCard, toMediaItem, titleSql, visibleEventsFrom, type EventRow, type MediaRow, E, A, eventRows, mediaRows, intArr, ts } from '../dto.js';
import { parseQuery } from '../search/parser.js';
import { textEmbedding } from '../search/embed.js';

const G = z.object({ g: z.string().uuid() });

export async function searchRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/groups/:g/search', { schema: { params: G, querystring: z.object({ q: z.string().max(300).default(''), mode: z.enum(['events', 'media']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const people = await rows<{ id: number; name: string | null }>(tx, sql`select id, name from persons where group_id = ${v.groupId}::uuid and not hidden and name is not null`);
      const { query, chips } = await parseQuery(req.query.q, {
        people: people.map((p) => ({ id: p.id, name: p.name!, aliases: p.name!.includes(' ') ? [p.name!.split(' ')[0]!] : [] })),
        mePersonId: v.personId,
        mode: req.query.mode,
        matchEventTitle: async (t) => {
          const title = titleSql(req.locale);
          const [hit] = await rows<{ id: string; title: string; score: number }>(tx, sql`select e.id, ${title} as title, similarity(${title}, ${t}) as score
            from events e where ${visibleEventsWhere(v, E)} and ${title} is not null and similarity(${title}, ${t}) >= 0.35 order by score desc limit 1`);
          return hit ?? null;
        },
      });
      const all = query.people?.all ?? [];
      const timeEvents = query.time ? sql`and e.end_at >= ${ts(query.time.from ?? new Date(0))} and e.start_at <= ${ts(query.time.to ?? new Date(4102444800000))}` : sql``;

      if (query.mode === 'events') {
        const list = await eventRows(tx, sql`select ${EVENT_COLUMNS} ${visibleEventsFrom(v)} and e.kind <> 'loose'
          ${all.length ? sql`and e.person_ids @> ${intArr(all)}` : sql``} ${timeEvents}
          ${query.eventId ? sql`and e.id = ${query.eventId}::uuid` : sql``}
          ${query.mediaType === 'video' ? sql`and e.n_videos > 0` : sql``}
          order by e.start_at desc limit ${req.query.limit}`);
        return { parsed: chips, query, mode: 'events' as const, events: list.map((e) => toEventCard(e, req.locale)) };
      }

      // media mode: people via faces on the asset OR via event participation ("from an event with Emma")
      const peopleTerm = all.length
        ? sql`and (a.person_ids @> ${intArr(all)} or exists (select 1 from event_assets ea2 join events e2 on e2.id = ea2.event_id where ea2.asset_id = a.id and e2.deleted_at is null and e2.person_ids @> ${intArr(all)}))`
        : sql``;
      const timeMedia = query.time ? sql`and b.captured_at >= ${ts(query.time.from ?? new Date(0))} and b.captured_at < ${ts(query.time.to ?? new Date(4102444800000))}` : sql``;
      const eventTerm = query.eventId ? sql`and exists (select 1 from event_assets ea3 where ea3.asset_id = a.id and ea3.event_id = ${query.eventId}::uuid)` : sql``;
      const typeTerm = query.mediaType === 'video' ? sql`and b.duration_ms is not null` : query.mediaType === 'photo' ? sql`and b.duration_ms is null` : sql``;
      let vec: number[] | null = null;
      if (query.semantic) {
        vec = await textEmbedding(tx, ctx.cfg.ML_TEXT_EMBED_URL, query.semantic, req.log);
        if (!vec) chips.push({ kind: 'semantic', label: '(semantic ranking unavailable)', value: null, text: '' } satisfies SearchChip);
      }
      const order = vec ? sql`order by b.clip_emb <=> ${`[${vec.join(',')}]`}::vector nulls last, b.captured_at desc` : sql`order by b.captured_at desc nulls last`;
      const list = await mediaRows<MediaRow & { event_id: string | null }>(tx, sql`select ${MEDIA_COLUMNS},
          (select ea.event_id from event_assets ea join events e on e.id = ea.event_id where ea.asset_id = a.id and e.deleted_at is null order by ea.confidence desc limit 1) as event_id,
          null::real as ea_confidence, null::text as ea_tier, null::text as ea_source
        from assets a join blobs b on b.id = a.blob_id
        where ${visibleAssetsWhere(v, A)} and not b.is_utility ${peopleTerm} ${timeMedia} ${eventTerm} ${typeTerm}
        ${vec ? sql`and b.clip_emb is not null` : sql``}
        ${order} limit ${req.query.limit}`);
      const items = list.map((m) => ({ ...toMediaItem({ ...m, event_id: null }), eventId: m.event_id, viaEvent: all.length > 0 && !all.every((p) => (m.person_ids ?? []).includes(p)) }));
      return { parsed: chips, query, mode: 'media' as const, media: items };
    });
  });
}

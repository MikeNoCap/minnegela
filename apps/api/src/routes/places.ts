import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { withViewer, sql } from '../deps.js';
import { audit } from '../audit.js';
import { rows } from '../dto.js';

type PlaceRow = { id: string; name: string | null; city: string | null; lat: number; lon: number; radius_m: number; n_events: number; home_of_user_id: string | null; n_visible: number };
const cols = sql`p.id, p.name, p.city, p.lat, p.lon, p.radius_m, p.n_events, p.home_of_user_id`;
const toPlace = (p: PlaceRow) => ({ id: p.id, name: p.name, city: p.city, lat: p.lat, lon: p.lon, radiusM: p.radius_m, nEvents: p.n_visible, homeOfUserId: p.home_of_user_id });

export async function placeRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/groups/:g/places', { schema: { params: z.object({ g: z.string().uuid() }) } }, async (req) => {
    const v = await req.ctxFor(req.params.g);
    return withViewer(ctx.db, v, async (tx) => {
      const list = await rows<PlaceRow>(tx, sql`select ${cols},
          (select count(*)::int from events e where e.place_id = p.id and e.deleted_at is null and (${v.userId}::uuid = any(e.contributor_ids) or ${v.personId ?? -1} = any(e.person_ids) or e.is_public_to_group)) as n_visible
        from places p where p.group_id = ${v.groupId}::uuid order by n_visible desc, p.name`);
      return { items: list.filter((p) => p.n_visible > 0 || p.name).map(toPlace) };
    });
  });

  r.patch('/v1/places/:id', { schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ name: z.string().max(100).nullable() }) } }, async (req) => {
    const { ctx: v, found: p } = await req.ctxWhere(async (tx, c) => {
      const [p] = await rows<PlaceRow>(tx, sql`select ${cols}, 0 as n_visible from places p where p.id = ${req.params.id}::uuid and p.group_id = ${c.groupId}::uuid`);
      return p;
    });
    return withViewer(ctx.db, v, async (tx) => {
      await tx.execute(sql`update places set name = ${req.body.name} where id = ${p.id}::uuid`);
      await audit(tx, v, 'place.rename', { type: 'place', id: p.id }, { name: req.body.name }, req);
      return toPlace({ ...p, name: req.body.name });
    });
  });
}

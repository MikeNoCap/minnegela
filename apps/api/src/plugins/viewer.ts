import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, withViewer, groupMembers, persons, sessions, users, type Db, type Tx, type ViewerCtx } from '@minnegela/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../auth.js';
import { notFound, unauthorized } from '../errors.js';

export type AuthUser = { id: string; email: string; displayName: string };
export type Membership = { groupId: string; role: 'owner' | 'member'; personId: number | null; consentFacesAt: string | null };

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    /** Memberships of the signed-in user, resolved lazily. */
    memberships: () => Promise<Membership[]>;
    /** Viewer context for a group the user belongs to; 404 otherwise. */
    ctxFor: (groupId: string) => Promise<ViewerCtx & { role: 'owner' | 'member' }>;
    /** Find the viewer context in which `probe` returns truthy (entity routes); 404 otherwise. */
    ctxWhere: <T>(probe: (tx: Tx, ctx: ViewerCtx) => Promise<T | null | undefined>) => Promise<{ ctx: ViewerCtx & { role: 'owner' | 'member' }; found: T }>;
    requireUser: () => AuthUser;
  }
}

/** Set (or re-set) the per-transaction viewer settings, e.g. after creating a group inside a transaction. */
export async function setViewer(tx: Tx, ctx: ViewerCtx): Promise<void> {
  await tx.execute(sql`select set_config('app.group_id', ${ctx.groupId}, true), set_config('app.user_id', ${ctx.userId}, true), set_config('app.person_id', ${ctx.personId === null ? '' : String(ctx.personId)}, true)`);
}

async function resolveUser(auth: Auth, db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  try {
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (s?.user) return { id: s.user.id, email: s.user.email, displayName: s.user.name ?? '' };
  } catch (e) {
    req.log.debug({ err: e }, 'getSession failed');
  }
  // Raw session tokens (CLI, tests, mobile without the signed variant).
  const h = req.headers.authorization;
  if (h && h.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = h.slice(7).trim();
    const [row] = await db.select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(sessions).innerJoin(users, sql`${users.id} = ${sessions.userId}`)
      .where(sql`${sessions.token} = ${token} and ${sessions.expiresAt} > now()`).limit(1);
    if (row) return row;
  }
  return null;
}

export default fp(async function viewerPlugin(app: FastifyInstance, opts: { auth: Auth; db: Db }) {
  app.decorateRequest('user', null);
  app.decorateRequest('memberships', null as never);
  app.decorateRequest('ctxFor', null as never);
  app.decorateRequest('ctxWhere', null as never);
  app.decorateRequest('requireUser', null as never);

  app.addHook('onRequest', async (req) => {
    req.user = await resolveUser(opts.auth, opts.db, req);
    let cached: Membership[] | null = null;
    req.requireUser = () => { if (!req.user) throw unauthorized(); return req.user; };
    req.memberships = async () => {
      const user = req.requireUser();
      if (cached) return cached;
      cached = await withViewer(opts.db, { groupId: '', userId: user.id, personId: null }, async (tx) => {
        const rows = await tx.select({ groupId: groupMembers.groupId, role: groupMembers.role, consentFacesAt: groupMembers.consentFacesAt })
          .from(groupMembers).where(sql`${groupMembers.userId} = ${user.id}::uuid`);
        const out: Membership[] = [];
        for (const r of rows) {
          await tx.execute(sql`select set_config('app.group_id', ${r.groupId}, true)`);
          const [p] = await tx.select({ id: persons.id }).from(persons).where(sql`${persons.groupId} = ${r.groupId}::uuid and ${persons.userId} = ${user.id}::uuid`).limit(1);
          out.push({ groupId: r.groupId, role: r.role, personId: p?.id ?? null, consentFacesAt: r.consentFacesAt?.toISOString() ?? null });
        }
        return out;
      });
      return cached;
    };
    req.ctxFor = async (groupId: string) => {
      const user = req.requireUser();
      const m = (await req.memberships()).find((x) => x.groupId === groupId);
      if (!m) throw notFound('Group not found');
      return { groupId, userId: user.id, personId: m.personId, role: m.role };
    };
    req.ctxWhere = async (probe) => {
      const user = req.requireUser();
      for (const m of await req.memberships()) {
        const ctx = { groupId: m.groupId, userId: user.id, personId: m.personId, role: m.role };
        const found = await withViewer(opts.db, ctx, (tx) => probe(tx, ctx));
        if (found) return { ctx, found };
      }
      throw notFound();
    };
  });
});

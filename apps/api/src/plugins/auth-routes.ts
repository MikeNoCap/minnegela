import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth.js';

/** Mounts Better Auth's fetch handler under /v1/auth/*, bypassing Fastify's JSON parser. */
export async function authRoutes(app: FastifyInstance, opts: { auth: Auth }) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/v1/auth/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const url = new URL(req.url, `${req.protocol}://${req.headers.host ?? 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (req.body as Buffer | undefined);
      const res = await opts.auth.handler(new Request(url, { method: req.method, headers, body: body && body.length ? new Uint8Array(body) : undefined }));
      reply.status(res.status);
      res.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') return; reply.header(k, v); });
      const cookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
    },
  });
}

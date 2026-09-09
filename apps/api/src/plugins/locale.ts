import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_LOCALE, pickLocale, type Locale } from '@minnegela/shared';

declare module 'fastify' {
  interface FastifyRequest {
    /** Language for anything human-readable in the response (generated titles), from Accept-Language. */
    locale: Locale;
  }
}

export default fp(async function localePlugin(app: FastifyInstance) {
  app.decorateRequest('locale', DEFAULT_LOCALE);
  app.addHook('onRequest', async (req, reply) => {
    req.locale = pickLocale(req.headers['accept-language']);
    reply.header('content-language', req.locale);
  });
});

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createDb, type Db } from '@minnegela/db';
import { loadConfig, type Config } from './config.js';
import { createAuth, type Auth } from './auth.js';
import { StorageProvider } from './storage.js';
import { errorHandler } from './errors.js';
import localePlugin from './plugins/locale.js';
import viewerPlugin from './plugins/viewer.js';
import { authRoutes } from './plugins/auth-routes.js';
import { registerRoutes } from './routes/index.js';

export type AppContext = { cfg: Config; db: Db; auth: Auth; storage: StorageProvider };
export type App = FastifyInstance & { ctx: AppContext; closeDb: () => Promise<void> };

export async function buildApp(env: NodeJS.ProcessEnv = process.env, opts: { logger?: boolean | object } = {}): Promise<App> {
  const cfg = loadConfig(env);
  const app = Fastify({
    logger: opts.logger ?? (cfg.NODE_ENV === 'development' ? { level: cfg.LOG_LEVEL, transport: { target: 'pino-pretty' } } : { level: cfg.LOG_LEVEL }),
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  const handle = createDb(cfg.DATABASE_URL, { name: 'minnegela-api', max: 10 });
  const auth = createAuth(cfg, handle.db, app.log as never);
  const storage = new StorageProvider(cfg);
  const ctx: AppContext = { cfg, db: handle.db, auth, storage };

  await app.register(cors, { origin: [cfg.WEB_URL], credentials: true, exposedHeaders: ['set-auth-token'] });
  await app.register(cookie);
  // Key limits by session token when present: behind cloudflared + Caddy every client shares the
  // proxy's address, so an IP key would give the whole group one bucket.
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: '1 minute',
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `tok:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}` : req.ip;
    },
  });
  await app.register(swagger, {
    openapi: { info: { title: 'Minnegela API', version: '0.0.1' }, servers: [{ url: cfg.API_URL }] },
    transform: jsonSchemaTransform,
  });
  await app.register(localePlugin);
  await app.register(viewerPlugin, { auth, db: handle.db });
  await app.register(authRoutes, { auth });

  app.get('/v1/health', { config: { rateLimit: false } }, async () => ({ ok: true, time: new Date().toISOString() }));
  app.get('/v1/openapi.json', { config: { rateLimit: false } }, async () => app.swagger());
  await registerRoutes(app, ctx);

  app.addHook('onSend', async (_req, reply) => { reply.header('cache-control', 'private, no-store'); });
  app.addHook('onClose', async () => { await handle.close(); });

  const out = app as unknown as App;
  out.ctx = ctx;
  out.closeDb = handle.close;
  return out;
}

import { buildApp } from './app.js';

const app = await buildApp();
try {
  await app.listen({ port: app.ctx.cfg.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().then(() => process.exit(0)); });

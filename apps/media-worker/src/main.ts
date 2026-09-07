import os from 'node:os';
import { createDb, claimJobs, completeJob, failJob, releaseStaleJobs } from '@minnegela/db';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { log } from './log.js';
import { MEDIA_KINDS, handle } from './handlers.js';
import type { Ctx } from './context.js';

/** §13.2 consumer: claim with SKIP LOCKED, run up to `concurrency` jobs at once, back off when idle. */
export async function runWorker(opts: { once?: boolean } = {}) {
  const cfg = loadConfig();
  const dbh = createDb(cfg.databaseUrl, { max: cfg.concurrency + 2, name: 'media-worker' });
  const storage = Storage.fromConfig(cfg);
  const ctx: Ctx = { db: dbh.db, storage, cfg, log };
  const workerId = `media-${os.hostname()}-${process.pid}`;
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; log.info('stopping after in-flight jobs'); } };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);

  let idleMs = cfg.pollMs;
  let lastMaintenance = 0;
  let inFlight = 0;
  log.info({ workerId, kinds: MEDIA_KINDS, concurrency: cfg.concurrency, s3: cfg.s3.endpoint }, 'media-worker started');
  while (!stopping) {
    if (Date.now() - lastMaintenance > 5 * 60_000) {
      lastMaintenance = Date.now();
      try { const n = await releaseStaleJobs(dbh.db, 30); if (n) log.warn({ n }, 'released stale jobs'); await storage.evict(); } catch (e) { log.error({ err: e }, 'maintenance failed'); }
    }
    const room = cfg.concurrency - inFlight;
    const jobs = room > 0 ? await claimJobs(dbh.db, MEDIA_KINDS, workerId, room) : [];
    if (!jobs.length) {
      if (opts.once) break;
      await new Promise((r) => setTimeout(r, idleMs));
      idleMs = Math.min(idleMs * 2, 15_000);
      continue;
    }
    idleMs = cfg.pollMs;
    for (const job of jobs) {
      inFlight++;
      (async () => {
        const t0 = Date.now();
        try {
          await handle(ctx, job.kind, job.payload);
          await completeJob(dbh.db, job.id);
          log.info({ id: job.id, kind: job.kind, ms: Date.now() - t0 }, 'job done');
        } catch (e) {
          log.error({ id: job.id, kind: job.kind, attempt: job.attempts, err: e }, 'job failed');
          await failJob(dbh.db, job.id, e).catch((e2) => log.error({ err: e2 }, 'failJob failed'));
        } finally { inFlight--; }
      })();
    }
    if (inFlight >= cfg.concurrency) await new Promise((r) => setTimeout(r, 100));
  }
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
  await dbh.close();
  log.info('media-worker stopped');
}

const isMain = process.argv[1] && (process.argv[1].endsWith('/main.ts') || process.argv[1].endsWith('/main.js'));
if (isMain) runWorker({ once: process.argv.includes('--once') }).catch((e) => { log.fatal({ err: e }); process.exit(1); });

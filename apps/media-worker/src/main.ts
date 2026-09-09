import os from 'node:os';
import { createDb, claimJobs, completeJob, failJob, releaseJob, releaseStaleJobs, blobs, eq } from '@minnegela/db';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { log } from './log.js';
import { MEDIA_KINDS, handle } from './handlers.js';
import type { Ctx } from './context.js';

export class JobTimeoutError extends Error {
  constructor(kind: string, ms: number) { super(`${kind} exceeded its ${Math.round(ms / 1000)} s deadline`); this.name = 'JobTimeoutError'; }
}

/** Run `work` with a deadline; the slot is freed on timeout even though the underlying promise cannot be cancelled. */
export function withDeadline<T>(work: Promise<T>, ms: number, kind: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JobTimeoutError(kind, ms)), ms); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  let videoInFlight = 0;
  // Video originals transcode for minutes; they get their own lane so previews keep flowing (§13.2).
  const isVideoOriginal = async (job: { kind: string; payload: Record<string, unknown> }) => {
    if (job.kind !== 'derive' || job.payload.kind !== 'original') return false;
    const [b] = await dbh.db.select({ mime: blobs.mime }).from(blobs).where(eq(blobs.id, String(job.payload.blobId)));
    return !!b?.mime.startsWith('video/');
  };
  log.info({ workerId, kinds: MEDIA_KINDS, concurrency: cfg.concurrency, videoConcurrency: cfg.videoConcurrency, s3: cfg.s3.endpoint }, 'media-worker started');
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
      const video = await isVideoOriginal(job).catch(() => false);
      if (video && videoInFlight >= cfg.videoConcurrency) {
        await releaseJob(dbh.db, job.id, 30).catch((e) => log.error({ err: e, id: job.id }, 'releaseJob failed'));
        continue;
      }
      const timeoutMs = video || job.kind === 'export' ? cfg.videoJobTimeoutMs : cfg.jobTimeoutMs;
      inFlight++;
      if (video) videoInFlight++;
      (async () => {
        const t0 = Date.now();
        let timedOut = false;
        try {
          await withDeadline(handle(ctx, job.kind, job.payload).then(async () => {
            // A job that finishes after its deadline has already been failed and may be running elsewhere.
            if (timedOut) { log.warn({ id: job.id, kind: job.kind, ms: Date.now() - t0 }, 'job finished after its deadline; result discarded'); return; }
            await completeJob(dbh.db, job.id);
            log.info({ id: job.id, kind: job.kind, ms: Date.now() - t0 }, 'job done');
          }), timeoutMs, job.kind);
        } catch (e) {
          if (e instanceof JobTimeoutError) timedOut = true;
          log.error({ id: job.id, kind: job.kind, attempt: job.attempts, ms: Date.now() - t0, err: e }, timedOut ? 'job timed out' : 'job failed');
          await failJob(dbh.db, job.id, e).catch((e2) => log.error({ err: e2 }, 'failJob failed'));
        } finally { inFlight--; if (video) videoInFlight--; }
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

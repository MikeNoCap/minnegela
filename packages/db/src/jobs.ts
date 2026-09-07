import { sql } from 'drizzle-orm';
import { JobKind, JobPayloads, jobDedupeKey, type JobPayload } from '@minnegela/shared';
import type { Queryable } from './client.js';

export type EnqueueOpts = { priority?: number; runAfterSeconds?: number; maxAttempts?: number };

/**
 * Insert a job. Jobs with a dedupe key (recluster, group-wide identify/titles) coalesce with a
 * pending job of the same key: the run_after is pushed back (debounce) and the time window merged.
 */
export async function enqueue<K extends JobKind>(q: Queryable, kind: K, payload: JobPayload<K>, opts: EnqueueOpts = {}): Promise<void> {
  JobPayloads[kind].parse(payload);
  const key = jobDedupeKey(kind, payload as Record<string, unknown>);
  const runAfter = sql`now() + make_interval(secs => ${opts.runAfterSeconds ?? 0})`;
  const priority = opts.priority ?? 0;
  const maxAttempts = opts.maxAttempts ?? 5;
  const body = JSON.stringify(payload);
  if (!key) {
    await q.execute(sql`insert into jobs (kind, payload, priority, run_after, max_attempts)
      values (${kind}, ${body}::jsonb, ${priority}, ${runAfter}, ${maxAttempts})`);
    return;
  }
  await q.execute(sql`insert into jobs (kind, payload, priority, dedupe_key, run_after, max_attempts)
    values (${kind}, ${body}::jsonb, ${priority}, ${key}, ${runAfter}, ${maxAttempts})
    on conflict (dedupe_key) where dedupe_key is not null and done_at is null and locked_by is null
    do update set
      run_after = greatest(jobs.run_after, excluded.run_after),
      priority = greatest(jobs.priority, excluded.priority),
      payload = jobs.payload || excluded.payload
        || case when jobs.payload ? 'from' and excluded.payload ? 'from'
             then jsonb_build_object('from', least(jobs.payload->>'from', excluded.payload->>'from')) else '{}'::jsonb end
        || case when jobs.payload ? 'to' and excluded.payload ? 'to'
             then jsonb_build_object('to', greatest(jobs.payload->>'to', excluded.payload->>'to')) else '{}'::jsonb end`);
}

export type ClaimedJob = { id: number; kind: JobKind; payload: Record<string, unknown>; attempts: number; maxAttempts: number };

/** Claim up to `limit` ready jobs of the given kinds with FOR UPDATE SKIP LOCKED. */
export async function claimJobs(q: Queryable, kinds: readonly JobKind[], workerId: string, limit: number): Promise<ClaimedJob[]> {
  const rows = await q.execute(sql`
    with picked as (
      select id from jobs
      where kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(',')}]::text[]`)})
        and done_at is null and locked_by is null and run_after <= now()
      order by priority desc, run_after
      limit ${limit}
      for update skip locked
    )
    update jobs j set locked_by = ${workerId}, locked_at = now(), attempts = j.attempts + 1
    from picked where j.id = picked.id
    returning j.id, j.kind, j.payload, j.attempts, j.max_attempts as "maxAttempts"`);
  return (rows as unknown as ClaimedJob[]).map((r) => ({ ...r, id: Number(r.id) }));
}

export async function completeJob(q: Queryable, id: number): Promise<void> {
  await q.execute(sql`update jobs set done_at = now(), locked_by = null, error = null where id = ${id}`);
}

/** Release with exponential backoff (attempts² minutes); park after max_attempts with the error kept. */
export async function failJob(q: Queryable, id: number, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}`.slice(0, 4000) : String(err).slice(0, 4000);
  await q.execute(sql`update jobs set
      error = ${message},
      locked_by = case when attempts >= max_attempts then locked_by else null end,
      done_at = case when attempts >= max_attempts then now() else null end,
      run_after = now() + make_interval(mins => attempts * attempts)
    where id = ${id}`);
}

/** Jobs that were claimed but whose worker died: unlock after `staleMinutes`. */
export async function releaseStaleJobs(q: Queryable, staleMinutes = 30): Promise<number> {
  const rows = await q.execute(sql`update jobs set locked_by = null, locked_at = null
    where done_at is null and locked_by is not null and locked_at < now() - make_interval(mins => ${staleMinutes}) returning id`);
  return (rows as unknown[]).length;
}

export async function queueDepths(q: Queryable): Promise<Array<{ kind: string; pending: number; running: number; failed: number }>> {
  const rows = await q.execute(sql`select kind,
      count(*) filter (where done_at is null and locked_by is null)::int as pending,
      count(*) filter (where done_at is null and locked_by is not null)::int as running,
      count(*) filter (where done_at is not null and error is not null)::int as failed
    from jobs group by kind order by kind`);
  return rows as unknown as Array<{ kind: string; pending: number; running: number; failed: number }>;
}

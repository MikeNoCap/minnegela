import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import { enqueue } from '../src/jobs.js';

const ADMIN = process.env.DATABASE_URL_ADMIN;

describe.skipIf(!ADMIN)('job coalescing', () => {
  let admin: DbHandle;
  const groupId = randomUUID();
  const pending = async () => (await admin.db.execute(sql`select payload from jobs where dedupe_key = ${`identify:${groupId}`} and done_at is null`)) as unknown as Array<{ payload: Record<string, unknown> }>;
  beforeAll(async () => { await migrate(ADMIN!, { log: () => {} }); admin = createDb(ADMIN!, { max: 2 }); });
  afterAll(async () => { await admin.db.execute(sql`delete from jobs where payload->>'groupId' = ${groupId}`); await admin.close(); });

  it('identify jobs for different persons widen to one group-wide run instead of keeping only the last person', async () => {
    await enqueue(admin.db, 'identify', { groupId, personId: 1 });
    await enqueue(admin.db, 'identify', { groupId, personId: 1 });
    expect((await pending()).map((j) => j.payload)).toEqual([{ groupId, personId: 1 }]);
    await enqueue(admin.db, 'identify', { groupId, personId: 2 });
    expect((await pending()).map((j) => j.payload)).toEqual([{ groupId }]);
    // once group-wide it stays group-wide
    await enqueue(admin.db, 'identify', { groupId, personId: 3 });
    expect((await pending()).map((j) => j.payload)).toEqual([{ groupId }]);
    // blob-scoped runs never coalesce
    await enqueue(admin.db, 'identify', { groupId, blobId: randomUUID() });
    expect((await admin.db.execute(sql`select count(*)::int as n from jobs where payload->>'groupId' = ${groupId} and done_at is null`)) as unknown as [{ n: number }]).toEqual([{ n: 2 }]);
  });
});

import { sql } from 'drizzle-orm';
import { createDb } from './client.js';
import { enqueue } from './jobs.js';

/**
 * Ops: throw away every event of a group and rebuild them from scratch with the current clusterer.
 * Use after a clustering rule change (§7.4 provenance, WBS constants) that a windowed recluster
 * would only half-apply. Manual edits on events (titles, opens, tags, pins) are lost; assets, blobs,
 * faces and people are untouched.
 *
 *   pnpm --filter @minnegela/db exec tsx src/rebuild-events.ts <groupId>
 */
async function main() {
  const url = process.env.DATABASE_URL_ADMIN;
  const groupId = process.argv[2];
  if (!url || !groupId) throw new Error('usage: DATABASE_URL_ADMIN=… tsx src/rebuild-events.ts <groupId>');
  const h = createDb(url, { max: 1 });
  try {
    await h.db.transaction(async (tx) => {
      const stale = (await tx.execute(sql`delete from jobs where done_at is null and locked_by is null and kind in ('recluster', 'titles') and payload->>'groupId' = ${groupId} returning id`)) as unknown as unknown[];
      const events = (await tx.execute(sql`delete from events where group_id = ${groupId}::uuid returning id`)) as unknown as unknown[];
      await enqueue(tx, 'recluster', { groupId, full: true }, { runAfterSeconds: 0, priority: 5 });
      console.log(JSON.stringify({ groupId, deletedEvents: events.length, droppedJobs: stale.length, queued: 'recluster(full)' }));
    });
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

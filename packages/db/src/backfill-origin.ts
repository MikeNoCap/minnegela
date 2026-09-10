import { classifyOrigin, type Origin } from '@minnegela/shared';
import { sql } from 'drizzle-orm';
import { createDb } from './client.js';

/**
 * §7.4 one-off: grade every asset's provenance from what the server already holds (album, filename,
 * GPS from the phone, mime) and refresh blob trust for blobs that have no original yet. Run once after
 * migration 0006; later manifests from an updated app regrade with path + EXIF signals.
 *
 *   pnpm --filter @minnegela/db exec tsx src/backfill-origin.ts [groupId]
 */
async function main() {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL_WORKER;
  if (!url) throw new Error('DATABASE_URL_ADMIN (or DATABASE_URL_WORKER) is required');
  const groupId = process.argv[2];
  const h = createDb(url, { max: 2 });
  try {
    const rows = (await h.db.execute(sql`
      select a.id, a.filename, a.album_names, a.origin, b.mime, (b.lat is not null) as has_gps, a.capture_hint
      from assets a join blobs b on b.id = a.blob_id
      where a.deleted_at is null ${groupId ? sql`and a.group_id = ${groupId}::uuid` : sql``}`)) as unknown as Array<{ id: string; filename: string | null; album_names: string[]; origin: Origin; mime: string; has_gps: boolean; capture_hint: Record<string, string> | null }>;
    const counts: Record<string, number> = {};
    const changes: Array<{ id: string; origin: Origin }> = [];
    for (const r of rows) {
      const origin = classifyOrigin({ filename: r.filename, albums: r.album_names, mime: r.mime, hasGps: r.has_gps, exif: r.capture_hint });
      counts[origin] = (counts[origin] ?? 0) + 1;
      if (origin !== r.origin) changes.push({ id: r.id, origin });
    }
    for (let i = 0; i < changes.length; i += 500) {
      const batch = changes.slice(i, i + 500);
      await h.db.execute(sql`
        update assets a set origin = v.origin
        from (select unnest(${sql.raw(`array[${batch.map((c) => `'${c.id}'`).join(',')}]::uuid[]`)}) as id, unnest(${sql.raw(`array[${batch.map((c) => `'${c.origin}'`).join(',')}]::text[]`)}) as origin) v
        where a.id = v.id`);
    }
    // blob trust follows the best copy; only blobs without an original (no EXIF ever seen) are regraded
    const trust = (await h.db.execute(sql`
      update blobs b set
        time_uncertain = not exists (select 1 from assets a where a.blob_id = b.id and a.deleted_at is null and a.origin = 'camera'),
        is_utility = b.is_utility or exists (select 1 from assets a where a.blob_id = b.id and a.deleted_at is null and a.origin = 'screenshot')
      where b.storage_key is null ${groupId ? sql`and b.group_id = ${groupId}::uuid` : sql``}
      returning b.id`)) as unknown as unknown[];
    console.log(JSON.stringify({ assets: rows.length, regraded: changes.length, byOrigin: counts, blobsRefreshed: trust.length }));
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

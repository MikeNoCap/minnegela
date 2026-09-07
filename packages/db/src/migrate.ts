import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Applies ./migrations/*.sql in name order, once each, tracked in schema_migrations.
 * Each file runs in one transaction as the admin role.
 */
export async function migrate(url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL, opts: { log?: (s: string) => void } = {}): Promise<string[]> {
  if (!url) throw new Error('DATABASE_URL_ADMIN (or DATABASE_URL) is required');
  const log = opts.log ?? ((s: string) => console.log(s));
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
    for (const f of files) {
      if (done.has(f)) continue;
      const body = await readFile(path.join(dir, f), 'utf8');
      log(`applying ${f}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${f})`;
      });
      applied.push(f);
    }
  } finally {
    await sql.end();
  }
  log(applied.length ? `applied ${applied.length} migration(s)` : 'up to date');
  return applied;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) migrate().catch((e) => { console.error(e); process.exit(1); });

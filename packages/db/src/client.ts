import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a root client or a transaction: the query surface is the same. */
export type Queryable = Db | Tx;

export type DbHandle = { db: Db; sql: postgres.Sql; close: () => Promise<void> };

/**
 * Create a Drizzle client. Which role the URL uses decides what the connection can see:
 *  - DATABASE_URL        (minnegela_api)    subject to RLS; must run queries inside withViewer()
 *  - DATABASE_URL_WORKER (minnegela_worker) bypasses RLS and may read the ml schema
 *  - DATABASE_URL_ADMIN  (owner)            migrations and seeds only
 */
export function createDb(url: string, opts: { max?: number; name?: string } = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 8,
    connection: { application_name: opts.name ?? 'minnegela' },
    // pgvector columns arrive as text; parse them when read.
    types: { vector: { to: 0, from: [], serialize: (x: number[]) => `[${x.join(',')}]`, parse: (s: string) => s } },
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, sql: client, close: () => client.end({ timeout: 5 }) };
}

export { schema };

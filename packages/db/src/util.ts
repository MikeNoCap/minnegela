import { sql, type SQL } from 'drizzle-orm';

/**
 * Bind a Date inside a raw `sql` fragment. postgres-js forwards Date objects unserialized in
 * `db.execute(sql\`...\`)`, so pass an ISO string and cast it instead.
 */
export function ts(d: Date): SQL {
  return sql`${d.toISOString()}::timestamptz`;
}

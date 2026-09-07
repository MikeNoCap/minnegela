import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, createDb, type DbHandle } from '@minnegela/db';
import { buildApp, type App } from '../src/app.js';

/** Load the repo-root .env into process.env without overriding what is already set. */
export function loadEnv(): NodeJS.ProcessEnv {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  try {
    for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: rely on the environment */ }
  return process.env;
}

export const HAS_DB = !!loadEnv().DATABASE_URL_ADMIN;

export async function testApp(): Promise<{ app: App; admin: DbHandle }> {
  const env = loadEnv();
  const app = await buildApp({ ...env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }, { logger: false });
  await app.ready();
  const admin = createDb(env.DATABASE_URL_ADMIN!, { max: 2, name: 'api-test-admin' });
  return { app, admin };
}

/** A raw session token for a user, accepted as `Authorization: Bearer`. */
export async function sessionFor(admin: DbHandle, userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await admin.db.execute(sql`insert into sessions (user_id, token, expires_at) values (${userId}::uuid, ${token}, now() + interval '1 day')`);
  return token;
}

export async function createUser(admin: DbHandle, email: string, displayName: string): Promise<string> {
  const [u] = (await admin.db.execute(sql`insert into users (email, display_name, email_verified) values (${email}, ${displayName}, true)
    on conflict (email) do update set display_name = excluded.display_name returning id`)) as unknown as [{ id: string }];
  return u.id;
}

export async function cleanupUsers(admin: DbHandle, pattern: string) {
  await admin.db.execute(sql`delete from groups where created_by in (select id from users where email like ${pattern})`);
  await admin.db.execute(sql`delete from users where email like ${pattern}`);
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

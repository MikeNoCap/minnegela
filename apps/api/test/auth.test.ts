import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@minnegela/db';
import { HAS_DB, testApp, cleanupUsers } from './helpers.js';
import { lastMagicLinks, lastOtps } from '../src/auth.js';
import type { App } from '../src/app.js';
import type { DbHandle } from '@minnegela/db';

describe.skipIf(!HAS_DB)('auth', () => {
  let app: App, admin: DbHandle;
  const email = `auth-${Date.now()}@apitest.local`;
  beforeAll(async () => ({ app, admin } = await testApp()));
  afterAll(async () => { await cleanupUsers(admin, '%@apitest.local'); await app.close(); await admin.close(); });

  it('magic link: request → verify → session cookie and bearer token → /v1/me', async () => {
    const req = await app.inject({ method: 'POST', url: '/v1/auth/sign-in/magic-link', headers: { origin: 'http://localhost:3000' }, payload: { email, name: 'Auth Tester', callbackURL: 'http://localhost:3000/' } });
    expect(req.statusCode).toBe(200);
    const link = lastMagicLinks.get(email);
    expect(link?.url).toContain('/v1/auth/magic-link/verify');
    const verify = await app.inject({ method: 'GET', url: new URL(link!.url).pathname + new URL(link!.url).search });
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toBe('http://localhost:3000/');
    const cookie = ([] as string[]).concat(verify.headers['set-cookie'] ?? []).find((c) => c.includes('session_token'))!;
    expect(cookie).toBeTruthy();
    const token = verify.headers['set-auth-token'] as string;
    expect(token).toBeTruthy();

    const viaCookie = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: cookie.split(';')[0]! } });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().user.email).toBe(email);
    expect(viaCookie.json().user.displayName).toBe('Auth Tester');
    expect(viaCookie.json().groups).toEqual([]);

    const viaBearer = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(viaBearer.statusCode).toBe(200);
    const [row] = (await admin.db.execute(sql`select display_name from users where email = ${email}`)) as unknown as [{ display_name: string }];
    expect(row.display_name).toBe('Auth Tester');
  });

  it('email code (mobile): send → sign-in with otp → bearer token → PATCH /v1/me sets the name', async () => {
    const otpEmail = `otp-${Date.now()}@apitest.local`;
    const send = await app.inject({ method: 'POST', url: '/v1/auth/email-otp/send-verification-otp', payload: { email: otpEmail, type: 'sign-in' } });
    expect(send.statusCode).toBe(200);
    const code = lastOtps.get(otpEmail)?.otp;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/sign-in/email-otp', payload: { email: otpEmail, otp: '000000' } });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    const signIn = await app.inject({ method: 'POST', url: '/v1/auth/sign-in/email-otp', payload: { email: otpEmail, otp: code } });
    expect(signIn.statusCode).toBe(200);
    const token = (signIn.headers['set-auth-token'] as string) || signIn.json().token;
    expect(token).toBeTruthy();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(otpEmail);
    const patched = await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { displayName: 'Phone User' } });
    expect(patched.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } })).json().user.displayName).toBe('Phone User');
  });

  it('no session → 401 problem+json; unknown route → 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json()).toMatchObject({ status: 401, title: 'Unauthorized' });
    expect((await app.inject({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(404);
  });

  it('health and openapi are public', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).json().ok).toBe(true);
    const spec = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    expect(Object.keys(spec.paths)).toContain('/v1/groups/{g}/sync/manifest');
  });
});

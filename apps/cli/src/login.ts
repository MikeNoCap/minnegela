import { createInterface } from 'node:readline/promises';
import { credentials, saveCredentials } from './config.js';

/**
 * Magic-link login for a terminal: request the link, paste the URL the dev API printed (or that arrived by mail),
 * exchange it for a bearer session token (Better Auth `bearer` plugin returns it in `set-auth-token`).
 */
export async function login(api: string, email: string, log: (s: string) => void, pasteUrl?: string): Promise<string> {
  const base = api.replace(/\/$/, '');
  const res = await fetch(`${base}/v1/auth/sign-in/magic-link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, callbackURL: `${base}/v1/me` }) });
  if (!res.ok) throw new Error(`magic link request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  let url = pasteUrl;
  if (!url) {
    log(`Magic link requested for ${email}. In development the API logs it; paste the full link below.`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    url = (await rl.question('Magic link URL: ')).trim();
    rl.close();
  }
  const verify = await fetch(url, { redirect: 'manual', headers: { Accept: 'application/json' } });
  const token = verify.headers.get('set-auth-token');
  if (!token) throw new Error(`no session token in the verify response (status ${verify.status}); is the bearer plugin enabled?`);
  const creds = await credentials();
  creds[base] = { email, token, at: new Date().toISOString() };
  await saveCredentials(creds);
  return token;
}

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins/magic-link';
import { bearer } from 'better-auth/plugins/bearer';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { users, sessions, accounts, verifications, type Db } from '@minnegela/db';
import type { Config } from './config.js';
import type { Logger } from 'pino';

/** The most recent magic link per email; used by tests and by the console mail transport. */
export const lastMagicLinks = new Map<string, { url: string; token: string; at: number }>();
/** The most recent sign-in code per email (mobile flow); used by tests and by the console mail transport. */
export const lastOtps = new Map<string, { otp: string; at: number }>();

export function createAuth(cfg: Config, db: Db, log: Logger) {
  return betterAuth({
    appName: 'Minnegela',
    baseURL: cfg.API_URL,
    basePath: '/v1/auth',
    secret: cfg.BETTER_AUTH_SECRET,
    trustedOrigins: [cfg.WEB_URL, cfg.API_URL],
    database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema: { users, sessions, accounts, verifications } }),
    user: { fields: { name: 'displayName' } },
    session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { database: { generateId: 'uuid' }, useSecureCookies: cfg.API_URL.startsWith('https://') },
    rateLimit: { enabled: cfg.NODE_ENV === 'production' },
    plugins: [
      bearer(),
      // Native apps cannot receive a session from a magic-link redirect, so they sign in with a 6-digit code (§16.6).
      emailOTP({
        otpLength: 6,
        expiresIn: 60 * 10,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp, type }) => {
          lastOtps.set(email.toLowerCase(), { otp, at: Date.now() });
          if (cfg.MAIL_TRANSPORT === 'console') log.info({ email, otp, type }, 'sign-in code (console transport)');
          else log.warn({ email, type }, 'MAIL_TRANSPORT=smtp is not wired yet; code logged only');
        },
      }),
      magicLink({
        expiresIn: 60 * 15,
        sendMagicLink: async ({ email, url, token }) => {
          lastMagicLinks.set(email.toLowerCase(), { url, token, at: Date.now() });
          if (cfg.MAIL_TRANSPORT === 'console') log.info({ email, url }, 'magic link (console transport)');
          else log.warn({ email }, 'MAIL_TRANSPORT=smtp is not wired yet; link logged only');
        },
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;

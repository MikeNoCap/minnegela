import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_ADMIN: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(16),
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.union([z.literal('true'), z.literal('false')]).default('false').transform((v) => v === 'true'),
  ML_TEXT_EMBED_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default('info'),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) throw new Error(`Invalid environment: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

import { z } from 'zod';

const Env = z.object({
  DATABASE_URL_WORKER: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().default('true'),
  WORKER_CACHE_DIR: z.string().default('./worker-cache'),
  WORKER_CACHE_GB: z.coerce.number().positive().default(50),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  FFMPEG_NVENC: z.string().default('0'),
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),
  GEOCODE: z.string().default('0'),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL_WORKER,
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === 'true',
    },
    cacheDir: e.WORKER_CACHE_DIR,
    cacheBytes: e.WORKER_CACHE_GB * 1024 ** 3,
    concurrency: e.WORKER_CONCURRENCY,
    pollMs: e.WORKER_POLL_MS,
    ffmpeg: { bin: e.FFMPEG_BIN, probe: e.FFPROBE_BIN, nvenc: e.FFMPEG_NVENC === '1' },
    geocode: e.GEOCODE === '1',
    logLevel: e.LOG_LEVEL,
  };
}

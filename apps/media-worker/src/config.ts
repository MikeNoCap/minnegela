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
  /** Video transcodes run for minutes; cap how many of the slots they may hold at once. */
  WORKER_VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(1),
  /** Per-job deadlines. A job past its deadline is failed (retried later) and its slot freed. */
  WORKER_JOB_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  WORKER_VIDEO_JOB_TIMEOUT_S: z.coerce.number().int().positive().default(1800),
  /** S3 socket timeouts. Without these a dead keep-alive connection to R2 holds a slot forever. */
  S3_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
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
      connectTimeoutMs: e.S3_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: e.S3_REQUEST_TIMEOUT_MS,
    },
    cacheDir: e.WORKER_CACHE_DIR,
    cacheBytes: e.WORKER_CACHE_GB * 1024 ** 3,
    concurrency: e.WORKER_CONCURRENCY,
    videoConcurrency: Math.min(e.WORKER_VIDEO_CONCURRENCY, e.WORKER_CONCURRENCY),
    pollMs: e.WORKER_POLL_MS,
    jobTimeoutMs: e.WORKER_JOB_TIMEOUT_S * 1000,
    videoJobTimeoutMs: e.WORKER_VIDEO_JOB_TIMEOUT_S * 1000,
    ffmpeg: { bin: e.FFMPEG_BIN, probe: e.FFPROBE_BIN, nvenc: e.FFMPEG_NVENC === '1' },
    geocode: e.GEOCODE === '1',
    logLevel: e.LOG_LEVEL,
  };
}

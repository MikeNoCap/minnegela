import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, readdir, unlink, utimes, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';

/**
 * §13.3 worker storage adapter. Endpoint-agnostic S3 (MinIO in dev, R2 in prod) with a local
 * LRU disk cache so derive/dedupe/analyze for the same object do not re-download.
 */
export class Storage {
  readonly client: S3Client;
  readonly bucket: string;
  private readonly dir: string;
  private readonly cap: number;
  private inflight = new Map<string, Promise<string>>();

  constructor(cfg: Config['s3'], cacheDir: string, cacheBytes: number) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // requestTimeout is a socket idle timeout: a stalled response is aborted (and retried by the
      // SDK) instead of hanging the job until the OS gives up on the TCP connection ~16 min later.
      requestHandler: { connectionTimeout: cfg.connectTimeoutMs, requestTimeout: cfg.requestTimeoutMs },
    });
    this.bucket = cfg.bucket;
    this.dir = path.resolve(cacheDir);
    this.cap = cacheBytes;
  }

  static fromConfig(cfg: Config) {
    return new Storage(cfg.s3, cfg.cacheDir, cfg.cacheBytes);
  }

  private cachePath(key: string) {
    const h = createHash('sha1').update(key).digest('hex');
    return path.join(this.dir, h.slice(0, 2), h + path.extname(key));
  }

  /** Download to the cache (or reuse) and return the local path. */
  async get(key: string): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const local = this.cachePath(key);
      try {
        await stat(local);
        const now = new Date();
        await utimes(local, now, now); // LRU touch
        return local;
      } catch { /* miss */ }
      await mkdir(path.dirname(local), { recursive: true });
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const tmp = `${local}.${process.pid}.part`;
      await pipeline(res.Body as Readable, createWriteStream(tmp));
      const { rename } = await import('node:fs/promises');
      await rename(tmp, local);
      return local;
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    return readFile(await this.get(key));
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    const data = typeof body === 'string' ? await readFile(body) : body;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ContentLength: data.length }));
  }

  async head(key: string): Promise<{ size: number; lastModified?: Date } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, lastModified: r.LastModified };
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  /** Copy then delete (S3 has no rename). */
  async move(from: string, to: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `/${this.bucket}/${encodeURIComponent(from).replace(/%2F/g, '/')}`, Key: to }));
    await this.delete([from]);
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (!chunk.length) return;
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const out: Array<{ key: string; size: number; lastModified: Date }> = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Evict least-recently-used cache files until under the cap. Call periodically. */
  async evict(): Promise<number> {
    const files: Array<{ p: string; size: number; atime: number }> = [];
    let total = 0;
    const walk = async (d: string) => {
      let entries: string[] = [];
      try { entries = await readdir(d); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e);
        const s = await stat(p).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) await walk(p);
        else { files.push({ p, size: s.size, atime: s.mtimeMs }); total += s.size; }
      }
    };
    await walk(this.dir);
    if (total <= this.cap) return 0;
    files.sort((a, b) => a.atime - b.atime);
    let removed = 0;
    for (const f of files) {
      if (total <= this.cap * 0.9) break;
      await unlink(f.p).catch(() => {});
      total -= f.size;
      removed++;
    }
    return removed;
  }
}

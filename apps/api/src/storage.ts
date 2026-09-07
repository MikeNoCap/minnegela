import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SIGNED_GET, UPLOAD } from '@minnegela/shared';
import type { Config } from './config.js';

export type PresignedPut = { url: string; headers: Record<string, string>; expiresAt: string; key: string };

/**
 * Endpoint-agnostic S3 access (MinIO in dev, Cloudflare R2 in production). §15, §18.6.
 * GET URLs are signed with an expiry aligned to 1-hour buckets so the same object yields the same
 * URL for up to an hour and browsers can cache it; PUT URLs are bound to one key, a content length
 * and a 15-minute window.
 */
export class StorageProvider {
  private client: S3Client;
  private getCache = new Map<string, { url: string; bucket: number }>();
  constructor(private cfg: Pick<Config, 'S3_ENDPOINT' | 'S3_BUCKET' | 'S3_REGION' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'>) {
    this.client = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
    });
  }
  get bucket() { return this.cfg.S3_BUCKET; }

  /**
   * Single-object PUT, 15 minutes, bound to the key and content type. When `contentLength` is given
   * (the /sync/uploads path, where the phone knows the exact size) the length is signed too; the
   * manifest path leaves it unbound because the preview has not been generated yet.
   */
  async presignPut(key: string, opts: { contentLength?: number; contentType: string; ttlSeconds?: number }): Promise<PresignedPut> {
    const ttl = opts.ttlSeconds ?? UPLOAD.presignTtlSeconds;
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: opts.contentLength, ContentType: opts.contentType });
    const signable = new Set(['content-type', ...(opts.contentLength !== undefined ? ['content-length'] : [])]);
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttl, signableHeaders: signable });
    const headers: Record<string, string> = { 'content-type': opts.contentType };
    if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
    return { url, headers, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), key };
  }

  /** Bucketed expiry: expires = ceil(now / 1h) * 1h + 1h, i.e. 1–2 h from now, identical within a bucket. */
  async presignGet(key: string, now = Date.now()): Promise<string> {
    const b = SIGNED_GET.bucketSeconds * 1000;
    const bucket = Math.ceil(now / b) * b;
    const hit = this.getCache.get(key);
    if (hit && hit.bucket === bucket) return hit.url;
    const expiresIn = Math.max(60, Math.floor((bucket + b - now) / 1000));
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
    if (this.getCache.size > 50_000) this.getCache.clear();
    this.getCache.set(key, { url, bucket });
    return url;
  }

  /** Stream an object (used only for face crops in the review queue; everything else is presigned). */
  async getObject(key: string): Promise<{ body: NodeJS.ReadableStream; contentType: string; contentLength?: number } | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!r.Body) return null;
      return { body: r.Body as unknown as NodeJS.ReadableStream, contentType: r.ContentType ?? 'image/jpeg', contentLength: r.ContentLength };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  async list(prefix: string, max = 1000): Promise<Array<{ key: string; size: number; lastModified?: Date }>> {
    const out: Array<{ key: string; size: number; lastModified?: Date }> = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, max - out.length) }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token && out.length < max);
    return out;
  }
}

export function extFor(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm' } as Record<string, string>)[mime] ?? 'bin';
}

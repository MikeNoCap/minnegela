import type { ManifestRequest, ManifestResponse, UploadTarget } from '@minnegela/shared';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/** Thin client for the routes the phone uses (§21 Sync). Bearer session token from `minnegela login`. */
export class Api {
  constructor(private base: string, private token: string) { this.base = base.replace(/\/$/, ''); }

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${p}`, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) throw new ApiError(res.status, `${method} ${p} → ${res.status} ${typeof json === 'object' && json && 'detail' in json ? (json as { detail: string }).detail : text.slice(0, 200)}`, json);
    return json as T;
  }

  me() { return this.call<{ id: string; email: string; groups?: Array<{ id: string; name: string }> }>('GET', '/v1/me'); }
  registerDevice(groupId: string, name: string) { return this.call<{ id: string }>('POST', `/v1/groups/${groupId}/devices`, { platform: 'cli', name }); }
  manifest(groupId: string, body: ManifestRequest) { return this.call<ManifestResponse>('POST', `/v1/groups/${groupId}/sync/manifest`, body); }
  uploads(groupId: string, items: Array<{ assetId: string; kind: 'preview' | 'original'; bytes: number; mime: string }>) {
    return this.call<{ items: Array<{ assetId: string; kind: 'preview' | 'original'; upload: UploadTarget }> }>('POST', `/v1/groups/${groupId}/sync/uploads`, { items });
  }
  complete(assetId: string, kind: 'preview' | 'original', sha256: string, bytes: number) { return this.call<unknown>('POST', `/v1/assets/${assetId}/complete`, { kind, sha256, bytes }); }

  /** Presigned PUT straight to object storage: the API never sees the bytes. */
  static async put(target: UploadTarget, body: Buffer): Promise<void> {
    // The API may bind Content-Length in the presigned headers; undici derives it from the Buffer itself and
    // rejects a duplicate, so strip it here. The signature still covers the bound length.
    const headers = Object.fromEntries(Object.entries(target.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
    const res = await fetch(target.url, { method: 'PUT', headers, body });
    if (!res.ok) throw new ApiError(res.status, `PUT ${target.key} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

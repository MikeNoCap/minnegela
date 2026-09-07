/** Minimal fetch wrapper: bearer auth, RFC 7807 problem+json → ApiError. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ClientConfig = { baseUrl: () => string; token: () => string | null; onUnauthorized?: () => void };

export type ResponseWithHeaders<T> = { body: T; headers: Headers };

export function createClient(cfg: ClientConfig) {
  async function raw<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ResponseWithHeaders<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    const token = cfg.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${cfg.baseUrl().replace(/\/$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      if (res.status === 401) cfg.onUnauthorized?.();
      const p = (json ?? {}) as { title?: string; detail?: string; message?: string };
      throw new ApiError(res.status, p.title ?? p.message ?? `HTTP ${res.status}`, p.detail);
    }
    return { body: json as T, headers: res.headers };
  }
  return {
    raw,
    get: <T>(path: string) => raw<T>('GET', path).then((r) => r.body),
    post: <T>(path: string, body?: unknown) => raw<T>('POST', path, body ?? {}).then((r) => r.body),
    patch: <T>(path: string, body: unknown) => raw<T>('PATCH', path, body).then((r) => r.body),
    delete: <T>(path: string, body?: unknown) => raw<T>('DELETE', path, body).then((r) => r.body),
  };
}
export type Client = ReturnType<typeof createClient>;

/** Opaque pagination cursors: base64url JSON. Never trusted for authorization, only for position. */
export function encodeCursor(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
export function decodeCursor<T = Record<string, unknown>>(cursor: string | undefined | null): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

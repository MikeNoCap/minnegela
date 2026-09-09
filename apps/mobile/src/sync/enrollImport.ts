import * as FS from 'expo-file-system/legacy';
import type { LocalDb } from '@/db/types';
import { ENROLL_PREFIX, pickToLocalAsset, type PickedImage } from './enrollPick';

const dir = () => `${FS.documentDirectory ?? FS.cacheDirectory ?? ''}minnegela/enroll/`;

/** Copy a picked image into app storage and index it; returns the new local id. Idempotent per content. */
export async function importPick(db: Pick<LocalDb, 'upsertLocal'>, p: PickedImage): Promise<string> {
  try { await FS.makeDirectoryAsync(dir(), { intermediates: true }); } catch { /* exists */ }
  const src = await FS.getInfoAsync(p.uri, { md5: true });
  if (!src.exists) throw new Error(`picked file is not readable: ${p.uri}`);
  const key = src.md5 ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = (p.fileName ?? p.uri).split('.').pop()?.toLowerCase() || 'jpg';
  const dest = `${dir()}${key}.${ext}`;
  if (!(await FS.getInfoAsync(dest)).exists) await FS.copyAsync({ from: p.uri, to: dest });
  const size = p.fileSize ?? src.size ?? 0;
  const fallback = src.modificationTime ? new Date(src.modificationTime * 1000).toISOString() : new Date().toISOString();
  const id = `${ENROLL_PREFIX}${key}`;
  await db.upsertLocal([{ ...pickToLocalAsset(p, id, dest, size, fallback), state: 'new' }]);
  return id;
}

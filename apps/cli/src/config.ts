import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = process.env.MINNEGELA_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'minnegela');

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path.join(CONFIG_DIR, file), 'utf8')) as T; } catch { return fallback; }
}
export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const p = path.join(CONFIG_DIR, file);
  await writeFile(`${p}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(`${p}.tmp`, p);
}

export type Credentials = Record<string, { email: string; token: string; at: string }>;
export const credentials = () => readJson<Credentials>('credentials.json', {});
export const saveCredentials = (c: Credentials) => writeJson('credentials.json', c);

export type Devices = Record<string, string>; // key(api, group, folder) -> deviceId
export const deviceKey = (api: string, group: string, folder: string) => createHash('sha1').update(`${api}|${group}|${folder}`).digest('hex');

/** Per-file state so re-runs are idempotent and resumable. */
export type FileState = { assetId: string; md5: string; size: number; state: 'manifested' | 'skipped' | 'preview_uploaded' | 'original_uploaded' | 'failed'; error?: string; at: string };
export type ImportState = { files: Record<string, FileState> };
export const stateFile = (api: string, group: string, folder: string) => `state-${deviceKey(api, group, folder)}.json`;

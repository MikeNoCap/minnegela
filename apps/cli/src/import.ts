import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestItem } from '@minnegela/shared';
import { Api, ApiError } from './api.js';
import { readJson, writeJson, deviceKey, stateFile, type Devices, type ImportState, type FileState } from './config.js';
import { walk, hashFile, probeFile, toManifestItem, type ScannedFile } from './scan.js';
import { makePreview, makeVideoPoster } from './preview.js';

export type ImportOptions = {
  api: string; token: string; group: string; folder: string;
  deviceName: string; originals: boolean; concurrency: number; dryRun: boolean;
  since?: Date; exts?: Set<string>;
  log: (line: string) => void;
};

export type Summary = { scanned: number; manifested: number; skipped: number; previews: number; originals: number; failed: number; unchanged: number };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Bounded parallel map that keeps going on individual failures. */
async function pmap<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** §13.1 / §16.3, run once over a folder: enumerate → manifest → preview → (original). Resumable via the state file. */
export async function runImport(o: ImportOptions): Promise<Summary> {
  const folder = path.resolve(o.folder);
  const api = new Api(o.api, o.token);
  const sum: Summary = { scanned: 0, manifested: 0, skipped: 0, previews: 0, originals: 0, failed: 0, unchanged: 0 };
  const sfile = stateFile(o.api, o.group, folder);
  const state = await readJson<ImportState>(sfile, { files: {} });
  const persist = () => (o.dryRun ? Promise.resolve() : writeJson(sfile, state));

  // device, registered once per (api, group, folder)
  const devices = await readJson<Devices>('devices.json', {});
  const dk = deviceKey(o.api, o.group, folder);
  let deviceId = devices[dk];
  if (!deviceId && !o.dryRun) {
    deviceId = (await api.registerDevice(o.group, o.deviceName)).id;
    devices[dk] = deviceId;
    await writeJson('devices.json', devices);
    o.log(`registered device ${deviceId} (${o.deviceName})`);
  }

  // enumerate
  let files = await walk(folder, o.exts);
  if (o.since) files = files.filter((f) => f.mtime >= o.since!);
  sum.scanned = files.length;
  o.log(`scanned ${files.length} files in ${folder}`);

  // build manifest items for files not yet manifested (or changed on disk)
  type Pending = { f: ScannedFile; item: ManifestItem };
  const pending: Pending[] = [];
  let noExif = 0;
  await pmap(files, o.concurrency, async (f) => {
    const prev = state.files[f.rel];
    if (prev && prev.size === f.size && prev.state !== 'failed' && (prev.state !== 'preview_uploaded' || !o.originals)) { sum.unchanged++; return; }
    if (prev && prev.state === 'preview_uploaded' && o.originals) { pending.push({ f, item: { localId: f.rel, size: f.size, mime: f.mime, createdAt: prev.at, albums: [], isFavorite: false } }); return; }
    try {
      const [md5, probe] = await Promise.all([hashFile(f.abs, 'md5'), probeFile(f)]);
      if (!probe.fromExif && !f.isVideo) noExif++;
      pending.push({ f, item: toManifestItem(f, md5, probe) });
    } catch (e) {
      sum.failed++; state.files[f.rel] = { assetId: '', md5: '', size: f.size, state: 'failed', error: String(e), at: new Date().toISOString() };
    }
  });
  if (noExif) o.log(`${noExif} photo(s) carry no EXIF date; using file mtime (they will be time-uncertain on the server)`);
  if (o.dryRun) {
    o.log(`dry run: would manifest ${pending.length} files (${sum.unchanged} already synced)`);
    for (const p of pending.slice(0, 20)) o.log(`  ${p.f.rel}  ${p.item.createdAt}  ${p.item.gps ? `${p.item.gps.lat.toFixed(4)},${p.item.gps.lon.toFixed(4)}` : 'no gps'}`);
    return sum;
  }

  // manifest in batches of 200, then act on each answer
  for (let i = 0; i < pending.length; i += 200) {
    const batch = pending.slice(i, i + 200);
    const previously = new Map(batch.filter((p) => state.files[p.f.rel]?.state === 'preview_uploaded').map((p) => [p.f.rel, state.files[p.f.rel]!]));
    let res;
    try {
      res = await api.manifest(o.group, { deviceId: deviceId!, assets: batch.map((p) => p.item) });
    } catch (e) {
      o.log(`manifest batch failed: ${e instanceof Error ? e.message : e}`); sum.failed += batch.length; continue;
    }
    const byLocal = new Map(batch.map((p) => [p.f.rel, p]));
    const work: Array<{ p: Pending; assetId: string; action: 'skip' | 'want_preview' | 'want_original'; upload?: import('@minnegela/shared').UploadTarget }> = [];
    for (const r of res.results) {
      const p = byLocal.get(r.localId);
      if (!p) continue;
      sum.manifested++;
      work.push({ p, assetId: r.assetId, action: r.action, upload: r.upload });
    }
    await pmap(work, o.concurrency, async (w) => {
      const set = (s: FileState['state'], error?: string) => { state.files[w.p.f.rel] = { assetId: w.assetId, md5: w.p.item.md5 ?? previously.get(w.p.f.rel)?.md5 ?? '', size: w.p.f.size, state: s, error, at: w.p.item.createdAt }; };
      try {
        if (w.action === 'skip') {
          if (previously.has(w.p.f.rel)) set('preview_uploaded'); else { set('skipped'); sum.skipped++; }
        } else if (w.action === 'want_preview') {
          const preview = w.p.f.isVideo ? await makeVideoPoster(w.p.f.abs) : await makePreview(w.p.f.abs);
          const target = w.upload ?? (await api.uploads(o.group, [{ assetId: w.assetId, kind: 'preview', bytes: preview.length, mime: 'image/jpeg' }])).items[0]!.upload;
          await Api.put(target, preview);
          await api.complete(w.assetId, 'preview', sha256(preview), preview.length);
          set('preview_uploaded'); sum.previews++;
        } else {
          set('preview_uploaded');
        }
        if (o.originals && state.files[w.p.f.rel]!.state === 'preview_uploaded') {
          const bytes = await readFile(w.p.f.abs);
          const { items } = await api.uploads(o.group, [{ assetId: w.assetId, kind: 'original', bytes: bytes.length, mime: w.p.f.mime }]);
          await Api.put(items[0]!.upload, bytes);
          await api.complete(w.assetId, 'original', sha256(bytes), bytes.length);
          set('original_uploaded'); sum.originals++;
        }
      } catch (e) {
        sum.failed++;
        set('failed', e instanceof ApiError ? e.message : String(e));
        o.log(`failed ${w.p.f.rel}: ${e instanceof Error ? e.message : e}`);
      }
      const done = sum.previews + sum.originals + sum.skipped + sum.failed;
      if (done % 25 === 0) { o.log(`progress: ${done}/${pending.length}  previews ${sum.previews}  originals ${sum.originals}  skipped ${sum.skipped}  failed ${sum.failed}`); await persist(); }
    });
    await persist();
  }
  o.log(`done: scanned ${sum.scanned}, unchanged ${sum.unchanged}, manifested ${sum.manifested}, previews ${sum.previews}, originals ${sum.originals}, skipped ${sum.skipped}, failed ${sum.failed}`);
  return sum;
}

import type { LocalAsset, LocalDb, LocalState, Counts } from '@/db/types';
import type { Library, LibraryAsset, Uploader, SyncApi, SyncDeps, PreparedUpload } from '@/sync/types';
import { defaultSettings, type Settings } from '@/store/settings';
import type { ManifestRequest, UploadTarget } from '@minnegela/shared';

export class MemoryDb implements LocalDb {
  rows = new Map<string, LocalAsset>();
  kv = new Map<string, string | null>();
  async upsertLocal(rows: Parameters<LocalDb['upsertLocal']>[0]) {
    for (const r of rows) {
      const prev = this.rows.get(r.localId);
      const state: LocalState = prev && !['new', 'excluded'].includes(prev.state) ? prev.state : (r.state ?? 'new');
      this.rows.set(r.localId, { ...(prev ?? { serverAssetId: null, lastError: null, attempts: 0 }), ...r, state, updatedAt: 'now' } as LocalAsset);
    }
  }
  async listByState(state: LocalState, limit: number, opts: { localIds?: string[] } = {}) {
    return [...this.rows.values()].filter((r) => r.state === state && (!opts.localIds || opts.localIds.includes(r.localId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async setState(id: string, patch: Parameters<LocalDb['setState']>[1]) { const r = this.rows.get(id)!; Object.assign(r, patch); }
  async allLocalIds() { return [...this.rows.values()].filter((r) => r.state !== 'deleted').map((r) => r.localId); }
  async markDeletedExcept(present: Set<string>) {
    const gone = [...this.rows.values()].filter((r) => r.state !== 'deleted' && !present.has(r.localId));
    for (const g of gone) g.state = 'deleted';
    return gone.filter((g) => g.serverAssetId);
  }
  async counts(): Promise<Counts> {
    const c = { new: 0, excluded: 0, manifested: 0, preview_uploaded: 0, original_uploaded: 0, skipped: 0, deleted: 0, failed: 0, total: 0 } as Counts;
    for (const r of this.rows.values()) { c[r.state]++; c.total++; }
    return c;
  }
  async getSyncState(k: string) { return this.kv.get(k) ?? null; }
  async setSyncState(k: string, v: string | null) { this.kv.set(k, v); }
  async reset() { this.rows.clear(); this.kv.clear(); }
}

export const asset = (i: number, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({
  localId: `L${i}`, md5: null, size: 1000 + i, mime: 'image/jpeg', filename: `IMG_${i}.jpg`, isVideo: false,
  createdAt: new Date(Date.UTC(2026, 2, 14, 20, i)).toISOString(), modifiedAt: null, lat: null, lon: null, w: 4000, h: 3000, dur: null,
  albumIds: [], albumNames: [], isScreenshot: false, uri: `ph://${i}`, ...extra,
});

export class FakeLibrary implements Library {
  constructor(public assets: LibraryAsset[] = []) {}
  async page({ createdAfter, after, first }: { createdAfter: number | null; after: string | null; first: number }) {
    const sorted = [...this.assets].filter((a) => createdAfter === null || Date.parse(a.createdAt) > createdAfter).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const start = after ? Number(after) : 0;
    const slice = sorted.slice(start, start + first);
    return { assets: slice, endCursor: String(start + slice.length), hasNextPage: start + slice.length < sorted.length };
  }
  async allIds() { return this.assets.map((a) => a.localId); }
  async md5() { return null; }
}

export class FakeApi implements SyncApi {
  manifests: ManifestRequest[] = [];
  completed: Array<{ assetId: string; kind: string; sha256: string; bytes: number }> = [];
  deleted: string[] = [];
  enrolls: Array<{ personId: number; assetIds: string[] }> = [];
  answer: (localId: string) => 'skip' | 'want_preview' | 'want_original' = () => 'want_preview';
  enrollShouldFail = false;
  async manifest(_g: string, body: ManifestRequest) {
    this.manifests.push(body);
    return { results: body.assets.map((a) => ({ localId: a.localId, assetId: `srv-${a.localId}`, action: this.answer(a.localId), upload: this.answer(a.localId) === 'want_preview' ? target(`prev-${a.localId}`) : undefined })) };
  }
  async uploads(_g: string, items: Array<{ assetId: string; kind: 'preview' | 'original'; bytes: number; mime: string }>) {
    return { items: items.map((i) => ({ assetId: i.assetId, kind: i.kind, upload: target(`${i.kind}-${i.assetId}`) })) };
  }
  async complete(assetId: string, kind: 'preview' | 'original', sha256: string, bytes: number) { this.completed.push({ assetId, kind, sha256, bytes }); }
  async deleteAsset(id: string) { this.deleted.push(id); }
  async enroll(personId: number, assetIds: string[]) { if (this.enrollShouldFail) throw new Error('No faces found on the reference photos yet'); this.enrolls.push({ personId, assetIds }); }
}
const target = (key: string): UploadTarget => ({ url: `https://storage/${key}`, headers: { 'content-type': 'image/jpeg' }, expiresAt: new Date(Date.now() + 900_000).toISOString(), key });

export class FakeUploader implements Uploader {
  puts: string[] = [];
  failFor = new Set<string>();
  async preparePreview(a: LocalAsset): Promise<PreparedUpload> { return { fileUri: `${a.uri}.preview`, bytes: 300_000, sha256: 'a'.repeat(64), mime: 'image/jpeg', cleanup: async () => {} }; }
  async prepareOriginal(a: LocalAsset): Promise<PreparedUpload> { return { fileUri: a.uri, bytes: a.size, sha256: 'b'.repeat(64), mime: a.mime, cleanup: async () => {} }; }
  async put(t: UploadTarget) { if (this.failFor.has(t.key)) throw new Error(`put failed ${t.key}`); this.puts.push(t.key); }
}

export function makeDeps(over: Omit<Partial<SyncDeps>, 'settings'> & { settings?: Partial<Settings> } = {}) {
  const db = over.db ?? new MemoryDb();
  const settings: Settings = { ...defaultSettings(), groupId: 'g1', deviceId: 'd1', onboardingDone: true, ...(over.settings as Partial<Settings>) };
  let current = settings;
  const deps: SyncDeps = {
    db,
    api: over.api ?? new FakeApi(),
    library: over.library ?? new FakeLibrary(),
    uploader: over.uploader ?? new FakeUploader(),
    conditions: over.conditions ?? (async () => ({ online: true, wifi: true, charging: true })),
    settings: () => current,
    saveSettings: async (s) => { current = s; },
    personId: over.personId ?? (() => 7),
    now: over.now,
  };
  return { deps, db, api: deps.api as FakeApi, uploader: deps.uploader as FakeUploader, settings: () => current };
}

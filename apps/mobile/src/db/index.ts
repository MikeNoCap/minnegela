import * as SQLite from 'expo-sqlite';
import type { LocalAsset, LocalDb, LocalState, Counts } from './types';

const SCHEMA_VERSION = 1;
const STATES: LocalState[] = ['new', 'excluded', 'manifested', 'preview_uploaded', 'original_uploaded', 'skipped', 'deleted', 'failed'];

type Row = {
  local_id: string; md5: string | null; size: number; mime: string; filename: string; is_video: number; created_at: string; modified_at: string | null;
  lat: number | null; lon: number | null; w: number | null; h: number | null; dur: number | null; album_ids: string; album_names: string; is_screenshot: number;
  uri: string; server_asset_id: string | null; state: LocalState; last_error: string | null; attempts: number; updated_at: string;
};
const fromRow = (r: Row): LocalAsset => ({
  localId: r.local_id, md5: r.md5, size: r.size, mime: r.mime, filename: r.filename, isVideo: !!r.is_video, createdAt: r.created_at, modifiedAt: r.modified_at,
  lat: r.lat, lon: r.lon, w: r.w, h: r.h, dur: r.dur, albumIds: JSON.parse(r.album_ids || '[]'), albumNames: JSON.parse(r.album_names || '[]'), isScreenshot: !!r.is_screenshot,
  uri: r.uri, serverAssetId: r.server_asset_id, state: r.state, lastError: r.last_error, attempts: r.attempts, updatedAt: r.updated_at,
});

export async function openLocalDb(name = 'minnegela.db'): Promise<LocalDb> {
  const db = await SQLite.openDatabaseAsync(name);
  const v = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (v < 1) {
    await db.execAsync(`
      create table if not exists local_assets (
        local_id text primary key, md5 text, size integer not null, mime text not null, filename text not null, is_video integer not null default 0,
        created_at text not null, modified_at text, lat real, lon real, w integer, h integer, dur real,
        album_ids text not null default '[]', album_names text not null default '[]', is_screenshot integer not null default 0,
        uri text not null, server_asset_id text, state text not null default 'new', last_error text, attempts integer not null default 0,
        updated_at text not null
      );
      create index if not exists local_assets_state on local_assets(state, created_at);
      create table if not exists sync_state (key text primary key, value text);
      pragma user_version = ${SCHEMA_VERSION};`);
  }
  return new SqliteLocalDb(db);
}

class SqliteLocalDb implements LocalDb {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async upsertLocal(rows: Parameters<LocalDb['upsertLocal']>[0]) {
    const now = new Date().toISOString();
    await this.db.withTransactionAsync(async () => {
      for (const r of rows) {
        await this.db.runAsync(
          `insert into local_assets (local_id, md5, size, mime, filename, is_video, created_at, modified_at, lat, lon, w, h, dur, album_ids, album_names, is_screenshot, uri, state, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(local_id) do update set size = excluded.size, modified_at = excluded.modified_at, album_ids = excluded.album_ids, album_names = excluded.album_names,
             uri = excluded.uri, updated_at = excluded.updated_at,
             state = case when local_assets.state in ('new','excluded') then excluded.state else local_assets.state end`,
          [r.localId, r.md5, r.size, r.mime, r.filename, r.isVideo ? 1 : 0, r.createdAt, r.modifiedAt, r.lat, r.lon, r.w, r.h, r.dur,
            JSON.stringify(r.albumIds), JSON.stringify(r.albumNames), r.isScreenshot ? 1 : 0, r.uri, r.state ?? 'new', now]);
      }
    });
  }
  async listByState(state: LocalState, limit: number, opts: { localIds?: string[] } = {}) {
    if (opts.localIds?.length) {
      const q = opts.localIds.map(() => '?').join(',');
      return (await this.db.getAllAsync<Row>(`select * from local_assets where state = ? and local_id in (${q}) order by created_at desc limit ?`, [state, ...opts.localIds, limit])).map(fromRow);
    }
    return (await this.db.getAllAsync<Row>('select * from local_assets where state = ? order by created_at desc limit ?', [state, limit])).map(fromRow);
  }
  async get(localId: string) {
    const r = await this.db.getFirstAsync<Row>('select * from local_assets where local_id = ?', [localId]);
    return r ? fromRow(r) : null;
  }
  async setState(localId: string, patch: Parameters<LocalDb['setState']>[1]) {
    const sets: string[] = ['updated_at = ?']; const vals: SQLite.SQLiteBindValue[] = [new Date().toISOString()];
    if (patch.state !== undefined) { sets.push('state = ?'); vals.push(patch.state); }
    if (patch.serverAssetId !== undefined) { sets.push('server_asset_id = ?'); vals.push(patch.serverAssetId); }
    if (patch.md5 !== undefined) { sets.push('md5 = ?'); vals.push(patch.md5); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); vals.push(patch.lastError); }
    if (patch.attempts !== undefined) { sets.push('attempts = ?'); vals.push(patch.attempts); }
    vals.push(localId);
    await this.db.runAsync(`update local_assets set ${sets.join(', ')} where local_id = ?`, vals);
  }
  async allLocalIds() {
    return (await this.db.getAllAsync<{ local_id: string }>("select local_id from local_assets where state <> 'deleted'")).map((r) => r.local_id);
  }
  async markDeletedExcept(presentIds: Set<string>) {
    const rows = (await this.db.getAllAsync<Row>("select * from local_assets where state <> 'deleted'")).map(fromRow).filter((r) => !presentIds.has(r.localId));
    await this.db.withTransactionAsync(async () => {
      for (const r of rows) await this.db.runAsync("update local_assets set state = 'deleted', updated_at = ? where local_id = ?", [new Date().toISOString(), r.localId]);
    });
    return rows.filter((r) => r.serverAssetId);
  }
  async counts(): Promise<Counts> {
    const rows = await this.db.getAllAsync<{ state: LocalState; n: number }>('select state, count(*) as n from local_assets group by state');
    const c = Object.fromEntries(STATES.map((s) => [s, 0])) as Counts; c.total = 0;
    for (const r of rows) { c[r.state] = r.n; c.total += r.n; }
    return c;
  }
  async getSyncState(key: string) {
    return (await this.db.getFirstAsync<{ value: string | null }>('select value from sync_state where key = ?', [key]))?.value ?? null;
  }
  async setSyncState(key: string, value: string | null) {
    await this.db.runAsync('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value', [key, value]);
  }
  async reset() {
    await this.db.execAsync('delete from local_assets; delete from sync_state;');
  }
}

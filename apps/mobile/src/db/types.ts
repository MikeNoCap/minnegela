/** §16.2 local index. */
export type LocalState = 'new' | 'excluded' | 'manifested' | 'preview_uploaded' | 'original_uploaded' | 'skipped' | 'deleted' | 'failed';

export type LocalAsset = {
  localId: string;
  md5: string | null;
  size: number;
  mime: string;
  filename: string;
  isVideo: boolean;
  createdAt: string;           // ISO with offset
  modifiedAt: string | null;
  lat: number | null;
  lon: number | null;
  w: number | null;
  h: number | null;
  dur: number | null;          // seconds
  albumIds: string[];
  albumNames: string[];
  isScreenshot: boolean;
  uri: string;                 // local file uri (ph:// or content://)
  serverAssetId: string | null;
  state: LocalState;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
};

export type Counts = Record<LocalState, number> & { total: number };

export interface LocalDb {
  upsertLocal(rows: Array<Omit<LocalAsset, 'serverAssetId' | 'state' | 'lastError' | 'attempts' | 'updatedAt'> & { state?: LocalState }>): Promise<void>;
  listByState(state: LocalState, limit: number, opts?: { localIds?: string[] }): Promise<LocalAsset[]>;
  get(localId: string): Promise<LocalAsset | null>;
  /** Match a picker result back to indexed library assets (Android's system picker returns no assetId). */
  findByFile(filename: string, size?: number | null): Promise<LocalAsset[]>;
  setState(localId: string, patch: Partial<Pick<LocalAsset, 'state' | 'serverAssetId' | 'md5' | 'lastError' | 'attempts'>>): Promise<void>;
  allLocalIds(): Promise<string[]>;
  markDeletedExcept(presentIds: Set<string>): Promise<LocalAsset[]>;   // returns rows newly marked deleted that had a server id
  counts(): Promise<Counts>;
  getSyncState(key: string): Promise<string | null>;
  setSyncState(key: string, value: string | null): Promise<void>;
  reset(): Promise<void>;
}

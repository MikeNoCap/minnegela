import type { ManifestRequest, ManifestResponse, UploadTarget } from '@minnegela/shared';
import type { LocalAsset, LocalDb } from '@/db/types';
import type { Settings } from '@/store/settings';
import type { Conditions } from './policy';

/** A library asset as the OS reports it (adapter output; pure modules never touch expo-media-library). */
export type LibraryAsset = Omit<LocalAsset, 'serverAssetId' | 'state' | 'lastError' | 'attempts' | 'updatedAt' | 'md5'> & { md5: string | null };

export type LibraryPage = { assets: LibraryAsset[]; endCursor: string | null; hasNextPage: boolean };

export interface Library {
  /** Assets created after `createdAfter` (ms epoch), oldest first, paged. */
  page(opts: { createdAfter: number | null; after: string | null; first: number; includeVideos: boolean }): Promise<LibraryPage>;
  /** Every id currently in the library (for weekly reconciliation). */
  allIds(): Promise<string[]>;
  /** Cheap content identity when the platform can give it (iOS md5); null on Android (§16.4). */
  md5(a: LibraryAsset): Promise<string | null>;
}

export type PreparedUpload = { fileUri: string; bytes: number; sha256: string; mime: string; cleanup: () => Promise<void> };

export interface Uploader {
  /** Make the 1600 px preview (or video poster) on disk; returns size + sha256. */
  preparePreview(a: LocalAsset): Promise<PreparedUpload>;
  /** Copy/locate the original as an uploadable file. */
  prepareOriginal(a: LocalAsset): Promise<PreparedUpload>;
  /** PUT to a presigned target (background session on iOS). Throws on non-2xx. */
  put(target: UploadTarget, file: PreparedUpload): Promise<void>;
}

export interface SyncApi {
  manifest(groupId: string, body: ManifestRequest): Promise<ManifestResponse>;
  uploads(groupId: string, items: Array<{ assetId: string; kind: 'preview' | 'original'; bytes: number; mime: string }>): Promise<{ items: Array<{ assetId: string; kind: 'preview' | 'original'; upload: UploadTarget }> }>;
  complete(assetId: string, kind: 'preview' | 'original', sha256: string, bytes: number): Promise<unknown>;
  deleteAsset(assetId: string): Promise<unknown>;
  enroll(personId: number, assetIds: string[]): Promise<unknown>;
}

export type SyncDeps = {
  db: LocalDb;
  api: SyncApi;
  library: Library;
  uploader: Uploader;
  conditions: () => Promise<Conditions>;
  settings: () => Settings;
  /** Persist settings changes made by the runner (enrollment progress). */
  saveSettings: (s: Settings) => Promise<void>;
  personId: () => number | null;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type SyncProgress = { phase: 'enumerate' | 'reconcile' | 'manifest' | 'preview' | 'original' | 'enroll' | 'idle'; done: number; total: number; message?: string };
export type SyncSummary = { enumerated: number; manifested: number; previews: number; originals: number; deleted: number; failed: number; stoppedEarly: boolean; lastError: string | null; enrolled: boolean };

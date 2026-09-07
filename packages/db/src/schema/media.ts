import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, real, doublePrecision, boolean, vector, primaryKey, index, unique } from 'drizzle-orm/pg-core';
import { bytea, bit64 } from './custom.js';
import { users } from './auth.js';
import { groups, devices } from './tenancy.js';

export type Tag = { tag: string; score: number };
export type Quality = { sharpness?: number; exposure?: number; aesthetic?: number };

export const blobs = pgTable('blobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  sha256: bytea('sha256'),
  md5: bytea('md5'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  phash: bit64('phash'),
  storageKey: text('storage_key'),
  previewKey: text('preview_key'),
  thumbKey: text('thumb_key'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  capturedTz: text('captured_tz'),
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  gpsAccuracyM: real('gps_accuracy_m'),
  city: text('city'),
  cameraMake: text('camera_make'),
  cameraModel: text('camera_model'),
  exif: jsonb('exif').$type<Record<string, unknown>>(),
  isUtility: boolean('is_utility').notNull().default(false),
  timeUncertain: boolean('time_uncertain').notNull().default(false),
  clipEmb: vector('clip_emb', { dimensions: 512 }),
  clipModel: text('clip_model'),
  tags: jsonb('tags').$type<Tag[]>().notNull().default([]),
  quality: jsonb('quality').$type<Quality>(),
  nFaces: integer('n_faces').notNull().default(0),
  nearDupGroupId: uuid('near_dup_group_id'),
  variantOf: uuid('variant_of'),
  derivedAt: timestamp('derived_at', { withTimezone: true }),
  analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('blobs_group_time').on(t.groupId, t.capturedAt)]);

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  blobId: uuid('blob_id').notNull().references(() => blobs.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  localId: text('local_id').notNull(),
  filename: text('filename'),
  albumNames: text('album_names').array().notNull().default([]),
  localCreatedAt: timestamp('local_created_at', { withTimezone: true }).notNull(),
  localModifiedAt: timestamp('local_modified_at', { withTimezone: true }),
  isFavorite: boolean('is_favorite').notNull().default(false),
  visibility: text('visibility', { enum: ['group', 'hidden'] }).notNull().default('group'),
  excludedReason: text('excluded_reason'),
  personIds: integer('person_ids').array().notNull().default([]),
  previewUploadedAt: timestamp('preview_uploaded_at', { withTimezone: true }),
  originalUploadedAt: timestamp('original_uploaded_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.deviceId, t.localId), index('assets_group_owner').on(t.groupId, t.ownerUserId), index('assets_blob').on(t.blobId)]);

export const derivatives = pgTable('derivatives', {
  blobId: uuid('blob_id').notNull().references(() => blobs.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['thumb320', 'preview1600', 'poster', 'frame', 'video720'] }).notNull(),
  frameIndex: integer('frame_index').notNull().default(-1),
  storageKey: text('storage_key').notNull(),
  width: integer('width'),
  height: integer('height'),
  bytes: integer('bytes'),
}, (t) => [primaryKey({ columns: [t.blobId, t.kind, t.frameIndex] })]);

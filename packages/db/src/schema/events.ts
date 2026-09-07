import { pgTable, uuid, text, timestamp, integer, real, doublePrecision, boolean, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { groups } from './tenancy.js';
import { blobs, assets } from './media.js';
import { persons } from './people.js';

export const places = pgTable('places', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  name: text('name'),
  city: text('city'),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  radiusM: real('radius_m').notNull().default(300),
  nEvents: integer('n_events').notNull().default(0),
  homeOfUserId: uuid('home_of_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['event', 'trip', 'loose'] }).notNull().default('event'),
  titleAuto: text('title_auto'),
  titleManual: text('title_manual'),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  tz: text('tz'),
  centerLat: doublePrecision('center_lat'),
  centerLon: doublePrecision('center_lon'),
  placeId: uuid('place_id').references(() => places.id, { onDelete: 'set null' }),
  contributorIds: uuid('contributor_ids').array().notNull().default([]),
  personIds: integer('person_ids').array().notNull().default([]),
  nAssets: integer('n_assets').notNull().default(0),
  nVideos: integer('n_videos').notNull().default(0),
  confidence: real('confidence').notNull().default(0),
  coverBlobId: uuid('cover_blob_id').references(() => blobs.id, { onDelete: 'set null' }),
  isPublicToGroup: boolean('is_public_to_group').notNull().default(false),
  openedByUserId: uuid('opened_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  suggestedSplits: timestamp('suggested_splits', { withTimezone: true }).array().notNull().default([]),
  algoVersion: integer('algo_version').notNull().default(1),
  frozen: boolean('frozen').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('events_group_time').on(t.groupId, t.startAt)]);

export const eventAssets = pgTable('event_assets', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  blobId: uuid('blob_id').notNull().references(() => blobs.id, { onDelete: 'cascade' }),
  confidence: real('confidence').notNull(),
  tier: text('tier', { enum: ['confirmed', 'probable', 'uncertain'] }).notNull(),
  source: text('source', { enum: ['auto', 'manual'] }).notNull(),
}, (t) => [primaryKey({ columns: [t.eventId, t.assetId] }), index('event_assets_blob').on(t.blobId), index('event_assets_asset').on(t.assetId)]);

export const eventPersonTags = pgTable('event_person_tags', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  personId: integer('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
  byUserId: uuid('by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.eventId, t.personId] })]);

export const moments = pgTable('moments', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  label: text('label'),
  nAssets: integer('n_assets').notNull(),
  blobIds: uuid('blob_ids').array().notNull(),
  centerLat: doublePrecision('center_lat'),
  centerLon: doublePrecision('center_lon'),
}, (t) => [index('moments_event').on(t.eventId, t.startAt)]);

export const eventConstraints = pgTable('event_constraints', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['pin_boundary', 'keep_together', 'exclude', 'include', 'frozen'] }).notNull(),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }),
  assetIds: uuid('asset_ids').array(),
  byUserId: uuid('by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

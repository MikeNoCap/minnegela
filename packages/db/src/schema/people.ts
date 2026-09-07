import { pgTable, pgSchema, uuid, text, timestamp, jsonb, integer, serial, smallint, real, boolean, vector, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { groups } from './tenancy.js';
import { blobs } from './media.js';

export const ml = pgSchema('ml');

export const persons = pgTable('persons', {
  id: serial('id').primaryKey(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name'),
  hidden: boolean('hidden').notNull().default(false),
  coverFaceId: uuid('cover_face_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('persons_group').on(t.groupId)]);

export type FaceBox = { x: number; y: number; w: number; h: number };

export const faces = pgTable('faces', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  blobId: uuid('blob_id').notNull().references(() => blobs.id, { onDelete: 'cascade' }),
  frameIndex: integer('frame_index').notNull().default(-1),
  box: jsonb('box').$type<FaceBox>().notNull(),
  landmarks: jsonb('landmarks').$type<number[][]>(),
  detScore: real('det_score').notNull(),
  qualityFlags: text('quality_flags').array().notNull().default([]),
  cropKey: text('crop_key'),
  personId: integer('person_id').references(() => persons.id, { onDelete: 'set null' }),
  matchScore: real('match_score'),
  tier: text('tier', { enum: ['confirmed', 'high', 'probable', 'low'] }),
  matchSource: text('match_source', { enum: ['auto', 'label', 'context'] }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('faces_group_person').on(t.groupId, t.personId), index('faces_blob').on(t.blobId)]);

/** ml schema: readable by the worker role only. */
export const faceEmbeddings = ml.table('face_embeddings', {
  faceId: uuid('face_id').primaryKey().references(() => faces.id, { onDelete: 'cascade' }),
  emb: vector('emb', { dimensions: 512 }).notNull(),
  model: text('model').notNull(),
});
export const personPrototypes = ml.table('person_prototypes', {
  personId: integer('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
  idx: smallint('idx').notNull(),
  emb: vector('emb', { dimensions: 512 }).notNull(),
  nFaces: integer('n_faces').notNull(),
}, (t) => [primaryKey({ columns: [t.personId, t.idx] })]);

export const faceLabels = pgTable('face_labels', {
  faceId: uuid('face_id').notNull().references(() => faces.id, { onDelete: 'cascade' }),
  personId: integer('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
  verdict: text('verdict', { enum: ['confirm', 'reject'] }).notNull(),
  byUserId: uuid('by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.faceId, t.personId] })]);

export const unknownClusters = pgTable('unknown_clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  faceIds: uuid('face_ids').array().notNull(),
  coverFaceId: uuid('cover_face_id'),
  n: integer('n').notNull(),
  dismissed: boolean('dismissed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

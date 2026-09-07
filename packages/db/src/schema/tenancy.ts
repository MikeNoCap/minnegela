import { pgTable, uuid, text, timestamp, jsonb, integer, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  settings: jsonb('settings').$type<{ cluster_unknown_faces?: boolean }>().notNull().default({ cluster_unknown_faces: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const groupMembers = pgTable('group_members', {
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  consentFacesAt: timestamp('consent_faces_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user').on(t.userId)]);

export const groupInvites = pgTable('group_invites', {
  code: text('code').primaryKey(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: uuid('used_by').references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['ios', 'android', 'cli', 'web'] }).notNull(),
  name: text('name').notNull(),
  clockOffsetS: integer('clock_offset_s').notNull().default(0),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  pushToken: text('push_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('devices_user').on(t.userId)]);

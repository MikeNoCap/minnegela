import { pgTable, uuid, text, timestamp, jsonb, integer, bigserial, vector, index } from 'drizzle-orm/pg-core';
import { inet } from './custom.js';
import { groups } from './tenancy.js';

export const jobs = pgTable('jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  priority: integer('priority').notNull().default(0),
  dedupeKey: text('dedupe_key'),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  doneAt: timestamp('done_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  ip: inet('ip'),
  ua: text('ua'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_group_time').on(t.groupId, t.at)]);

export const searchTextCache = pgTable('search_text_cache', {
  query: text('query').primaryKey(),
  model: text('model').notNull(),
  emb: vector('emb', { dimensions: 512 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

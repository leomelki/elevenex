import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const sessionLaunches = sqliteTable('session_launches', {
  key: text('key').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  sessionId: integer('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  delivery: text('delivery', {
    enum: ['ready', 'dispatching', 'accepted', 'failed'],
  }),
});

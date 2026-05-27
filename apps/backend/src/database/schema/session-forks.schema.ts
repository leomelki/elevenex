import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const sessionForks = sqliteTable('session_forks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentSessionId: integer('parent_session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  childSessionId: integer('child_session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' })
    .unique(),
  provider: text('provider').notNull(),
  anchorMessageId: text('anchor_message_id').notNull(),
  anchorMessageKind: text('anchor_message_kind').notNull(),
  anchorExcerpt: text('anchor_excerpt'),
  draft: text('draft'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

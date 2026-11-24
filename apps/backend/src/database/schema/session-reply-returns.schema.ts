import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const sessionReplyReturns = sqliteTable('session_reply_returns', {
  sessionId: integer('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  recipientId: integer('recipient_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  at: text('at').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionId, table.itemId, table.recipientId] }),
  index('session_reply_returns_recent_idx').on(table.sessionId, table.at),
  index('session_reply_returns_recipient_idx').on(table.recipientId),
]);

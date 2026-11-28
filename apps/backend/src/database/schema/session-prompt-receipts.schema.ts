import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

/** A send receipt survives its provider turn and makes retries safe. No prompt bodies are duplicated. */
export const sessionPromptReceipts = sqliteTable(
  'session_prompt_receipts',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    fingerprint: text('fingerprint').notNull(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id').references(() => sessions.id, {
      onDelete: 'cascade',
    }),
    delivery: text('delivery', {
      enum: ['preparing', 'dispatching', 'accepted', 'failed', 'unconfirmed'],
    }).notNull(),
    disposition: text('disposition', {
      enum: ['running', 'queued', 'steered'],
    }),
  },
  (table) => [index('session_prompt_receipts_session_idx').on(table.sessionId)],
);

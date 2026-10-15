import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';
import type { TurnChangeDetails } from '../../agent-runtime/turn-change-stats.js';

export const turnChanges = sqliteTable(
  'turn_changes',
  {
    id: text('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    conversationId: text('conversation_id').notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    details: text('details', { mode: 'json' })
      .$type<TurnChangeDetails>()
      .notNull(),
  },
  (table) => [
    index('turn_changes_conversation_idx').on(
      table.sessionId,
      table.provider,
      table.conversationId,
    ),
  ],
);

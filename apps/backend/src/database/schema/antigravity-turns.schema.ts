import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AgentTranscriptItem } from '../../agent-runtime/agent-runtime.types.js';
import { sessions } from './sessions.schema.js';

export const antigravityTurns = sqliteTable(
  'antigravity_turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    items: text('items', { mode: 'json' })
      .$type<AgentTranscriptItem[]>()
      .notNull(),
  },
  (table) => [
    index('antigravity_turns_session_idx').on(table.sessionId, table.id),
  ],
);

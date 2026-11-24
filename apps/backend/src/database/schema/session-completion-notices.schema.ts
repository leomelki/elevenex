import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const sessionCompletionNotices = sqliteTable(
  'session_completion_notices',
  {
    sessionId: integer('session_id')
      .primaryKey()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    recipientId: integer('recipient_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    state: text('state', {
      enum: [
        'waiting',
        'ready',
        'dispatching',
        'accepted',
        'consumed',
        'unconfirmed',
      ],
    }).notNull(),
    outcome: text('outcome', { enum: ['completed', 'failed'] }),
  },
  (table) => [
    index('session_completion_notices_state_idx').on(
      table.state,
      table.sessionId,
    ),
    index('session_completion_notices_recipient_idx').on(
      table.recipientId,
      table.state,
      table.sessionId,
    ),
  ],
);

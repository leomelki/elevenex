import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';
import { sessionPromptReceipts } from './session-prompt-receipts.schema.js';

export const sessionCompletionNotices = sqliteTable(
  'session_completion_notices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    promptId: text('prompt_id').references(() => sessionPromptReceipts.id, {
      onDelete: 'cascade',
    }),
    completionAfter: text('completion_after'),
    replyId: text('reply_id'),
    replyText: text('reply_text'),
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
    actionKey: text('action_key'),
    actionDelivered: integer('action_delivered', { mode: 'boolean' })
      .notNull()
      .default(false),
    outcome: text('outcome', { enum: ['completed', 'failed'] }),
  },
  (table) => [
    index('session_completion_notices_state_idx').on(table.state, table.id),
    index('session_completion_notices_recipient_idx').on(
      table.recipientId,
      table.state,
      table.id,
    ),
    index('session_completion_notices_session_idx').on(
      table.sessionId,
      table.state,
      table.id,
    ),
    uniqueIndex('session_completion_notices_prompt_idx').on(table.promptId),
  ],
);

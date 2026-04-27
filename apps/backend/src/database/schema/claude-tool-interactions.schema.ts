import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const claudeToolInteractions = sqliteTable(
  'claude_tool_interactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    toolUseId: text('tool_use_id').notNull(),
    toolName: text('tool_name').notNull(),
    interactionKind: text('interaction_kind').notNull(),
    decision: text('decision').notNull(),
    remember: integer('remember', { mode: 'boolean' }).notNull().default(false),
    responseContent: text('response_content'),
    requestSnapshot: text('request_snapshot').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at').notNull(),
  },
  (table) => ({
    sessionToolUseIdx: uniqueIndex('claude_tool_interactions_session_tool_use_idx').on(
      table.sessionId,
      table.toolUseId,
    ),
  }),
);

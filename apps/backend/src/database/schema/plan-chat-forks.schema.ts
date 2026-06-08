import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

export const planChatForks = sqliteTable(
  'plan_chat_forks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parentSessionId: integer('parent_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    childSessionId: integer('child_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' })
      .unique(),
    provider: text('provider').notNull(),
    reviewId: text('review_id').notNull(),
    anchorMessageId: text('anchor_message_id').notNull(),
    anchorMessageKind: text('anchor_message_kind').notNull(),
    anchorExcerpt: text('anchor_excerpt'),
    planExcerpt: text('plan_excerpt'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    parentReviewIdx: uniqueIndex('plan_chat_forks_parent_review_idx').on(
      table.parentSessionId,
      table.reviewId,
    ),
  }),
);

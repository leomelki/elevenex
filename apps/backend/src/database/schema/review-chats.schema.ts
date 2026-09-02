import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

/**
 * A side discussion opened from the code review workspace.
 *
 * Each row pairs the session under review with a hidden forked child session
 * (`surface: 'embedded_review_chat'`) that inherits the parent's conversation
 * but is locked to plan mode until the user explicitly unlocks it.
 *
 * Unlike `plan_chat_forks`, a review chat is anchored to *code* rather than to
 * a transcript message, and may accumulate several anchors as the user adds
 * further selections to the same thread.
 */
export const reviewChats = sqliteTable(
  'review_chats',
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
    title: text('title').notNull(),
    /** `readonly` keeps the fork in plan mode; `write` lets it edit the worktree. */
    mode: text('mode').notNull().default('readonly'),
    /** `open` | `resolved` | `promoted` */
    status: text('status').notNull().default('open'),
    scope: text('scope').notNull(),
    /** Primary anchored file, denormalized for cheap listing and grouping. */
    filePath: text('file_path'),
    /** Serialized `DiffSelectionMention[]` — the full anchor payload. */
    anchorsJson: text('anchors_json').notNull(),
    /** Diff identity of the anchored file when the thread was created. */
    changeHash: text('change_hash'),
    /** Content identity of the anchored file when the thread was created. */
    fingerprint: text('fingerprint'),
    /** Transcript message the child was forked from. */
    anchorMessageId: text('anchor_message_id').notNull(),
    anchorMessageKind: text('anchor_message_kind').notNull(),
    /**
     * The parent turn this thread belongs to, for grouping the inline card in
     * the main chat. Distinct from `anchorMessageId`, which is the assistant
     * uuid the fork was cut at.
     */
    turnKey: text('turn_key'),
    /** Set once the thread has been promoted into a standalone session. */
    promotedForkId: integer('promoted_fork_id'),
    /** Last time the user viewed this thread, for unread badges. */
    lastReadAt: text('last_read_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    parentIdx: index('review_chats_parent_idx').on(table.parentSessionId),
  }),
);

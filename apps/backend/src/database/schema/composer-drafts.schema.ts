import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.schema.js';

/**
 * Text the user typed into a session composer but has not sent yet.
 *
 * Kept server-side rather than in the browser on purpose. Session ids are only
 * meaningful inside *this* database, while a renderer's local storage is shared
 * by every window and survives switching backend, reinstalling, or restoring a
 * database — so a client-side draft store keyed on a session id will eventually
 * hand a draft to a session that never had one. Here the draft is a column of
 * the session itself: it cannot outlive it (cascade), and it cannot be read by
 * anything but that session.
 *
 * One row per session, keyed by the session id: a composer has exactly one
 * pending draft.
 */
export const composerDrafts = sqliteTable('composer_drafts', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  /** Serialized `DiffSelectionMention[]`. */
  diffMentionsJson: text('diff_mentions_json').notNull().default('[]'),
  /** Serialized `SessionMention[]`. */
  sessionMentionsJson: text('session_mentions_json').notNull().default('[]'),
  /** Serialized `ComposerImageAttachment[]` — data URLs, hence the size cap. */
  imagesJson: text('images_json').notNull().default('[]'),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';

export const worktreeContexts = sqliteTable('worktree_contexts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  worktreePath: text('worktree_path').notNull(),
  rootRef: text('root_ref'),
  contextSentence: text('context_sentence'),
  generationStatus: text('generation_status').notNull().default('idle'),
  generatedAt: text('generated_at'),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}, table => ({
  repoWorktreeIdx: uniqueIndex('worktree_contexts_repo_worktree_idx').on(table.repoId, table.worktreePath),
}));

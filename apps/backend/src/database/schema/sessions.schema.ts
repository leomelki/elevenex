import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  branchName: text('branch_name').notNull(),
  worktreePath: text('worktree_path').notNull(),
  name: text('name'),
  status: text('status').notNull().default('created'),
  activeAgentProvider: text('active_agent_provider').notNull().default('claude'),
  claudeSessionId: text('claude_session_id').default('-1'),
  codexSessionId: text('codex_session_id').default('-1'),
  piSessionPath: text('pi_session_path').default('-1'),
  hasInjectedWorktreeContext: integer('has_injected_worktree_context', { mode: 'boolean' })
    .notNull()
    .default(false),
  hasUnreviewedCompletion: integer('has_unreviewed_completion', { mode: 'boolean' })
    .notNull()
    .default(false),
  lastCompletionAt: text('last_completion_at'),
  lastCompletionKind: text('last_completion_kind'),
  lastStateChangeAt: text('last_state_change_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

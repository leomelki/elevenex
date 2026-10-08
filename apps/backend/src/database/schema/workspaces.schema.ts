import { integer, text, sqliteTable, index } from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';
import { repoWorktrees } from './repo-worktrees.schema.js';

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    poolWorktreeId: integer('pool_worktree_id').references(
      () => repoWorktrees.id,
      { onDelete: 'set null' },
    ),
    isDefault: integer('is_default', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdFromRef: text('created_from_ref'),
    archivedAt: text('archived_at'),
    taskState: text('task_state').notNull().default('ready'),
    taskBranch: text('task_branch'),
    sourceRef: text('source_ref'),
    checkoutMode: text('checkout_mode').notNull().default('branch'),
    startingCommit: text('starting_commit'),
    finalCommit: text('final_commit'),
    taskConfig: text('task_config'),
    taskError: text('task_error'),
    taskDraft: text('task_draft').notNull().default(''),
    taskRequestId: text('task_request_id').unique(),
    linkStatus: text('link_status').notNull().default('linked'),
    desiredBranch: text('desired_branch'),
    unlinkedAt: text('unlinked_at'),
    unlinkedByProjectId: integer('unlinked_by_project_id'),
    pendingStashCommit: text('pending_stash_commit'),
    pendingStashMessage: text('pending_stash_message'),
    pendingStashCreatedAt: text('pending_stash_created_at'),
    pendingStashStatus: text('pending_stash_status'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('workspaces_repo_lifecycle_idx').on(table.repoId, table.archivedAt),
    index('workspaces_assignment_idx').on(table.poolWorktreeId, table.linkStatus),
  ],
);

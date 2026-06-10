import { integer, text, sqliteTable, unique } from 'drizzle-orm/sqlite-core';
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
    unique().on(table.repoId, table.name),
    unique().on(table.repoId, table.path),
  ],
);

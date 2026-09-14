import {
  integer,
  text,
  sqliteTable,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';
import { workspaces } from './workspaces.schema.js';

/** A user-defined grouping of sessions inside a single workspace/worktree. */
export const sessionFolders = sqliteTable(
  'session_folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archivedAt: text('archived_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('session_folders_workspace_name_idx').on(
      table.workspaceId,
      table.name,
    ),
  ],
);

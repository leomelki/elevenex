import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const repoWorktrees = sqliteTable(
  'repo_worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoRootPath: text('repo_root_path').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    createdFromRef: text('created_from_ref'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [unique().on(table.repoRootPath, table.path)],
);

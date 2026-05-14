import { integer, text, sqliteTable, unique } from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdFromRef: text('created_from_ref'),
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

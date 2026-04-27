import { integer, text, sqliteTable, unique } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.schema.js';

export const repos = sqliteTable(
  'repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    color: text('color'), // Hex color for repo identification (e.g., '#3b82f6')
    preferredContextRootRef: text('preferred_context_root_ref'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [unique().on(table.projectId, table.path)],
);

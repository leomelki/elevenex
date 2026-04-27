import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.schema.js';

export const browserIsolationSettings = sqliteTable('browser_isolation_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('shared'),
  sharedGlobs: text('shared_globs').notNull().default('[]'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}, table => ({
  projectIdx: uniqueIndex('browser_isolation_settings_project_idx').on(table.projectId),
}));

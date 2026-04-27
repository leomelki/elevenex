import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.schema.js';

export const projectBrowserState = sqliteTable('project_browser_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tabId: text('tab_id').notNull(),
  url: text('url').notNull(),
  position: integer('position').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  customTitle: text('custom_title'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}, table => ({
  projectTabIdx: uniqueIndex('project_browser_state_project_tab_idx').on(table.projectId, table.tabId),
}));

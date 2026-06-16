import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  // System projects are managed by Elevenex itself (e.g. the Elevenex agent
  // workspace) and are hidden from the normal project/navigation surfaces.
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  archivedAt: text('archived_at'),
});

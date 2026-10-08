import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.schema.js';

export const userTerminals = sqliteTable('user_terminals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreePath: text('worktree_path').notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  shell: text('shell').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

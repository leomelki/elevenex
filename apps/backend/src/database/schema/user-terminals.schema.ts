import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';

export const userTerminals = sqliteTable('user_terminals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreePath: text('worktree_path').notNull(),
  name: text('name').notNull(),
  shell: text('shell').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

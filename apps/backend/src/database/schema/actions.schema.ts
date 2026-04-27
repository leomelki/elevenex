import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';

export const actions = sqliteTable('actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreePath: text('worktree_path').notNull(),
  name: text('name').notNull(),
  command: text('command').notNull(),
  status: text('status').notNull().default('idle'),
  lastRunAt: text('last_run_at'),
  lastFinishedAt: text('last_finished_at'),
  lastExitCode: integer('last_exit_code'),
  currentOutput: text('current_output').notNull().default(''),
  lastOutput: text('last_output').notNull().default(''),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

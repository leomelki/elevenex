import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.schema.js';

// Durable leases protect assignments across reconnects and backend recovery.
// Snapshot tasks have no live-branch lease; SQLite permits several NULLs.
export const taskReservations = sqliteTable(
  'task_reservations',
  {
    taskId: integer('task_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryKey: text('repository_key').notNull(),
    branchName: text('branch_name'),
    path: text('path').notNull().unique(),
  },
  (table) => [unique().on(table.repositoryKey, table.branchName)],
);

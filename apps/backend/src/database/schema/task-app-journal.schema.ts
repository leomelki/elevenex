import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.schema.js';

/** Relaunch protection and recovery evidence. Display names, commands, paths, logs and credentials stay in memory. */
export const taskAppJournal = sqliteTable(
  'task_app_journal',
  {
    runId: text('run_id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestHash: text('request_hash').notNull(),
    launchHash: text('launch_hash').notNull(),
    mode: text('mode', { enum: ['native', 'stream'] }).notNull(),
    phase: text('phase', {
      enum: [
        'pending',
        'reserved',
        'executing',
        'cleaning',
        'cancelled',
        'expired',
        'stopped',
        'failed',
        'exited',
        'interrupted',
      ],
    }).notNull(),
    startedAt: integer('started_at').notNull(),
    expiresAt: integer('expires_at'),
    supervisorPid: integer('supervisor_pid'),
    supervisorBirth: text('supervisor_birth'),
  },
  (table) => [
    uniqueIndex('task_app_journal_request_idx').on(
      table.taskId,
      table.requestHash,
    ),
    index('task_app_journal_recent_idx').on(table.taskId, table.startedAt),
    index('task_app_journal_expiry_idx').on(table.expiresAt),
    index('task_app_journal_phase_idx').on(table.phase, table.taskId),
  ],
);

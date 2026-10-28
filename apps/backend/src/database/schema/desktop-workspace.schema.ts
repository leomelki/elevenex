import {
  integer,
  text,
  sqliteTable,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

/** Desktop presentation metadata stays independent from legacy lifecycle semantics. */
export const desktopWorkspaceMetadata = sqliteTable(
  'desktop_workspace_metadata',
  {
    kind: text('kind').notNull().$type<'project' | 'task'>(),
    resourceId: integer('resource_id').notNull(),
    value: text('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.resourceId] })],
);

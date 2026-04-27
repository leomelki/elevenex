import { existsSync } from 'fs';
import { join } from 'path';
import { Provider, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index.js';
import { getBackendRuntimeRoot } from '../config/runtime-paths.js';

export const DRIZZLE = Symbol('DRIZZLE');

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

export const DrizzleProvider: Provider = {
  provide: DRIZZLE,
  useFactory: (): DrizzleDB => {
    const logger = new Logger('Database');
    const dbPath = process.env.DB_PATH || 'elevenex.db';
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    ensureProjectBrowserStateCompatibility(sqlite, logger);

    const db = drizzle(sqlite, { schema });

    // Run migrations automatically on startup
    const migrationsFolder = resolveMigrationsFolder();
    migrate(db, { migrationsFolder });
    logger.log(`Database migrations applied successfully from ${migrationsFolder}`);

    return db;
  },
};

function resolveMigrationsFolder(): string {
  const runtimeDrizzle = join(getBackendRuntimeRoot(), 'drizzle');
  if (existsSync(runtimeDrizzle)) {
    return runtimeDrizzle;
  }

  const cwdDrizzle = join(process.cwd(), 'drizzle');
  if (existsSync(cwdDrizzle)) {
    return cwdDrizzle;
  }

  const workspaceBackendDrizzle = join(process.cwd(), 'apps', 'backend', 'drizzle');
  if (existsSync(workspaceBackendDrizzle)) {
    return workspaceBackendDrizzle;
  }

  return cwdDrizzle;
}

function ensureProjectBrowserStateCompatibility(sqlite: InstanceType<typeof Database>, logger: Logger): void {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_browser_state'")
    .get();

  if (!tableExists) {
    return;
  }

  const columns = sqlite.prepare("PRAGMA table_info('project_browser_state')").all() as Array<{ name: string }>;
  const hasTabId = columns.some(column => column.name === 'tab_id');
  if (hasTabId) {
    return;
  }

  logger.warn('Repairing legacy project_browser_state schema before Drizzle migrations');
  sqlite.exec(`
    ALTER TABLE project_browser_state RENAME TO project_browser_state__old;

    CREATE TABLE project_browser_state (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      tab_id text NOT NULL,
      url text NOT NULL,
      position integer NOT NULL,
      is_active integer DEFAULT false NOT NULL,
      custom_title text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
    );

    INSERT INTO project_browser_state (project_id, tab_id, url, position, is_active, custom_title, created_at, updated_at)
    SELECT
      project_id,
      'legacy-' || project_id,
      url,
      0,
      1,
      NULL,
      created_at,
      updated_at
    FROM project_browser_state__old;

    DROP TABLE project_browser_state__old;

    CREATE UNIQUE INDEX project_browser_state_project_tab_idx
      ON project_browser_state (project_id, tab_id);
  `);
}

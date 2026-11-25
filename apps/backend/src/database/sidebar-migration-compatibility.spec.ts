import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { reconcileSidebarMigration } from './sidebar-migration-compatibility.js';

const migrationsFolder = resolve('drizzle');
const migrations = readMigrationFiles({ migrationsFolder });
const lastShared = 1795466243083;
const oldSidebar = 1795525146427;
const sidebar = 1795535000000;
const antigravity = 1795539899320;

it.each(['delegation', 'sidebar', 'antigravity'] as const)(
  'applies both migration lineages on a database last upgraded through %s',
  (lineage) => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
      const record = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
      for (const migration of migrations) {
        const { folderMillis, hash, sql } = migration;
        const installed = folderMillis <= lastShared ||
          (lineage === 'delegation' ? folderMillis < sidebar :
            folderMillis === sidebar || (lineage === 'antigravity' && folderMillis === antigravity));
        if (!installed) continue;
        for (const statement of sql) sqlite.exec(statement);
        record.run(hash, folderMillis === sidebar ? oldSidebar : folderMillis);
      }

      sqlite.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
          VALUES (1, 'Upgrade', '2026-11-24', '2026-11-24');
        INSERT INTO repos (id, project_id, name, path, created_at)
          VALUES (1, 1, 'Repo', '/repo', '2026-11-24');
        INSERT INTO workspaces (id, repo_id, name, path, created_at, updated_at)
          VALUES (1, 1, 'Task', '/repo', '2026-11-24', '2026-11-24');
        INSERT INTO sessions (id, workspace_id, repo_id, branch_name, worktree_path, created_at, updated_at)
          VALUES (1, 1, 1, 'main', '/repo', '2026-11-24', '2026-11-24');
      `);
      if (lineage === 'antigravity') {
        sqlite.exec(`
          UPDATE sessions SET antigravity_session_id = 'native' WHERE id = 1;
          INSERT INTO antigravity_turns (session_id, items) VALUES (1, '[]');
        `);
      }
      if (lineage === 'delegation') {
        sqlite.exec(`
          UPDATE workspaces SET task_temporary = 1, task_created_by_session_id = 1 WHERE id = 1;
          INSERT INTO session_launches (key, fingerprint, session_id, delivery)
            VALUES ('request', 'fingerprint', 1, 'accepted');
        `);
      }
      const db = drizzle(sqlite);
      for (let startup = 0; startup < 2; startup++) {
        reconcileSidebarMigration(sqlite, migrationsFolder);
        migrate(db, { migrationsFolder });
      }
      expect(sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at').all())
        .toEqual(migrations.map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }))
          .sort((left, right) => left.created_at - right.created_at));
      expect(sqlite.prepare('SELECT agent_selection, antigravity_session_id FROM sessions WHERE id = 1').get())
        .toEqual({ agent_selection: null, antigravity_session_id: lineage === 'antigravity' ? 'native' : null });
      expect(sqlite.prepare('SELECT task_temporary, task_created_by_session_id FROM workspaces WHERE id = 1').get())
        .toEqual(lineage === 'delegation'
          ? { task_temporary: 1, task_created_by_session_id: 1 }
          : { task_temporary: 0, task_created_by_session_id: null });
      expect(sqlite.prepare('SELECT items FROM antigravity_turns WHERE session_id = 1').get())
        .toEqual(lineage === 'antigravity' ? { items: '[]' } : undefined);
      expect(sqlite.prepare('SELECT delivery FROM session_launches WHERE session_id = 1').get())
        .toEqual(lineage === 'delegation' ? { delivery: 'accepted' } : undefined);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      sqlite.close();
    }
  },
);

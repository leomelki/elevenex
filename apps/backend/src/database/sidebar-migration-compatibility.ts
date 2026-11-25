import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const legacySidebarTimestamp = 1795525146427;
const mergedSidebarTimestamp = 1795535000000;
const lastCommonTimestamp = 1795466243083;

/** Drizzle normally skips everything older than the latest ledger entry.
 * Databases from the pre-merge UI branch may already have a newer entry
 * but lack the parallel delegation migrations. Repair that specific lineage
 * by hash, then let Drizzle handle Antigravity and all subsequent upgrades.
 */
export function reconcileSidebarMigration(
  sqlite: InstanceType<typeof Database>,
  migrationsFolder: string,
): void {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get())
    return;
  const legacy = sqlite.prepare('SELECT hash FROM __drizzle_migrations WHERE created_at = ?');
  if (!legacy.get(legacySidebarTimestamp)) return;

  const migrations = readMigrationFiles({ migrationsFolder });
  const sidebar = migrations.find(({ folderMillis }) => folderMillis === mergedSidebarTimestamp);
  if (!sidebar) throw new Error('The merged sidebar migration is missing.');
  const legacyEntry = sqlite.prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = ? AND hash = ?');
  const applied = sqlite.prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ?');
  const record = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
  const rebase = sqlite.prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ? AND hash = ?');
  sqlite.transaction(() => {
    if (!legacyEntry.get(legacySidebarTimestamp, sidebar.hash)) return;
    for (const { folderMillis, hash, sql } of migrations) {
      if (folderMillis <= lastCommonTimestamp || folderMillis >= mergedSidebarTimestamp || applied.get(hash))
        continue;
      for (const statement of sql) sqlite.exec(statement);
      record.run(hash, folderMillis);
    }
    rebase.run(mergedSidebarTimestamp, legacySidebarTimestamp, sidebar.hash);
  }).immediate();
}

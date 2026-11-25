import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const lastCommonTimestamp = 1795466243083;
const branchedMigrations = [
  { name: 'sidebar priority', previous: 1795525146427, merged: 1795535000000 },
  { name: 'task app journal', previous: 1795529450427, merged: 1795567035965 },
];

/** Drizzle skips migrations older than the latest ledger entry. A branch may
 * have installed a newer entry before it received the parallel migrations.
 * Backfill those gaps by hash before advancing the branch's ledger entry.
 */
export function reconcileBranchedMigrations(
  sqlite: InstanceType<typeof Database>,
  migrationsFolder: string,
): void {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get())
    return;
  const legacy = sqlite.prepare('SELECT hash FROM __drizzle_migrations WHERE created_at = ?');
  const candidates = branchedMigrations.filter(({ previous }) => legacy.get(previous));
  if (!candidates.length) return;

  const migrations = readMigrationFiles({ migrationsFolder });
  const legacyEntry = sqlite.prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = ? AND hash = ?');
  const applied = sqlite.prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ?');
  const record = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
  const rebase = sqlite.prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ? AND hash = ?');
  sqlite.transaction(() => {
    for (const { name, previous, merged } of candidates) {
      const migration = migrations.find(({ folderMillis }) => folderMillis === merged);
      if (!migration) throw new Error(`The merged ${name} migration is missing.`);
      if (!legacyEntry.get(previous, migration.hash)) continue;
      for (const { folderMillis, hash, sql } of migrations) {
        if (folderMillis <= lastCommonTimestamp || folderMillis >= merged || applied.get(hash))
          continue;
        for (const statement of sql) sqlite.exec(statement);
        record.run(hash, folderMillis);
      }
      rebase.run(merged, previous, migration.hash);
    }
  }).immediate();
}

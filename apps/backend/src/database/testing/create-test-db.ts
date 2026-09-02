import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../schema/index.js';

/** Walk up from the working directory to find the committed migrations. */
function resolveMigrationsFolder(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the drizzle migrations folder from ' + process.cwd(),
  );
}

/**
 * An in-memory database with the real migrations applied.
 *
 * Specs used to hand-write `CREATE TABLE` statements, which silently drifted
 * from the schema every time a column was added — a whole suite would start
 * failing on `table X has no column named Y` for reasons unrelated to the code
 * under test. Running the committed migrations keeps test and production
 * schemas identical by construction.
 */
export function createTestDb(): {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: InstanceType<typeof Database>;
} {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  return { db, sqlite };
}

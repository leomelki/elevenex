import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index.js';

it('preserves existing completion ownership while allowing several assignments in the same session', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
    const feature = migrations.findIndex((migration) =>
      migration.sql.some((sql) =>
        sql.includes('CREATE TABLE `session_prompt_receipts`'),
      ),
    );
    expect(feature).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, feature))
      for (const statement of migration.sql) sqlite.exec(statement);
    const db = drizzle(sqlite, { schema });
    const project = db
      .insert(schema.projects)
      .values({ name: 'Migration' })
      .returning()
      .get();
    const repo = db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'Repo', path: '/tmp/repo' })
      .returning()
      .get();
    const values = {
      repoId: repo.id,
      branchName: 'main',
      worktreePath: '/tmp/repo',
    };
    const parent = db.insert(schema.sessions).values(values).returning().get();
    const child = db
      .insert(schema.sessions)
      .values({ ...values, delegatedBySessionId: parent.id })
      .returning()
      .get();
    sqlite
      .prepare(
        'INSERT INTO session_completion_notices (session_id, recipient_id, state, outcome) VALUES (?, ?, ?, ?)',
      )
      .run(child.id, parent.id, 'consumed', 'completed');
    for (const statement of migrations[feature].sql) sqlite.exec(statement);
    expect(
      db.select().from(schema.sessionCompletionNotices).all(),
    ).toMatchObject([
      {
        sessionId: child.id,
        recipientId: parent.id,
        state: 'consumed',
        outcome: 'completed',
        messageId: null,
      },
    ]);
    db.insert(schema.sessionCompletionNotices)
      .values({ sessionId: child.id, recipientId: parent.id, state: 'waiting' })
      .run();
    expect(
      db.select().from(schema.sessionCompletionNotices).all(),
    ).toHaveLength(2);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    sqlite.close();
  }
});

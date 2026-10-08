import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

it('upgrades existing workspaces without changing identities or losing conversation provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-task-migration-'));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    const source = resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(
      await readFile(join(source, 'meta/_journal.json'), 'utf8'),
    );
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 39,
    );
    await mkdir(join(root, 'meta'));
    await writeFile(join(root, 'meta/_journal.json'), JSON.stringify(journal));
    await Promise.all(
      journal.entries.map((entry: { tag: string }) =>
        copyFile(
          join(source, `${entry.tag}.sql`),
          join(root, `${entry.tag}.sql`),
        ),
      ),
    );
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: root });
    sqlite.exec(`
      INSERT INTO projects (id, name, created_at, updated_at) VALUES (7, 'Existing project', '2026-01-01', '2026-01-01');
      INSERT INTO repos (id, project_id, name, path, created_at) VALUES (9, 7, 'Repo', '/tmp/repo', '2026-01-01');
      INSERT INTO workspaces (id, repo_id, name, path, created_at, updated_at) VALUES (12, 9, 'Investigation', '/tmp/checkout', '2026-01-01', '2026-01-01');
      INSERT INTO sessions (id, repo_id, workspace_id, branch_name, worktree_path, created_at, updated_at) VALUES (42, 9, 12, 'review', '/tmp/checkout', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, repo_id, name, path, is_default, created_at, updated_at) VALUES (13, 9, 'Repository checkout', '/tmp/repo', 1, '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, repo_id, name, path, link_status, desired_branch, created_at, updated_at) VALUES (14, 9, 'Unlinked investigation', '/tmp/moved-checkout', 'unlinked', 'review', '2026-01-01', '2026-01-01');
    `);
    migrate(db, { migrationsFolder: source });
    expect(
      sqlite
        .prepare(
          'SELECT id, name, task_state, archived_at FROM workspaces WHERE id = 12',
        )
        .get(),
    ).toEqual({
      id: 12,
      name: 'Investigation',
      task_state: 'ready',
      archived_at: null,
    });
    expect(
      sqlite
        .prepare(
          'SELECT id, workspace_id, transcript_worktree_path FROM sessions WHERE id = 42',
        )
        .get(),
    ).toEqual({
      id: 42,
      workspace_id: 12,
      transcript_worktree_path: '/tmp/checkout',
    });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      sqlite
        .prepare('SELECT task_request_id FROM workspaces WHERE id = 13')
        .get(),
    ).toEqual({ task_request_id: null });
    expect(
      sqlite
        .prepare('SELECT task_state, task_branch FROM workspaces WHERE id = 14')
        .get(),
    ).toEqual({ task_state: 'failed', task_branch: 'review' });
    expect(
      sqlite
        .prepare('SELECT task_request_id FROM workspaces WHERE id = 12')
        .get(),
    ).toEqual({ task_request_id: 'legacy-workspace-12' });
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

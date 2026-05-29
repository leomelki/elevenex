import { BadRequestException, NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { WorkspacesService } from './workspaces.service.js';
import * as schema from '../database/schema/index.js';
import { WorktreesService, WorktreeInfo } from '../worktrees/worktrees.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT,
      preferred_context_root_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    );
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_from_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, name),
      UNIQUE(repo_id, path)
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      name TEXT,
      surface TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'created',
      active_agent_provider TEXT NOT NULL DEFAULT 'claude',
      claude_session_id TEXT DEFAULT '-1',
      codex_session_id TEXT DEFAULT '-1',
      pi_session_path TEXT DEFAULT '-1',
      has_injected_worktree_context INTEGER NOT NULL DEFAULT 0,
      has_unreviewed_completion INTEGER NOT NULL DEFAULT 0,
      last_completion_at TEXT,
      last_completion_kind TEXT,
      last_state_change_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('WorkspacesService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let service: WorkspacesService;
  let repo: typeof schema.repos.$inferSelect;
  let worktreesServiceMock: jest.Mocked<Pick<WorktreesService, 'listWorktrees' | 'removeWorktree'>>;
  let sessionsServiceMock: jest.Mocked<Pick<SessionsService, 'findByRepo' | 'deleteByRepoAndWorktreePath'>>;

  const mainWorktree: WorktreeInfo = {
    path: '/tmp/repo',
    head: 'aaa',
    branch: 'main',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
  };
  const featureWorktree: WorktreeInfo = {
    path: '/tmp/repo-feature',
    head: 'bbb',
    branch: 'feature',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
  };

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;

    const [project] = await db.insert(schema.projects).values({ name: 'Project' }).returning();
    [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: '/tmp/repo' })
      .returning();

    worktreesServiceMock = {
      listWorktrees: jest.fn().mockResolvedValue([mainWorktree, featureWorktree]),
      removeWorktree: jest.fn().mockResolvedValue(undefined),
    };
    sessionsServiceMock = {
      findByRepo: jest.fn().mockResolvedValue([]),
      deleteByRepoAndWorktreePath: jest.fn().mockResolvedValue(undefined),
    };
    service = new WorkspacesService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
    );
  });

  afterEach(() => {
    sqliteConn.close();
  });

  it('does not add existing git worktrees to the project during navigation listing', async () => {
    const workspaces = await service.listForRepo(repo);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe('/tmp/repo');
    expect(workspaces[0].isDefault).toBe(true);
  });

  it('attaches an existing git worktree only when requested explicitly', async () => {
    const attached = await service.attachExistingWorkspace(repo, {
      path: '/tmp/repo-feature',
    });

    expect(attached.path).toBe('/tmp/repo-feature');
    expect(attached.name).toBe('feature');

    const workspaces = await service.listForRepo(repo);
    expect(workspaces.map((workspace) => workspace.path)).toEqual([
      '/tmp/repo',
      '/tmp/repo-feature',
    ]);
  });

  it('rejects attach requests for paths outside the repo worktree list', async () => {
    await expect(
      service.attachExistingWorkspace(repo, { path: '/tmp/other' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects workspace mutations through the wrong repo id', async () => {
    const attached = await service.attachExistingWorkspace(repo, {
      path: '/tmp/repo-feature',
    });

    await expect(
      service.deleteWorkspace(attached.id, false, repo.id + 1),
    ).rejects.toThrow(NotFoundException);
  });
});

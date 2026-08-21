import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreesService, WorktreeInfo } from './worktrees.service.js';
import { WorktreePoolService } from './worktree-pool.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { worktreeSimpleGit } from '../config/system-paths.js';

jest.mock('../config/system-paths.js', () => ({
  ...jest.requireActual('../config/system-paths.js'),
  worktreeSimpleGit: jest.fn(),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      hidden INTEGER NOT NULL DEFAULT 0,
      agent_instructions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
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
    CREATE TABLE repo_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root_path TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_from_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_root_path, path)
    );
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      pool_worktree_id INTEGER REFERENCES repo_worktrees(id) ON DELETE SET NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_from_ref TEXT,
      link_status TEXT NOT NULL DEFAULT 'linked',
      desired_branch TEXT,
      unlinked_at TEXT,
      unlinked_by_project_id INTEGER,
      pending_stash_commit TEXT,
      pending_stash_message TEXT,
      pending_stash_created_at TEXT,
      pending_stash_status TEXT,
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
    CREATE TABLE worktree_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      worktree_path TEXT NOT NULL,
      root_ref TEXT,
      context_sentence TEXT,
      generation_status TEXT NOT NULL DEFAULT 'idle',
      context_enabled INTEGER NOT NULL DEFAULT 1,
      generated_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, worktree_path)
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('WorktreePoolService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let service: WorktreePoolService;
  let repo: typeof schema.repos.$inferSelect;
  let otherRepo: typeof schema.repos.$inferSelect;
  let worktreesServiceMock: jest.Mocked<
    Pick<WorktreesService, 'listWorktrees' | 'moveWorktree'>
  >;
  let sessionsServiceMock: jest.Mocked<
    Pick<SessionsService, 'archiveAndStopByRepoAndWorktreePath'>
  >;
  let projectsServiceMock: jest.Mocked<Pick<ProjectsService, 'assertProjectIsActive'>>;
  let claudeHooksServiceMock: jest.Mocked<Pick<ClaudeHooksService, 'getStatus'>>;
  let gitMock: {
    raw: jest.Mock;
    status: jest.Mock;
    revparse: jest.Mock;
  };

  const mainWorktree: WorktreeInfo = {
    path: 'C:\\repo',
    head: 'aaa',
    branch: 'main',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
  };
  const featureWorktree: WorktreeInfo = {
    path: 'C:\\repo-feature',
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
    const [project] = await db.insert(schema.projects).values({ name: 'One' }).returning();
    const [otherProject] = await db.insert(schema.projects).values({ name: 'Two' }).returning();
    [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: 'C:\\repo' })
      .returning();
    [otherRepo] = await db
      .insert(schema.repos)
      .values({ projectId: otherProject.id, name: 'repo', path: 'C:\\repo' })
      .returning();

    worktreesServiceMock = {
      listWorktrees: jest.fn().mockResolvedValue([mainWorktree, featureWorktree]),
      moveWorktree: jest.fn().mockResolvedValue(undefined),
    };
    sessionsServiceMock = {
      archiveAndStopByRepoAndWorktreePath: jest.fn().mockResolvedValue(undefined),
    };
    projectsServiceMock = {
      assertProjectIsActive: jest.fn().mockResolvedValue(undefined),
    };
    claudeHooksServiceMock = {
      getStatus: jest.fn().mockReturnValue('running'),
    };
    gitMock = {
      raw: jest.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'stash@{0}') return 'stash-sha\n';
        return '';
      }),
      status: jest.fn().mockResolvedValue({
        current: null,
        isClean: () => true,
        conflicted: [],
      }),
      revparse: jest.fn().mockResolvedValue('feature\n'),
    };
    jest.mocked(worktreeSimpleGit).mockReturnValue(gitMock as never);

    service = new WorktreePoolService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      claudeHooksServiceMock as unknown as ClaudeHooksService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    sqliteConn.close();
  });

  it('reconciles git worktrees into the pool and backfills workspace links', async () => {
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: 'C:\\repo-feature',
      })
      .returning();

    await service.reconcileRepo(repo);

    const poolRows = await db.select().from(schema.repoWorktrees);
    expect(poolRows.map((row) => row.path).sort()).toEqual([
      'C:\\repo',
      'C:\\repo-feature',
    ]);
    const [updated] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));
    expect(updated.poolWorktreeId).toBeTruthy();
  });

  it('links an available pool worktree to the project', async () => {
    await service.reconcileRepo(repo);
    const pool = (await db.select().from(schema.repoWorktrees)).find(
      (row) => row.path === 'C:\\repo-feature',
    )!;

    const linked = await service.linkToProject(repo, pool.id, {
      branchName: 'feature',
    });

    expect(linked.repoId).toBe(repo.id);
    expect(linked.poolWorktreeId).toBe(pool.id);
    expect(linked.linkStatus).toBe('linked');
    expect(gitMock.raw).toHaveBeenCalledWith(['checkout', 'feature']);
  });

  it('renames a pool worktree, moving it and repointing its workspace and context row', async () => {
    await service.reconcileRepo(repo);
    const pool = (await db.select().from(schema.repoWorktrees)).find(
      (row) => row.path === 'C:\\repo-feature',
    )!;

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: pool.path,
        poolWorktreeId: pool.id,
      })
      .returning();
    await db.insert(schema.worktreeContexts).values({
      repoId: repo.id,
      worktreePath: pool.path,
      contextSentence: 'old context',
    });

    const pathExists = jest
      .spyOn(service as any, 'pathExists')
      .mockResolvedValue(false);
    const renamed = await service.rename(repo, pool.id, 'fix-login-timeout');
    pathExists.mockRestore();

    expect(worktreesServiceMock.moveWorktree).toHaveBeenCalledWith(
      repo.path,
      pool.path,
      expect.stringContaining('fix-login-timeout'),
    );
    expect(renamed.name).toBe('fix-login-timeout');
    expect(renamed.path).not.toBe(pool.path);

    const [updatedWorkspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));
    expect(updatedWorkspace.path).toBe(renamed.path);

    const [updatedContext] = await db
      .select()
      .from(schema.worktreeContexts)
      .where(eq(schema.worktreeContexts.repoId, repo.id));
    expect(updatedContext.worktreePath).toBe(renamed.path);
    expect(updatedContext.contextSentence).toBe('old context');
  });

  it('uses one status call per worktree to populate branch, dirty, and conflict fields', async () => {
    const pathExists = jest.spyOn(service as any, 'pathExists').mockResolvedValue(true);
    await service.reconcileRepo(repo);
    const featurePath = 'C:\\repo-feature';
    gitMock.status
      .mockReset()
      .mockResolvedValueOnce({ current: 'main', isClean: () => true, conflicted: [] })
      .mockResolvedValueOnce({ current: 'feature', isClean: () => false, conflicted: ['src/x.ts'] });

    const items = await service.listForRepo(repo);
    pathExists.mockRestore();

    expect(gitMock.status).toHaveBeenCalledTimes(2);
    const mainItem = items.find((item) => item.path === 'C:\\repo');
    const featureItem = items.find((item) => item.path === featurePath);
    expect(mainItem?.currentBranch).toBe('main');
    expect(mainItem?.isDirty).toBe(false);
    expect(mainItem?.hasConflicts).toBe(false);
    expect(featureItem?.currentBranch).toBe('feature');
    expect(featureItem?.isDirty).toBe(true);
    expect(featureItem?.hasConflicts).toBe(true);
  });

  it('uses a fast status scan when built-in fsmonitor is unsupported', async () => {
    jest
      .spyOn(service as any, 'hasUnsupportedBuiltinFsMonitor')
      .mockResolvedValue(true);
    gitMock.raw.mockResolvedValue(
      '# branch.oid abc123\0# branch.head feature\0' +
        '1 .M N... 100644 100644 100644 abc123 abc123 src/file.ts\0' +
        'u UU N... 100644 100644 100644 100644 abc123 abc123 abc123 conflicted.ts\0',
    );

    const snapshot = await (service as any).getWorktreeStatusSnapshot(
      'C:\\repo-feature',
    );

    expect(gitMock.status).not.toHaveBeenCalled();
    expect(gitMock.raw).toHaveBeenCalledWith([
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=normal',
    ]);
    expect(snapshot).toEqual({
      currentBranch: 'feature',
      isDirty: true,
      hasConflicts: true,
    });
  });

  it('uses status.current as branch and treats null as detached', async () => {
    const detachedWorktree: WorktreeInfo = {
      path: 'C:\\repo-detached',
      head: 'detached-head',
      branch: null,
      isDetached: true,
      isBare: false,
      isLocked: false,
      lockReason: null,
    };
    const pathExists = jest
      .spyOn(service as any, 'pathExists')
      .mockResolvedValue(true);
    worktreesServiceMock.listWorktrees.mockResolvedValue([
      detachedWorktree,
      featureWorktree,
    ]);

    gitMock.status.mockReset().mockResolvedValue({
      current: null,
      isClean: () => true,
      conflicted: [],
    });
    await service.reconcileRepo(repo);

    const items = await service.listForRepo(repo);
    pathExists.mockRestore();

    const detached = items.find((item) => item.path === 'C:\\repo-detached');
    expect(detached).toBeTruthy();
    expect(detached?.currentBranch).toBeNull();
    expect(detached?.isDirty).toBe(false);
    expect(detached?.hasConflicts).toBe(false);
    expect(detached?.isDetached).toBe(true);
  });

  it('does not call status for missing worktrees', async () => {
    const pathExists = jest
      .spyOn(service as any, 'pathExists')
      .mockResolvedValue(false);

    await service.reconcileRepo(repo);
    gitMock.status.mockClear();

    const items = await service.listForRepo(repo);
    pathExists.mockRestore();

    expect(gitMock.status).not.toHaveBeenCalled();
    expect(items.every((item) => !item.isDirty)).toBe(true);
    expect(items.every((item) => !item.hasConflicts)).toBe(true);
  });

  it('surfaces the number of active agents on a linked worktree', async () => {
    await service.reconcileRepo(repo);
    const pool = (await db.select().from(schema.repoWorktrees)).find(
      (row) => row.path === 'C:\\repo-feature',
    )!;
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: 'C:\\repo-feature',
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();
    await db.insert(schema.sessions).values([
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: 'C:\\repo-feature',
        status: 'active',
      },
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: 'C:\\repo-feature',
        status: 'created',
      },
    ]);

    const item = (await service.listForRepo(repo)).find(
      (candidate) => candidate.id === pool.id,
    );

    expect(item?.runningAgentCount).toBe(1);
  });

  it('does not count active-but-idle sessions as running agents', async () => {
    await service.reconcileRepo(repo);
    const pool = (await db.select().from(schema.repoWorktrees)).find(
      (row) => row.path === 'C:\\repo-feature',
    )!;
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: 'C:\\repo-feature',
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();
    await db.insert(schema.sessions).values([
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: 'C:\\repo-feature',
        status: 'active',
      },
    ]);

    claudeHooksServiceMock.getStatus.mockReturnValue('idle');

    const item = (await service.listForRepo(repo)).find(
      (candidate) => candidate.id === pool.id,
    );

    expect(item?.runningAgentCount).toBe(0);
  });

  it('takes over a dirty worktree, archives old sessions, and records the stash', async () => {
    await service.reconcileRepo(repo);
    const pool = (await db.select().from(schema.repoWorktrees)).find(
      (row) => row.path === 'C:\\repo-feature',
    )!;
    const [oldWorkspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: 'C:\\repo-feature',
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();
    gitMock.status.mockResolvedValue({ isClean: () => false, conflicted: [] });

    await service.linkToProject(otherRepo, pool.id, {
      branchName: 'feature',
      confirmTakeover: true,
      confirmStash: true,
    });

    const [unlinked] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, oldWorkspace.id));
    expect(unlinked.linkStatus).toBe('unlinked');
    expect(unlinked.pendingStashCommit).toBe('stash-sha');
    expect(unlinked.pendingStashStatus).toBe('pending');
    expect(sessionsServiceMock.archiveAndStopByRepoAndWorktreePath).toHaveBeenCalledWith(
      repo.id,
      'C:\\repo-feature',
    );
  });
});

import Database from 'better-sqlite3';
import * as path from 'node:path';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreesService, WorktreeInfo } from './worktrees.service.js';
import {
  WorktreePoolItem,
  WorktreePoolService,
} from './worktree-pool.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { worktreeSimpleGit } from '../config/system-paths.js';

/**
 * Absolute paths resolved for the host platform: the service normalizes every
 * path through `path.resolve`, so hard-coded literals for one OS make the
 * suite fail everywhere else.
 */
const REPO_PATH = path.resolve('/repo');
const FEATURE_PATH = path.resolve('/repo-feature');
const DETACHED_PATH = path.resolve('/repo-detached');

jest.mock('../config/system-paths.js', () => ({
  ...jest.requireActual('../config/system-paths.js'),
  worktreeSimpleGit: jest.fn(),
}));

/**
 * The real migrations, not a hand-rolled copy of the schema: a stale copy
 * drifts silently and fails on columns and tables the service legitimately
 * uses.
 */
function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.resolve(__dirname, '..', '..', 'drizzle'),
  });
  return { db, sqlite };
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
    path: REPO_PATH,
    head: 'aaa',
    branch: 'main',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
  };
  const featureWorktree: WorktreeInfo = {
    path: FEATURE_PATH,
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
      .values({ projectId: project.id, name: 'repo', path: REPO_PATH })
      .returning();
    [otherRepo] = await db
      .insert(schema.repos)
      .values({ projectId: otherProject.id, name: 'repo', path: REPO_PATH })
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
        path: FEATURE_PATH,
      })
      .returning();

    await service.reconcileRepo(repo);

    const poolRows = await db.select().from(schema.repoWorktrees);
    expect(poolRows.map((row) => row.path).sort()).toEqual([
      REPO_PATH,
      FEATURE_PATH,
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
      (row) => row.path === FEATURE_PATH,
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
      (row) => row.path === FEATURE_PATH,
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
    const featurePath = FEATURE_PATH;
    gitMock.status
      .mockReset()
      .mockResolvedValueOnce({ current: 'main', isClean: () => true, conflicted: [] })
      .mockResolvedValueOnce({ current: 'feature', isClean: () => false, conflicted: ['src/x.ts'] });

    const items = await service.listForRepo(repo);
    pathExists.mockRestore();

    expect(gitMock.status).toHaveBeenCalledTimes(2);
    const mainItem = items.find((item) => item.path === REPO_PATH);
    const featureItem = items.find((item) => item.path === featurePath);
    expect(mainItem?.currentBranch).toBe('main');
    expect(mainItem?.isDirty).toBe(false);
    expect(mainItem?.hasConflicts).toBe(false);
    expect(featureItem?.currentBranch).toBe('feature');
    expect(featureItem?.isDirty).toBe(true);
    expect(featureItem?.hasConflicts).toBe(true);
  });

  it('streams each worktree before its status scan finishes', async () => {
    const pathExists = jest
      .spyOn(service as any, 'pathExists')
      .mockResolvedValue(true);
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    gitMock.status.mockImplementation(async () => {
      await statusGate;
      return {
        current: 'feature',
        isClean: () => true,
        conflicted: [],
      };
    });

    const emitted: WorktreePoolItem[] = [];
    const stream = service.streamProgressivelyForRepo(repo, (item) => {
      emitted.push(item);
    });

    while (gitMock.status.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((item) => item.statusLoading)).toBe(true);

    releaseStatus();
    await stream;
    pathExists.mockRestore();

    for (const id of new Set(emitted.map((item) => item.id))) {
      expect(
        emitted.filter((item) => item.id === id).map((item) => item.statusLoading),
      ).toEqual([true, false]);
    }
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
      FEATURE_PATH,
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
      path: DETACHED_PATH,
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

    const detached = items.find((item) => item.path === DETACHED_PATH);
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
      (row) => row.path === FEATURE_PATH,
    )!;
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: FEATURE_PATH,
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();
    await db.insert(schema.sessions).values([
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: FEATURE_PATH,
        status: 'active',
      },
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: FEATURE_PATH,
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
      (row) => row.path === FEATURE_PATH,
    )!;
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: FEATURE_PATH,
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();
    await db.insert(schema.sessions).values([
      {
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: FEATURE_PATH,
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
      (row) => row.path === FEATURE_PATH,
    )!;
    const [oldWorkspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: FEATURE_PATH,
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
      FEATURE_PATH,
    );
  });
});

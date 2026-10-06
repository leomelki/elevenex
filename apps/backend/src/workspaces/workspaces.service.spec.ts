import { BadRequestException, NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { WorkspacesService } from './workspaces.service.js';
import * as schema from '../database/schema/index.js';
import {
  WorktreesService,
  WorktreeInfo,
} from '../worktrees/worktrees.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { WorktreePoolService } from '../worktrees/worktree-pool.service.js';
import { isMissingWorktreePath } from '../worktrees/worktree-path.js';

jest.mock('../worktrees/worktree-path.js', () => ({
  isMissingWorktreePath: jest.fn(),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.resolve(__dirname, '..', '..', 'drizzle'),
  });
  return { db, sqlite };
}

describe('WorkspacesService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let service: WorkspacesService;
  let repo: typeof schema.repos.$inferSelect;
  let worktreesServiceMock: jest.Mocked<
    Pick<WorktreesService, 'listWorktrees' | 'removeWorktree'>
  >;
  let sessionsServiceMock: jest.Mocked<
    Pick<SessionsService, 'findByRepo' | 'deleteByRepoAndWorktreePath'>
  >;
  let projectsServiceMock: jest.Mocked<
    Pick<ProjectsService, 'assertProjectIsActive'>
  >;
  let worktreePoolServiceMock: jest.Mocked<
    Pick<WorktreePoolService, 'reconcileRepo'>
  >;

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
    jest.mocked(isMissingWorktreePath).mockReset().mockResolvedValue(false);
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;

    const [project] = await db
      .insert(schema.projects)
      .values({ name: 'Project' })
      .returning();
    [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: '/tmp/repo' })
      .returning();

    worktreesServiceMock = {
      listWorktrees: jest
        .fn()
        .mockResolvedValue([mainWorktree, featureWorktree]),
      removeWorktree: jest.fn().mockResolvedValue(undefined),
    };
    sessionsServiceMock = {
      findByRepo: jest.fn().mockResolvedValue([]),
      deleteByRepoAndWorktreePath: jest.fn().mockResolvedValue(undefined),
    };
    projectsServiceMock = {
      assertProjectIsActive: jest.fn().mockResolvedValue(undefined),
    };
    worktreePoolServiceMock = {
      reconcileRepo: jest.fn().mockResolvedValue(undefined),
    };
    service = new WorkspacesService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      worktreePoolServiceMock as unknown as WorktreePoolService,
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

  it('does not recreate deleted workspaces from historical sessions on repeated listings', async () => {
    const [session] = await db
      .insert(schema.sessions)
      .values({
        repoId: repo.id,
        branchName: 'feature',
        worktreePath: '/tmp/deleted-worktree',
      })
      .returning();
    sessionsServiceMock.findByRepo.mockResolvedValue([session] as never);
    jest
      .mocked(isMissingWorktreePath)
      .mockImplementation(async (value) => value === session.worktreePath);

    for (let i = 0; i < 2; i++) {
      expect(
        (await service.listForRepo(repo)).map((workspace) => workspace.path),
      ).toEqual(['/tmp/repo']);
    }
    expect(await db.select().from(schema.sessions)).toEqual([session]);
  });

  it('attaches an existing git worktree only when requested explicitly', async () => {
    const attached = await service.attachExistingWorkspace(repo, {
      path: '/tmp/repo-feature',
    });

    expect(attached.path).toBe('/tmp/repo-feature');
    expect(attached.name).toBe('repo-feature');

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

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
import { worktreeSimpleGit } from '../config/system-paths.js';
import { eq } from 'drizzle-orm';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

jest.mock('../config/system-paths.js', () => ({
  ...jest.requireActual('../config/system-paths.js'),
  worktreeSimpleGit: jest.fn(),
}));

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
  let pool: WorktreePoolService;
  let gitStatus: jest.Mock;

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
    gitStatus = jest.fn().mockResolvedValue({
      current: 'main',
      isClean: () => true,
      conflicted: [],
    });
    jest.mocked(worktreeSimpleGit).mockReturnValue({
      status: gitStatus,
      raw: jest.fn().mockResolvedValue(''),
    } as never);
    pool = new WorktreePoolService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      { getStatus: jest.fn() } as never,
      { getMaxWorktreesPerRepo: jest.fn() } as never,
    );
    service = new WorkspacesService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      pool,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqliteConn.close();
  });

  it('does not add existing git worktrees to the project during navigation listing', async () => {
    const workspaces = await service.listForRepo(repo);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe('/tmp/repo');
    expect(workspaces[0].isDefault).toBe(true);
  });

  it('keeps the main checkout first and preserves task order in cached and full listings', async () => {
    const [first, second] = await db
      .insert(schema.workspaces)
      .values([
        {
          repoId: repo.id,
          name: 'Zebra',
          path: '/tmp/zebra',
          taskState: 'preparing',
          sortOrder: 2,
        },
        {
          repoId: repo.id,
          name: 'Alpha',
          path: '/tmp/alpha',
          taskState: 'preparing',
          sortOrder: 1,
        },
      ])
      .returning();
    const main = await service.ensureDefaultWorkspace(repo);
    const [latest] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'A new task',
        path: '',
        taskState: 'preparing',
      })
      .returning();
    for (const listing of [
      service.listCachedForRepo(repo),
      service.listForRepo(repo),
    ]) {
      expect((await listing).map((item) => item.id)).toEqual([
        main.id,
        second.id,
        first.id,
        latest.id,
      ]);
    }
    await expect(service.renameWorkspace(main.id, 'Renamed')).rejects.toThrow(
      'fixed name',
    );
    expect((await service.findOne(main.id)).name).toBe('Main checkout');
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
  it('creates one default atomically across simultaneous cached/full listings and service instances', async () => {
    const [session] = await db
      .insert(schema.sessions)
      .values({
        repoId: repo.id,
        branchName: 'main',
        worktreePath: repo.path,
      })
      .returning();
    const other = new WorkspacesService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      pool,
    );
    const listings = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        i % 2 ? service.listForRepo(repo) : other.listCachedForRepo(repo),
      ),
    );
    const rows = await db.select().from(schema.workspaces);
    expect(rows).toHaveLength(1);
    expect(
      listings.every(
        (items) => items.length === 1 && items[0].id === rows[0].id,
      ),
    ).toBe(true);
    expect(
      (
        await db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, session.id))
      )[0].workspaceId,
    ).toBe(rows[0].id);
    expect(() =>
      db
        .insert(schema.workspaces)
        .values({
          repoId: repo.id,
          name: 'Duplicate',
          path: repo.path,
          isDefault: true,
        })
        .run(),
    ).toThrow();
  });

  it.each([false, true])(
    'merges duplicate defaults preserving folder names, IDs and scoped links (legacy unique index=%s)',
    async (legacyUniqueIndex) => {
      const migrationsFolder = path.resolve(__dirname, '../../drizzle');
      const prefix = await mkdtemp(
        path.join(tmpdir(), 'elevenex-default-migration-'),
      );
      const journal = JSON.parse(
        await readFile(
          path.join(migrationsFolder, 'meta/_journal.json'),
          'utf8',
        ),
      ) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      const repair = journal.entries.find(
        (entry) => entry.tag === '0048_confused_tarantula',
      )!;
      const entries = journal.entries.filter((entry) => entry.idx < repair.idx);
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const upgrade = drizzle(sqlite, { schema });
      try {
        await mkdir(path.join(prefix, 'meta'));
        await writeFile(
          path.join(prefix, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries }),
        );
        await Promise.all(
          entries.map((entry) =>
            copyFile(
              path.join(migrationsFolder, `${entry.tag}.sql`),
              path.join(prefix, `${entry.tag}.sql`),
            ),
          ),
        );
        // Run the actual historical migration chain, then a normal startup upgrade.
        migrate(upgrade, { migrationsFolder: prefix });
        expect(
          sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'session_folders_workspace_name_idx'",
            )
            .get(),
        ).toBeUndefined();
        if (legacyUniqueIndex)
          sqlite.exec(
            'CREATE UNIQUE INDEX session_folders_workspace_name_idx ON session_folders(workspace_id, name)',
          );
        const [project] = await upgrade
          .insert(schema.projects)
          .values({ name: 'Upgrade' })
          .returning();
        const [repo] = await upgrade
          .insert(schema.repos)
          .values({ projectId: project.id, name: 'repo', path: '/repo' })
          .returning();
        const [main, duplicate, another, leased, history] = await upgrade
          .insert(schema.workspaces)
          .values([
            {
              repoId: repo.id,
              path: repo.path,
              name: 'Main checkout',
              isDefault: true,
            },
            {
              repoId: repo.id,
              path: repo.path,
              name: 'Main checkout',
              isDefault: true,
            },
            {
              repoId: repo.id,
              path: repo.path,
              name: 'Main checkout',
              isDefault: true,
            },
            {
              repoId: repo.id,
              path: '/leased',
              name: 'Leased duplicate',
              isDefault: true,
            },
            {
              repoId: repo.id,
              path: repo.path,
              name: 'Main checkout',
              archivedAt: '2026-01-01',
              taskRequestId: 'history',
              linkStatus: 'unlinked',
            },
          ])
          .returning();
        const [original, incoming] = await upgrade
          .insert(schema.sessionFolders)
          .values([
            { repoId: repo.id, workspaceId: main.id, name: 'Work' },
            {
              repoId: repo.id,
              workspaceId: duplicate.id,
              name: 'Work',
              archivedAt: '2026-01-01',
            },
          ])
          .returning();
        const suffix = ` (folder ${incoming.id})`;
        const extraFolders = await upgrade
          .insert(schema.sessionFolders)
          .values([
            { repoId: repo.id, workspaceId: main.id, name: `Work${suffix}` },
            {
              repoId: repo.id,
              workspaceId: duplicate.id,
              name: `Work${suffix}${suffix}`,
            },
            { repoId: repo.id, workspaceId: another.id, name: 'Work' },
            { repoId: repo.id, workspaceId: leased.id, name: 'Work' },
          ])
          .returning();
        const folders = [original, incoming, ...extraFolders];
        const sessions = await upgrade
          .insert(schema.sessions)
          .values(
            folders.map((folder) => ({
              repoId: repo.id,
              workspaceId: folder.workspaceId,
              folderId: folder.id,
              worktreePath:
                folder.workspaceId === leased.id ? '/leased' : repo.path,
              branchName: 'main',
              status: 'archived',
            })),
          )
          .returning();
        await upgrade.insert(schema.userTerminals).values(
          [main, duplicate].map((workspace) => ({
            workspaceId: workspace.id,
            worktreePath: repo.path,
            name: 'Shell',
            shell: 'zsh',
          })),
        );
        await upgrade.insert(schema.actions).values(
          [main, duplicate].map((workspace) => ({
            workspaceId: workspace.id,
            worktreePath: repo.path,
            name: 'Build',
            command: 'build',
          })),
        );
        const [lease] = await upgrade
          .insert(schema.taskReservations)
          .values({
            taskId: leased.id,
            path: '/leased',
            repositoryKey: '/repo/.git',
            branchName: 'leased',
          })
          .returning();
        migrate(upgrade, { migrationsFolder });
        expect(
          (await upgrade.select().from(schema.workspaces)).map((row) => row.id),
        ).toEqual([main.id, leased.id, history.id]);
        expect(
          (
            await upgrade
              .select()
              .from(schema.workspaces)
              .where(eq(schema.workspaces.id, leased.id))
          )[0],
        ).toMatchObject({
          isDefault: false,
          path: '/leased',
          linkStatus: 'linked',
        });
        expect(await upgrade.select().from(schema.taskReservations)).toEqual([
          lease,
        ]);
        const repairedFolders = await upgrade
          .select()
          .from(schema.sessionFolders);
        expect(repairedFolders).toEqual(
          folders.map((folder) => ({
            ...folder,
            workspaceId: folder.workspaceId === leased.id ? leased.id : main.id,
          })),
        );
        const merged = repairedFolders.filter(
          (folder) => folder.workspaceId === main.id,
        );
        expect(merged).toHaveLength(folders.length - 1);
        expect(merged.filter((folder) => folder.name === 'Work')).toHaveLength(
          3,
        );
        expect(await upgrade.select().from(schema.sessions)).toEqual(
          sessions.map((session) => ({
            ...session,
            workspaceId:
              session.workspaceId === leased.id ? leased.id : main.id,
          })),
        );
        const terminals = await upgrade.select().from(schema.userTerminals);
        const actions = await upgrade.select().from(schema.actions);
        expect(terminals).toHaveLength(2);
        expect(actions).toHaveLength(2);
        expect(terminals.every((row) => row.workspaceId === main.id)).toBe(
          true,
        );
        expect(actions.every((row) => row.workspaceId === main.id)).toBe(true);
        expect(sqlite.pragma('foreign_key_check')).toEqual([]);
        // 0036 and the generated schema deliberately allow repeated folder names.
        expect(
          sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'session_folders_workspace_name_idx'",
            )
            .get(),
        ).toBeUndefined();
        expect(
          sqlite
            .prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table'")
            .all(),
        ).toEqual([]);
        migrate(upgrade, { migrationsFolder });
        expect(await upgrade.select().from(schema.sessionFolders)).toEqual(
          repairedFolders,
        );
      } finally {
        sqlite.close();
        await rm(prefix, { recursive: true, force: true });
      }
    },
  );

  it('reconciles unassigned sessions atomically across service instances and path aliases', async () => {
    const [first, second] = await db
      .insert(schema.sessions)
      .values([
        {
          repoId: repo.id,
          worktreePath: featureWorktree.path,
          branchName: 'feature',
        },
        {
          repoId: repo.id,
          worktreePath: featureWorktree.path + '/.',
          branchName: 'feature',
        },
      ])
      .returning();
    sessionsServiceMock.findByRepo.mockResolvedValue([first, second] as never);
    const other = new WorkspacesService(
      db,
      worktreesServiceMock as unknown as WorktreesService,
      sessionsServiceMock as unknown as SessionsService,
      projectsServiceMock as unknown as ProjectsService,
      pool,
    );
    await Promise.all([
      service.listForRepo(repo),
      service.listForRepo(repo),
      other.listForRepo(repo),
    ]);
    const featureRows = (await db.select().from(schema.workspaces)).filter(
      (row) => !row.isDefault,
    );
    expect(featureRows).toHaveLength(1);
    expect(
      (await db.select().from(schema.sessions)).map((row) => row.workspaceId),
    ).toEqual([featureRows[0].id, featureRows[0].id]);
  });

  it('uses N status snapshots and one listing for overlapping workspace and pool reads, then refreshes', async () => {
    const worktrees = [
      mainWorktree,
      ...Array.from({ length: 11 }, (_, i) => ({
        ...featureWorktree,
        path: `/tmp/feature-${i}`,
        branch: `feature-${i}`,
      })),
    ];
    worktreesServiceMock.listWorktrees.mockResolvedValue(worktrees);
    await db.insert(schema.workspaces).values(
      worktrees.slice(1).map((tree) => ({
        repoId: repo.id,
        name: tree.branch!,
        path: tree.path,
      })),
    );
    jest.spyOn(pool as any, 'pathExists').mockResolvedValue(true);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gitStatus.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return {
        current: 'main',
        isClean: () => false,
        conflicted: ['conflict'],
      };
    });
    const first = service.listForRepo(repo);
    while (!gitStatus.mock.calls.length)
      await new Promise((resolve) => setImmediate(resolve));
    let poolStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      poolStarted = resolve;
    });
    const others = [
      service.listForRepo(repo),
      pool.withRepoObservation(repo, async () => {
        poolStarted();
        await pool.reconcileRepo(repo);
        return pool.listForRepo(repo);
      }),
    ];
    await entered;
    release();
    const [items] = await Promise.all([first, ...others]);
    expect(items).toHaveLength(12);
    expect(items.every((row) => row.isDirty && row.hasConflicts)).toBe(true);
    expect(gitStatus).toHaveBeenCalledTimes(12);
    expect(worktreesServiceMock.listWorktrees).toHaveBeenCalledTimes(1);
    expect(maximum).toBeLessThanOrEqual(4);
    await service.listForRepo(repo);
    expect(gitStatus).toHaveBeenCalledTimes(24);
    expect(worktreesServiceMock.listWorktrees).toHaveBeenCalledTimes(2);
  });

  it('does not return stale task assignment or resurrect a finished task after a slow scan', async () => {
    const [task, finished] = await db
      .insert(schema.workspaces)
      .values([
        { repoId: repo.id, name: 'Task', path: featureWorktree.path },
        { repoId: repo.id, name: 'Finished', path: featureWorktree.path },
      ])
      .returning();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gitStatus.mockImplementation(async () => {
      await gate;
      return { current: 'feature', isClean: () => false, conflicted: [] };
    });
    const pending = service.listForRepo(repo);
    while (!gitStatus.mock.calls.length)
      await new Promise((resolve) => setImmediate(resolve));
    await db
      .update(schema.workspaces)
      .set({
        linkStatus: 'unlinked',
        poolWorktreeId: null,
        taskState: 'released',
        name: 'Released',
      })
      .where(eq(schema.workspaces.id, task.id));
    await db
      .update(schema.workspaces)
      .set({ archivedAt: '2026-01-01' })
      .where(eq(schema.workspaces.id, finished.id));
    const overlapping = service.listForRepo(repo);
    release();
    for (const items of await Promise.all([pending, overlapping])) {
      expect(items.some((row) => row.id === finished.id)).toBe(false);
      expect(items.find((row) => row.id === task.id)).toMatchObject({
        name: 'Released',
        linkStatus: 'unlinked',
        taskState: 'released',
        isDirty: false,
      });
    }
  });
  it('reports failed observations conservatively and refuses branch switching even with force', async () => {
    gitStatus.mockRejectedValue(new Error('index unreadable'));
    const [main] = await service.listForRepo(repo);
    expect(main).toMatchObject({
      isDirty: true,
      hasConflicts: true,
      statusError: 'index unreadable',
    });
    await expect(
      service.switchBranch(main.id, 'feature', true),
    ).rejects.toMatchObject({
      response: { code: 'worktree_observation_failed' },
    });
    expect(
      jest.mocked(worktreeSimpleGit)(repo.path).raw,
    ).not.toHaveBeenCalledWith(expect.arrayContaining(['checkout']));
  });
});

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as schema from '../database/schema/index.js';
import type { DrizzleDB } from '../database/database.provider.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { SessionsService } from '../sessions/sessions.service.js';
import {
  assertWorkspaceCanExecute,
  refreshWorkspaceCheckout,
} from './workspace-ownership.js';

jest.mock('../config/system-paths.js', () => ({
  ...jest.requireActual('../config/system-paths.js'),
  worktreeSimpleGit: jest.fn(),
}));

describe('Task checkout health and session execution', () => {
  let root: string;
  let db: DrizzleDB;
  let sqlite: InstanceType<typeof Database>;
  let workspace: typeof schema.workspaces.$inferSelect;
  let git: { revparse: jest.Mock; raw: jest.Mock };
  let sessions: SessionsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-checkout-health-'));
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
    const [project] = await db
      .insert(schema.projects)
      .values({ name: 'Project' })
      .returning();
    const [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'Repository', path: root })
      .returning();
    [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'Existing task',
        path: root,
        taskBranch: 'feature',
        startingCommit: 'abc',
        taskRequestId: 'legacy-workspace-1',
      })
      .returning();
    git = {
      revparse: jest.fn().mockResolvedValue('feature'),
      raw: jest.fn().mockResolvedValue(root),
    };
    jest
      .mocked(worktreeSimpleGit)
      .mockReset()
      .mockReturnValue(git as never);
    sessions = new SessionsService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({
          defaultAgentProvider: 'claude',
          defaultClaudeSessionSurface: 'claude-ui',
        }),
      } as never,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  });
  async function saved() {
    return (
      await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspace.id))
    )[0];
  }

  it('does not consult Git to run messages, even when Git is unavailable', async () => {
    const session = await sessions.create({
      repoId: workspace.repoId,
      workspaceId: workspace.id,
    });
    git.revparse.mockClear().mockRejectedValue(new Error('Git unavailable'));
    await expect(
      sessions.assertSessionWorkspaceLinked(session.id),
    ).resolves.toBeUndefined();
    expect(git.revparse).not.toHaveBeenCalled();
    await expect(
      sessions.create({ repoId: workspace.repoId, workspaceId: workspace.id }),
    ).resolves.toMatchObject({
      workspaceId: workspace.id,
      branchName: 'detached',
    });
    expect(await saved()).toMatchObject({
      taskState: 'ready',
      taskError: null,
    });
  });

  it.each(['unrelated', 'HEAD'])(
    'allows sessions and messages on %s',
    async (branch) => {
      git.revparse.mockResolvedValue(branch);
      const session = await sessions.create({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
      });
      expect(session.branchName).toBe(branch === 'HEAD' ? 'detached' : branch);
      await expect(
        sessions.assertSessionWorkspaceLinked(session.id),
      ).resolves.toBeUndefined();
      expect(await saved()).toMatchObject({
        taskState: 'ready',
        taskError: null,
      });
    },
  );

  it.each(['branch_changed', 'environment_missing'])(
    'recovers an old %s failure without switching branches',
    async (code) => {
      await db
        .update(schema.workspaces)
        .set({ taskState: 'failed', taskError: JSON.stringify({ code }) })
        .where(eq(schema.workspaces.id, workspace.id));
      git.revparse.mockResolvedValue('unrelated');
      await expect(
        assertWorkspaceCanExecute(db, workspace.id),
      ).resolves.toMatchObject({ taskState: 'ready', taskError: null });
      expect(git.revparse).not.toHaveBeenCalled();
      expect(git.raw).not.toHaveBeenCalled();
      await expect(
        sessions.create({
          repoId: workspace.repoId,
          workspaceId: workspace.id,
        }),
      ).resolves.toMatchObject({ branchName: 'unrelated' });
    },
  );

  it('does not permanently fail a task on a temporary filesystem error', async () => {
    jest
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(
        Object.assign(new Error('temporarily inaccessible'), {
          code: 'EACCES',
        }),
      );
    await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
      'Try again',
    );
    expect(await saved()).toMatchObject({
      taskState: 'ready',
      taskError: null,
    });
    await expect(
      assertWorkspaceCanExecute(db, workspace.id),
    ).resolves.toMatchObject({ taskState: 'ready' });
  });

  it.each(['preparing', 'finishing', 'failed'])(
    'does not bypass a task in %s, and keeps the actual setup failure message',
    async (taskState) => {
      await db
        .update(schema.workspaces)
        .set({
          taskState,
          taskError:
            taskState === 'failed'
              ? JSON.stringify({
                  code: 'environment_missing',
                  message: 'Remote refresh failed',
                })
              : null,
          taskConfig: JSON.stringify({ preparationStage: 'refreshing_ref' }),
        })
        .where(eq(schema.workspaces.id, workspace.id));
      await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
        taskState === 'failed'
          ? 'Remote refresh failed'
          : taskState === 'preparing'
            ? 'still being prepared'
            : 'finishing',
      );
      expect((await saved()).taskState).toBe(taskState);
    },
  );

  it('blocks archived and unlinked tasks', async () => {
    await db
      .update(schema.workspaces)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspace.id));
    await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
      'Reopen',
    );
    await db
      .update(schema.workspaces)
      .set({ archivedAt: null, linkStatus: 'unlinked' })
      .where(eq(schema.workspaces.id, workspace.id));
    await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
      'Reopen',
    );
  });

  it('rejects a missing checkout and recovers after its directory is restored', async () => {
    await rm(root, { recursive: true });
    await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
      'unavailable',
    );
    expect(JSON.parse((await saved()).taskError!).code).toBe(
      'environment_missing',
    );
    await mkdir(root);
    await expect(
      assertWorkspaceCanExecute(db, workspace.id),
    ).resolves.toMatchObject({ taskState: 'ready', taskError: null });
  });

  it('discards a stale missing-directory observation when setup changes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.spyOn(fs, 'stat').mockImplementationOnce(() => {
      entered();
      return new Promise((_, reject) => {
        release = () =>
          reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      });
    });
    const checking = refreshWorkspaceCheckout(db, workspace);
    await starting;
    await db
      .update(schema.workspaces)
      .set({ taskState: 'preparing', path: join(root, 'new-checkout') })
      .where(eq(schema.workspaces.id, workspace.id));
    release();
    expect(await checking).toMatchObject({
      workspace: { taskState: 'preparing', taskError: null },
      error: null,
    });
  });

  it('coalesces simultaneous filesystem checks without caching directory removal', async () => {
    const stat = await fs.stat(root);
    let release!: () => void;
    let entered!: () => void;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = jest.spyOn(fs, 'stat').mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = () => resolve(stat);
      });
    });
    const checks = [
      assertWorkspaceCanExecute(db, workspace.id),
      assertWorkspaceCanExecute(db, workspace.id),
    ];
    await starting;
    release();
    await Promise.all(checks);
    expect(spy).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true });
    await expect(assertWorkspaceCanExecute(db, workspace.id)).rejects.toThrow(
      'unavailable',
    );
  });
});

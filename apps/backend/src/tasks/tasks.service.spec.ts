import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as schema from '../database/schema/index.js';
import { DrizzleDB } from '../database/database.provider.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import * as systemPaths from '../config/system-paths.js';
import { WorktreesService } from '../worktrees/worktrees.service.js';
import { WorktreePoolService } from '../worktrees/worktree-pool.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionsService } from '../actions/actions.service.js';
import { TasksService } from './tasks.service.js';
import { TaskGitService, taskBranchSlug } from './task-git.service.js';
import { TaskWorktreeAllocator } from './task-worktree-allocator.service.js';
import { TaskSetup } from './task.types.js';
import { assertWorkspaceCanExecute } from '../workspaces/workspace-ownership.js';
import { compareWorkspaceOrder } from '../workspaces/workspace-order.js';

jest.setTimeout(60000);

describe('Task lifecycle with real Git and migrations', () => {
  let root: string;
  let repoPath: string;
  let db: DrizzleDB;
  let sqlite: InstanceType<typeof Database>;
  let service: TasksService;
  let gitService: TaskGitService;
  let repo: typeof schema.repos.$inferSelect;
  const hooks = { getStatus: jest.fn(() => 'idle') };
  const terminals = {
    isAlive: jest.fn(() => false),
    hasTmuxSessionForTerminal: jest.fn(async () => false),
    destroy: jest.fn(async () => true),
  };
  const actions = {
    listByWorktree: jest.fn(async () => []),
    getRunningCount: jest.fn(async () => ({ count: 0 })),
    stop: jest.fn(),
  };
  let stopSession: jest.Mock;
  let reactivateRuntime: jest.Mock;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'elevenex-tasks-')));
    repoPath = join(root, 'repo');
    await mkdir(repoPath);
    const git = worktreeSimpleGit(repoPath);
    await git.raw(['init', '--initial-branch=main']);
    await git.addConfig('user.name', 'Task tests');
    await git.addConfig('user.email', 'tasks@example.test');
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
    const [project] = await db
      .insert(schema.projects)
      .values({ name: 'Test' })
      .returning();
    [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: repoPath })
      .returning();
    hooks.getStatus.mockReturnValue('idle');
    terminals.isAlive.mockReturnValue(false);
    terminals.hasTmuxSessionForTerminal.mockResolvedValue(false);
    gitService = new TaskGitService();
    const sessions = {
      create: jest.fn(async ({ workspaceId }: { workspaceId: number }) => {
        const task = (
          await db
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, workspaceId))
        )[0];
        return (
          await db
            .insert(schema.sessions)
            .values({
              repoId: repo.id,
              workspaceId,
              worktreePath: task.path,
              transcriptWorktreePath: task.path,
              branchName: task.taskBranch!,
              name: 'Conversation',
            })
            .returning()
        )[0];
      }),
      archiveAndStop: jest.fn(async (id: number) => {
        await db
          .update(schema.sessions)
          .set({ status: 'archived' })
          .where(eq(schema.sessions.id, id));
      }),
      reactivateRuntime: jest.fn(async (id: number) => {
        const session = (
          await db
            .select()
            .from(schema.sessions)
            .where(eq(schema.sessions.id, id))
        )[0];
        const task = (
          await db
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, session.workspaceId!))
        )[0];
        expect(task.taskState).toBe('preparing');
      }),
    };
    stopSession = sessions.archiveAndStop;
    reactivateRuntime = sessions.reactivateRuntime;
    const allocator = new TaskWorktreeAllocator(
      db,
      gitService,
      new WorktreesService(),
      {
        assertWithinWorktreeLimit: jest.fn(),
      } as unknown as WorktreePoolService,
      hooks as unknown as ClaudeHooksService,
      terminals as unknown as UserPtyManager,
      actions as unknown as ActionsService,
    );
    service = new TasksService(
      db,
      gitService,
      allocator,
      { assertProjectIsActive: jest.fn() } as unknown as ProjectsService,
      sessions as unknown as SessionsService,
      { invalidateCache: jest.fn() } as unknown as BranchesService,
      hooks as unknown as ClaudeHooksService,
      terminals as unknown as UserPtyManager,
      actions as unknown as ActionsService,
    );
  });
  afterEach(async () => {
    if (service)
      await Promise.allSettled([...(service as any).operations.values()]);
    sqlite?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function settled(id: number) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const task = await service.get(id);
      if (
        task.taskState !== 'preparing' &&
        (task.taskState !== 'ready' || task.sessions.length > 0)
      )
        return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Task preparation did not settle');
  }
  async function create(branchName: string, patch: Partial<TaskSetup> = {}) {
    const task = await service.create(repo.id, {
      requestId: randomUUID(),
      mode: 'new',
      branchName,
      baseRef: 'main',
      ...patch,
    });
    return settled(task.id);
  }

  it('persists manual task order, retains concurrent tasks, and appends new tasks after reordering', async () => {
    const [first, second, concurrent] = await db
      .insert(schema.workspaces)
      .values([
        { repoId: repo.id, name: 'First', path: '/first' },
        { repoId: repo.id, name: 'Second', path: '/second' },
        {
          repoId: repo.id,
          name: 'Created in another window',
          path: '/concurrent',
        },
      ])
      .returning();
    expect(await service.move(repo.id, second.id, first.id)).toEqual({
      taskIds: [second.id, first.id, concurrent.id],
    });
    expect(
      (await service.list(repo.id, 'active', 1)).map((item) => item.id),
    ).toEqual([second.id]);
    expect(
      (await service.list(repo.id, 'active', 1, second.id)).map(
        (item) => item.id,
      ),
    ).toEqual([first.id]);
    expect(
      (await service.list(repo.id, 'active', 1, first.id)).map(
        (item) => item.id,
      ),
    ).toEqual([concurrent.id]);
    const latest = await create('newest');
    const rows = await db.select().from(schema.workspaces);
    expect(rows.sort(compareWorkspaceOrder).map((task) => task.id)).toEqual([
      second.id,
      first.id,
      concurrent.id,
      latest.id,
    ]);
    expect(await service.move(repo.id, second.id)).toEqual({
      taskIds: [first.id, concurrent.id, latest.id, second.id],
    });
    expect(await service.move(repo.id, first.id, first.id)).toEqual({
      taskIds: [first.id, concurrent.id, latest.id, second.id],
    });
    expect((await service.list(repo.id)).map((item) => item.id)).toEqual([
      first.id,
      concurrent.id,
      latest.id,
      second.id,
    ]);
  });

  it('rejects reordering the main checkout, finished tasks, and another repository’s tasks', async () => {
    const [otherRepo] = await db
      .insert(schema.repos)
      .values({
        projectId: repo.projectId,
        name: 'Other',
        path: '/other',
      })
      .returning();
    const [main, active, finished, foreign] = await db
      .insert(schema.workspaces)
      .values([
        {
          repoId: repo.id,
          name: 'Main checkout',
          path: repo.path,
          isDefault: true,
        },
        { repoId: repo.id, name: 'Active', path: '/active' },
        {
          repoId: repo.id,
          name: 'Finished',
          path: '/finished',
          archivedAt: new Date().toISOString(),
        },
        { repoId: otherRepo.id, name: 'Foreign', path: '/foreign' },
      ])
      .returning();
    const original = await db.select().from(schema.workspaces);
    for (const task of [main, finished, foreign])
      await expect(service.move(repo.id, task.id)).rejects.toThrow(
        'Only active tasks',
      );
    for (const target of [main, finished, foreign])
      await expect(service.move(repo.id, active.id, target.id)).rejects.toThrow(
        'no longer available',
      );
    expect(await db.select().from(schema.workspaces)).toEqual(original);
  });

  it('keeps a new task preparing when the pool reconciles before checkout allocation', async () => {
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.spyOn(gitService, 'refresh').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pool = new WorktreePoolService(
      db,
      new WorktreesService(),
      {} as SessionsService,
      {} as ProjectsService,
      hooks as unknown as ClaudeHooksService,
      {
        getMaxWorktreesPerRepo: jest.fn(async () => 0),
      } as unknown as SettingsService,
    );
    const task = await service.create(repo.id, {
      requestId: randomUUID(),
      mode: 'new',
      branchName: 'reconcile-during-setup',
      baseRef: 'main',
    });
    await entering;
    try {
      await pool.getWorktreeQuota(repo);
      expect(await service.get(task.id)).toMatchObject({
        taskState: 'preparing',
        path: '',
        error: null,
      });
    } finally {
      release();
    }
    expect(await settled(task.id)).toMatchObject({
      taskState: 'ready',
      linkStatus: 'linked',
      error: null,
    });
  });

  it('creates one task per request, with a stopped initial session and independent display name', async () => {
    const input: TaskSetup = {
      requestId: randomUUID(),
      mode: 'new',
      name: 'Investigate search',
      branchName: 'search-investigation',
      baseRef: 'main',
    };
    const [one, two] = await Promise.all([
      service.create(repo.id, input),
      service.create(repo.id, input),
    ]);
    expect(one.id).toBe(two.id);
    const task = await settled(one.id);
    expect(task).toMatchObject({
      name: 'Investigate search',
      taskBranch: 'search-investigation',
      taskState: 'ready',
      linkStatus: 'linked',
    });
    expect(task.sessions).toHaveLength(1);
    expect(task.sessions[0].status).toBe('created');
    await service.rename(task.id, 'Review search');
    expect((await gitService.status(task.path)).branch).toBe(
      'search-investigation',
    );
    expect(await db.select().from(schema.taskReservations)).toHaveLength(1);
  });

  it('reuses a clean environment without transferring archived conversations to its next task', async () => {
    const one = await create('first');
    const finished = await service.finish(one.id);
    expect(finished).toMatchObject({
      linkStatus: 'unlinked',
      finalCommit: one.startingCommit,
    });
    expect((await gitService.status(one.path)).branch).toBeNull();
    expect(await gitService.hasLocalBranch(repoPath, 'first')).toBe(true);
    const two = await create('second');
    expect(two.id).not.toBe(one.id);
    expect(two.path).toBe(one.path);
    expect((await service.get(one.id)).sessions[0]).toMatchObject({
      workspaceId: one.id,
      status: 'archived',
    });
    expect(
      (await service.list(repo.id, 'finished')).map((task) => task.id),
    ).toEqual([one.id]);
    expect(
      await gitService.resolve(
        repoPath,
        `refs/elevenex/tasks/${one.id}/finish`,
      ),
    ).toBe(one.startingCommit);
    await service.reopen(one.id);
    const reopened = await settled(one.id);
    expect(reopened.id).toBe(one.id);
    expect(reopened.path).not.toBe(two.path);
    expect(reopened.sessions[0]).toMatchObject({
      workspaceId: one.id,
      worktreePath: reopened.path,
      transcriptWorktreePath: one.path,
      status: 'stopped',
    });
    expect(reactivateRuntime).toHaveBeenCalledWith(one.sessions[0].id);
  });

  it('keeps local edits reserved and reopens them intact', async () => {
    const task = await create('dirty');
    await writeFile(join(task.path, 'notes.txt'), 'Investigation findings');
    expect(await service.finish(task.id)).toMatchObject({
      linkStatus: 'linked',
    });
    const next = await create('next');
    expect(next.path).not.toBe(task.path);
    await service.reopen(task.id);
    const reopened = await settled(task.id);
    expect(reopened).toMatchObject({ taskState: 'ready', path: task.path });
    expect((await gitService.status(task.path)).dirty).toBe(true);
    expect(await readFile(join(task.path, 'notes.txt'), 'utf8')).toBe(
      'Investigation findings',
    );
  });

  it.each([false, true])(
    'finishes and reopens the current branch after a user switch (dirty=%s)',
    async (dirty) => {
      const task = await create('original-task');
      const git = worktreeSimpleGit(task.path);
      await git.raw(['checkout', '-b', 'other-work']);
      await git.raw(['commit', '--allow-empty', '-m', 'User work']);
      const head = await gitService.resolve(task.path, 'HEAD');
      if (dirty)
        await writeFile(join(task.path, 'notes.txt'), 'Keep these notes');
      const finished = await service.finish(task.id);
      expect(finished).toMatchObject({
        linkStatus: dirty ? 'linked' : 'unlinked',
        taskBranch: 'other-work',
        checkoutMode: 'branch',
        finalCommit: head,
      });
      await service.reopen(task.id);
      const reopened = await settled(task.id);
      expect(reopened).toMatchObject({
        taskState: 'ready',
        taskBranch: 'other-work',
      });
      expect((await gitService.status(reopened.path)).branch).toBe(
        'other-work',
      );
      if (dirty)
        expect(await readFile(join(reopened.path, 'notes.txt'), 'utf8')).toBe(
          'Keep these notes',
        );
    },
  );

  it('finishes and reopens a detached revision after starting on a branch', async () => {
    const task = await create('original-task');
    const git = worktreeSimpleGit(task.path);
    await git.raw(['checkout', '--detach']);
    await git.raw(['commit', '--allow-empty', '-m', 'Detached work']);
    const head = await gitService.resolve(task.path, 'HEAD');
    expect(await service.finish(task.id)).toMatchObject({
      checkoutMode: 'snapshot',
      taskBranch: null,
      finalCommit: head,
    });
    await service.reopen(task.id);
    const reopened = await settled(task.id);
    expect(reopened.taskState).toBe('ready');
    expect(await gitService.status(reopened.path)).toMatchObject({
      branch: null,
      head,
    });
  });

  it('retains a clean worktree while a rebase is paused', async () => {
    const task = await create('paused-rebase');
    const git = worktreeSimpleGit(task.path);
    await writeFile(join(task.path, 'feature.txt'), 'Task work');
    await git.add('feature.txt');
    await git.commit('Task work');
    await worktreeSimpleGit(repoPath).raw([
      'commit',
      '--allow-empty',
      '-m',
      'Advance main',
    ]);
    await expect(
      git.raw(['rebase', '--exec', 'false', 'main']),
    ).rejects.toThrow();
    expect(await gitService.status(task.path)).toMatchObject({
      dirty: false,
      conflicts: false,
      branch: null,
    });
    expect(await service.finish(task.id)).toMatchObject({
      linkStatus: 'linked',
    });
    expect(await gitService.hasOperationInProgress(task.path)).toBe(true);
    await git.raw(['rebase', '--abort']);
  });

  it('detects detached terminals and retains the checkout when terminal shutdown fails', async () => {
    const task = await create('terminal-lifecycle');
    const [terminal] = await db
      .insert(schema.userTerminals)
      .values({
        workspaceId: task.id,
        worktreePath: task.path,
        name: 'Shell',
        shell: '/bin/sh',
      })
      .returning();
    terminals.hasTmuxSessionForTerminal.mockResolvedValue(true);
    expect((await service.finishPreview(task.id)).terminals).toBe(1);
    await expect(service.finish(task.id)).rejects.toThrow();
    terminals.destroy.mockRejectedValueOnce(
      new Error('Terminal could not stop'),
    );
    await expect(service.finish(task.id, true)).rejects.toThrow(
      'Terminal could not stop',
    );
    expect(terminals.destroy).toHaveBeenCalledWith(terminal.id, true);
    expect((await service.get(task.id)).archivedAt).toBeNull();
    expect((await gitService.status(task.path)).branch).toBe(
      'terminal-lifecycle',
    );
    terminals.hasTmuxSessionForTerminal.mockResolvedValue(false);
    const finished = await service.finish(task.id, true);
    expect(finished.archivedAt).toBeTruthy();
  });

  it('requires an explicit choice before adopting the main repository checkout', async () => {
    const task = await create('refs/heads/main', { mode: 'existing' });
    expect(task.error).toMatchObject({
      code: 'external_checkout',
      canSnapshot: true,
    });
    expect(task.path).toBe('');
    await service.retry(task.id, { confirmExternal: true });
    const ready = await settled(task.id);
    expect(ready.path).toBe(repoPath);
    expect(await service.finish(task.id)).toMatchObject({
      linkStatus: 'linked',
    });
    expect((await gitService.status(repoPath)).branch).toBe('main');
  });

  it('coalesces opening an empty task into one conversation', async () => {
    const task = await create('review');
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.workspaceId, task.id));
    const [one, two] = await Promise.all([
      service.openConversation(task.id),
      service.openConversation(task.id),
    ]);
    expect(one.id).toBe(two.id);
    expect((await service.get(task.id)).sessions).toHaveLength(1);
    await service.finish(task.id);
    await expect(service.openConversation(task.id)).rejects.toThrow('Wait for');
  });

  it('adopts a migrated task with its observed branch, preserving its label and identity', async () => {
    const [legacy] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'Old investigation',
        path: repoPath,
        taskRequestId: 'legacy-workspace-12',
        createdFromRef: 'an-old-base',
      })
      .returning();
    const observed = await service.get(legacy.id);
    expect(observed).toMatchObject({
      id: legacy.id,
      name: 'Old investigation',
      taskBranch: 'main',
      checkoutMode: 'branch',
      taskState: 'ready',
    });
    expect(
      await gitService.resolve(
        repoPath,
        `refs/elevenex/tasks/${legacy.id}/start`,
      ),
    ).toBe(observed.startingCommit);
    expect(
      (await service.rename(legacy.id, 'Review findings')).taskBranch,
    ).toBe('main');
  });

  it('offers the saved revision after a remote refresh fails without creating a branch first', async () => {
    const git = worktreeSimpleGit(repoPath);
    await git.raw([
      'remote',
      'add',
      'origin',
      join(root, 'unavailable-remote'),
    ]);
    const initial = await gitService.resolve(repoPath, 'main');
    await git.raw(['update-ref', 'refs/remotes/origin/main', initial]);
    const task = await create('offline-review', {
      baseRef: 'refs/remotes/origin/main',
    });
    expect(task.error).toMatchObject({
      code: 'fetch_failed',
      savedCommit: initial,
    });
    expect(await gitService.hasLocalBranch(repoPath, 'offline-review')).toBe(
      false,
    );
    await service.retry(task.id, { useSavedRef: true });
    expect(await settled(task.id)).toMatchObject({
      taskState: 'ready',
      startingCommit: initial,
    });
  });

  it('offers an independent pinned snapshot when another task owns the branch', async () => {
    const owner = await create('shared');
    const review = await create('shared', { mode: 'existing' });
    expect(review.error).toMatchObject({
      code: 'branch_in_use',
      existingTaskId: owner.id,
      canSnapshot: true,
    });
    await service.retry(review.id, { checkoutMode: 'snapshot' });
    const snapshot = await settled(review.id);
    expect(snapshot).toMatchObject({
      taskState: 'ready',
      checkoutMode: 'snapshot',
    });
    expect(snapshot.path).not.toBe(owner.path);
    expect((await gitService.status(snapshot.path)).branch).toBeNull();
    expect((await gitService.status(owner.path)).branch).toBe('shared');
    await service.finish(snapshot.id);
    await worktreeSimpleGit(owner.path).raw([
      'commit',
      '--allow-empty',
      '-m',
      'Advance',
    ]);
    await service.reopen(snapshot.id);
    const reopened = await settled(snapshot.id);
    expect((await gitService.status(reopened.path)).head).toBe(
      snapshot.startingCommit,
    );
  });

  it('serializes competing requests without allocating the same environment or branch', async () => {
    const [one, two] = await Promise.all([create('same'), create('same')]);
    expect([one.taskState, two.taskState].sort()).toEqual(['failed', 'ready']);
    expect((one.error || two.error)?.code).toBe('branch_exists');
    expect(await db.select().from(schema.taskReservations)).toHaveLength(1);
  });

  it('refreshes a selected remote branch and configures tracking without resetting a different local tip', async () => {
    const remotePath = join(root, 'remote');
    await mkdir(remotePath);
    await worktreeSimpleGit(remotePath).raw(['init', '--bare']);
    const git = worktreeSimpleGit(repoPath);
    await git.addRemote('upstream', remotePath);
    await git.raw(['push', 'upstream', 'main:review']);
    await git.raw(['fetch', 'upstream']);
    const remote = await create('refs/remotes/upstream/review', {
      mode: 'existing',
    });
    expect(remote).toMatchObject({ taskState: 'ready', taskBranch: 'review' });
    expect(
      (
        await git.raw([
          'for-each-ref',
          '--format=%(upstream:short)',
          'refs/heads/review',
        ])
      ).trim(),
    ).toBe('upstream/review');
    await service.finish(remote.id);
    await git.raw(['commit', '--allow-empty', '-m', 'New upstream revision']);
    await git.raw(['push', 'upstream', 'main:review']);
    const differing = await create('refs/remotes/upstream/review', {
      mode: 'existing',
    });
    expect(differing.error).toMatchObject({
      code: 'remote_differs',
      localBranch: 'review',
    });
    expect(await gitService.resolve(repoPath, 'refs/heads/review')).toBe(
      remote.startingCommit,
    );
  });

  it('does not release an environment when process cleanup fails, and can retry safely', async () => {
    const task = await create('cleanup');
    hooks.getStatus.mockReturnValue('running');
    await expect(service.finish(task.id)).rejects.toMatchObject({
      response: { code: 'running_work' },
    });
    stopSession.mockRejectedValueOnce(new Error('Could not stop process'));
    await expect(service.finish(task.id, true)).rejects.toThrow(
      'Could not stop process',
    );
    expect(await service.get(task.id)).toMatchObject({
      taskState: 'failed',
      linkStatus: 'linked',
      archivedAt: null,
    });
    expect(await db.select().from(schema.taskReservations)).toHaveLength(1);
    hooks.getStatus.mockReturnValue('idle');
    await service.finish(task.id, true);
    expect(await db.select().from(schema.taskReservations)).toHaveLength(0);
  });

  it('restores a deleted branch from its saved final commit on an explicit retry', async () => {
    const task = await create('restore');
    await service.finish(task.id);
    await worktreeSimpleGit(repoPath).raw(['branch', '-D', 'restore']);
    await service.reopen(task.id);
    const missing = await settled(task.id);
    expect(missing.error).toMatchObject({ code: 'branch_missing' });
    await service.retry(task.id, {
      mode: 'new',
      branchName: 'restore',
      baseRef: missing.finalCommit!,
    });
    expect(await settled(task.id)).toMatchObject({
      taskState: 'ready',
      taskBranch: 'restore',
    });
  });

  it('generates valid readable branch suggestions', () => {
    expect(taskBranchSlug('Réview PR #42 — Search')).toBe(
      'review-pr-42-search',
    );
    expect(taskBranchSlug('a'.repeat(99) + ' / more')).toBe('a'.repeat(99));
  });

  it('allows branch switches and detached HEAD without losing files or reserving the original branch', async () => {
    const task = await create('intended');
    await writeFile(join(task.path, 'notes.txt'), 'Investigation notes');
    const git = worktreeSimpleGit(task.path);
    await git.raw(['checkout', '-b', 'unrelated']);
    await expect(assertWorkspaceCanExecute(db, task.id)).resolves.toMatchObject(
      { taskState: 'ready' },
    );
    expect(await service.get(task.id)).toMatchObject({
      taskState: 'ready',
      error: null,
    });
    expect(
      (await db.select().from(schema.taskReservations))[0].branchName,
    ).toBeNull();
    const another = await create('intended', {
      mode: 'existing',
      branchName: 'intended',
    });
    expect(another.taskState).toBe('ready');
    expect(another.path).not.toBe(task.path);
    await git.raw(['checkout', '--detach']);
    await expect(assertWorkspaceCanExecute(db, task.id)).resolves.toMatchObject(
      { taskState: 'ready' },
    );
    expect(await readFile(join(task.path, 'notes.txt'), 'utf8')).toBe(
      'Investigation notes',
    );
  });

  it('recovers an old branch failure on retry without changing the checkout', async () => {
    const task = await create('intended');
    const git = worktreeSimpleGit(task.path);
    await git.raw(['checkout', '-b', 'unrelated']);
    await db
      .update(schema.workspaces)
      .set({
        taskState: 'failed',
        taskError: JSON.stringify({ code: 'branch_changed' }),
      })
      .where(eq(schema.workspaces.id, task.id));
    expect(await service.retry(task.id)).toMatchObject({
      taskState: 'ready',
      error: null,
    });
    expect((await gitService.status(task.path)).branch).toBe('unrelated');
  });

  it('recommends the repository default rather than a previously used base', async () => {
    await worktreeSimpleGit(repoPath).raw(['branch', 'release']);
    await db
      .update(schema.repos)
      .set({ taskBaseRef: 'refs/heads/release' })
      .where(eq(schema.repos.id, repo.id));
    expect((await service.defaults(repo.id)).baseRef).toBe('refs/heads/main');
    await create('from-release', { baseRef: 'refs/heads/release' });
    expect((await service.defaults(repo.id)).baseRef).toBe('refs/heads/main');
  });

  it('does not turn a transient observation error into a failed migrated task', async () => {
    const task = await create('legacy');
    await db
      .update(schema.workspaces)
      .set({
        taskConfig: null,
        taskBranch: null,
        startingCommit: null,
        taskRequestId: `legacy-workspace-${task.id}`,
      })
      .where(eq(schema.workspaces.id, task.id));
    const observation = jest
      .spyOn(systemPaths, 'worktreeSimpleGit')
      .mockReturnValueOnce({
        revparse: jest.fn(async () => {
          throw new Error('Git temporarily unavailable');
        }),
      } as never);
    try {
      expect(await service.get(task.id)).toMatchObject({
        taskState: 'ready',
        error: { code: 'checkout_unavailable' },
      });
    } finally {
      observation.mockRestore();
    }
    expect(
      (
        await db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, task.id))
      )[0],
    ).toMatchObject({ taskState: 'ready', taskError: null });
    expect(await service.get(task.id)).toMatchObject({
      taskState: 'ready',
      taskBranch: 'legacy',
      error: null,
    });
  });
  it('keeps a legacy task usable through a rebase without recording a temporary snapshot', async () => {
    const mainGit = worktreeSimpleGit(repoPath);
    await writeFile(join(repoPath, 'shared.txt'), 'base\n');
    await mainGit.add('shared.txt');
    await mainGit.commit('Base file');
    const task = await create('intended');
    await db
      .update(schema.workspaces)
      .set({
        taskConfig: null,
        taskBranch: null,
        startingCommit: null,
        taskRequestId: `legacy-workspace-${task.id}`,
      })
      .where(eq(schema.workspaces.id, task.id));
    const taskGit = worktreeSimpleGit(task.path);
    await writeFile(join(task.path, 'shared.txt'), 'task edit\n');
    await taskGit.add('shared.txt');
    await taskGit.commit('Task edit');
    await writeFile(join(repoPath, 'shared.txt'), 'main edit\n');
    await mainGit.add('shared.txt');
    await mainGit.commit('Main edit');
    await expect(taskGit.raw(['rebase', 'main'])).rejects.toThrow();
    expect((await taskGit.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'HEAD',
    );
    await expect(assertWorkspaceCanExecute(db, task.id)).resolves.toMatchObject(
      { taskState: 'ready' },
    );
    expect(await service.get(task.id)).toMatchObject({
      taskState: 'ready',
      taskBranch: null,
      startingCommit: null,
      error: null,
    });
    expect((await taskGit.status()).conflicted).toContain('shared.txt');
    await taskGit.raw(['rebase', '--abort']);
    expect(await service.get(task.id)).toMatchObject({
      taskBranch: 'intended',
      checkoutMode: 'branch',
    });
    await expect(assertWorkspaceCanExecute(db, task.id)).resolves.toMatchObject(
      { taskState: 'ready' },
    );
  });

  it('allows finishing other tasks and cancelling setup during a stalled remote refresh', async () => {
    const ready = await create('existing');
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.spyOn(gitService, 'refresh').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const preparing = await service.create(repo.id, {
      requestId: randomUUID(),
      mode: 'new',
      branchName: 'waiting',
      baseRef: 'main',
    });
    await entering;
    expect((await service.get(preparing.id)).preparationStage).toBe(
      'refreshing_ref',
    );
    try {
      expect((await service.finish(ready.id)).archivedAt).toBeTruthy();
      expect((await service.finish(preparing.id)).archivedAt).toBeTruthy();
    } finally {
      release();
    }
    await Promise.allSettled([...(service as any).operations.values()]);
    expect(await service.get(preparing.id)).toMatchObject({
      taskState: 'ready',
      linkStatus: 'unlinked',
    });
    expect(await gitService.hasLocalBranch(repoPath, 'waiting')).toBe(false);
  });
});

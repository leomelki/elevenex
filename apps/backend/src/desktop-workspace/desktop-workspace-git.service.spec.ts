import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../database/testing/create-test-db.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { GitService } from '../git/git.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { DesktopWorkspaceGitService } from './desktop-workspace-git.service.js';

const execute = promisify(execFile);
describe('desktop workspace git boundary', () => {
  let database: ReturnType<typeof createTestDb>;
  let service: DesktopWorkspaceGitService;
  let root: string;
  let repository: string;
  let checkout: string;
  let projectId: number;
  let taskId: number;
  let repoId: number;
  const commit = jest.fn().mockResolvedValue({
    hash: 'a',
    message: 'Saved',
    generatedMessage: false,
  });
  const push = jest.fn().mockResolvedValue({ pushed: true });
  const git = async (cwd: string, ...args: string[]) =>
    (await execute('git', args, { cwd, timeout: 10000 })).stdout.trim();
  beforeEach(async () => {
    commit.mockClear();
    push.mockClear();
    push.mockResolvedValue({ pushed: true });
    root = await mkdtemp(join(tmpdir(), 'elevenex-workspace-git-'));
    repository = join(root, 'repository');
    checkout = join(root, 'task');
    await git(root, 'init', '-b', 'main', repository);
    await git(repository, 'config', 'user.email', 'test@example.test');
    await git(repository, 'config', 'user.name', 'Test');
    await writeFile(join(repository, 'initial'), 'initial');
    await git(repository, 'add', '--all');
    await git(repository, 'commit', '-m', 'Initial');
    const remote = join(root, 'remote.git');
    await git(root, 'clone', '--bare', repository, remote);
    await git(repository, 'remote', 'add', 'origin', remote);
    await git(repository, 'push', '-u', 'origin', 'main');
    await git(repository, 'worktree', 'add', '-b', 'task', checkout);
    await git(checkout, 'config', 'branch.task.remote', 'origin');
    await git(checkout, 'config', 'branch.task.merge', 'refs/heads/main');
    database = createTestDb();
    const db = database.db;
    projectId = (
      await db.insert(schema.projects).values({ name: 'Project' }).returning()
    )[0].id;
    repoId = (
      await db
        .insert(schema.repos)
        .values({ projectId, name: 'Repo', path: repository })
        .returning()
    )[0].id;
    taskId = (
      await db
        .insert(schema.workspaces)
        .values({ repoId, name: 'Task', path: checkout, taskBranch: 'task' })
        .returning()
    )[0].id;
    await db.insert(schema.sessions).values({
      repoId,
      workspaceId: taskId,
      branchName: 'task',
      worktreePath: checkout,
      name: 'Session',
    });
    const module = await Test.createTestingModule({
      providers: [
        DesktopWorkspaceGitService,
        TaskGitService,
        ProjectsService,
        { provide: DRIZZLE, useValue: db },
        { provide: SessionsService, useValue: {} },
        {
          provide: TasksService,
          useValue: {
            finishPreview: async () => ({
              agents: 2,
              terminals: 1,
              actions: 1,
            }),
            record: (id: number) =>
              db
                .select()
                .from(schema.workspaces)
                .where(eq(schema.workspaces.id, id))
                .then((rows) => rows[0]),
            repo: (id: number) =>
              db
                .select()
                .from(schema.repos)
                .where(eq(schema.repos.id, id))
                .then((rows) => rows[0]),
          },
        },
        {
          provide: GitService,
          useValue: {
            commit,
            push,
            getStatusSummary: async () => ({
              branch: await git(checkout, 'branch', '--show-current'),
              upstream: 'origin/main',
              ahead: 0,
              behind: 0,
              files: [],
              total: { files: 0, additions: 0, deletions: 0 },
            }),
          },
        },
      ],
    }).compile();
    service = module.get(DesktopWorkspaceGitService);
  });
  afterEach(async () => {
    database?.sqlite.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('computes close confirmation counts from durable task sessions beyond the loaded navigation window', async () => {
    await database.db
      .insert(schema.sessions)
      .values(
        Array.from({ length: 30 }, (_, index) => ({
          repoId,
          workspaceId: taskId,
          branchName: 'task',
          worktreePath: checkout,
          name: `Session ${index}`,
        })),
      );
    expect(await service.closePreview(taskId)).toEqual({
      taskId,
      sessions: 31,
      running: 2,
      terminals: 1,
      actions: 1,
      unpushed: 0,
      uncommitted: 0,
    });
  });

  it('validates the message and preserves legacy commit delegation', async () => {
    await expect(
      service.action(taskId, { type: 'commit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.action(taskId, null!)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(commit).not.toHaveBeenCalled();
    await service.action(taskId, {
      type: 'commit',
      message: 'Save the selected task',
    });
    expect(commit).toHaveBeenCalledWith(checkout, {
      message: 'Save the selected task',
      includeUnstaged: true,
    });
  });
  it('renames the actual branch and updates its durable task/session ownership together', async () => {
    await service.action(taskId, {
      type: 'rename-branch',
      branchName: 'renamed',
    });
    expect(await git(checkout, 'branch', '--show-current')).toBe('renamed');
    expect(
      (
        await database.db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, taskId))
      )[0].taskBranch,
    ).toBe('renamed');
    expect(
      (await database.db.select().from(schema.sessions))[0].branchName,
    ).toBe('renamed');
    await expect(
      service.action(taskId, { type: 'rename-branch', branchName: '--force' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects stale checkouts, archived projects, and branch identities owned by another task', async () => {
    await database.db
      .insert(schema.workspaces)
      .values({ repoId, name: 'Held', path: '/unused', taskBranch: 'held' });
    await expect(
      service.action(taskId, { type: 'rename-branch', branchName: 'held' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await git(checkout, 'branch', '-m', 'external-change');
    await expect(
      service.action(taskId, { type: 'push' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(push).not.toHaveBeenCalled();
    await git(checkout, 'branch', '-m', 'task');
    await database.db
      .update(schema.projects)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.projects.id, projectId));
    await expect(
      service.action(taskId, { type: 'push' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(push).not.toHaveBeenCalled();
  });
  it('delegates push without force options and treats a rejected push as a conflict', async () => {
    await service.action(taskId, { type: 'push' });
    expect(push).toHaveBeenCalledWith(checkout);
    push.mockResolvedValueOnce({ pushed: false });
    await expect(
      service.action(taskId, { type: 'push' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('fast-forwards from upstream and preserves divergent local history when sync cannot fast-forward', async () => {
    await writeFile(join(repository, 'remote-change'), 'remote');
    await git(repository, 'add', '--all');
    await git(repository, 'commit', '-m', 'Remote update');
    await git(repository, 'push', 'origin', 'main');
    await service.action(taskId, { type: 'sync' });
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(
      await git(repository, 'rev-parse', 'HEAD'),
    );
    await writeFile(join(checkout, 'local-change'), 'local');
    await git(checkout, 'add', '--all');
    await git(checkout, 'commit', '-m', 'Local update');
    const head = await git(checkout, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'another-remote-change'), 'remote2');
    await git(repository, 'add', '--all');
    await git(repository, 'commit', '-m', 'Divergent update');
    await git(repository, 'push', 'origin', 'main');
    await expect(service.action(taskId, { type: 'sync' })).rejects.toThrow();
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  });
});

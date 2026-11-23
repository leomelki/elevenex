import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
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
import { SettingsService } from '../settings/settings.service.js';
import { TurnChangesService } from '../agent-runtime/turn-changes.service.js';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';

const execute = promisify(execFile);
const selection = { includeUnstaged: true, excluded: [], includedSecrets: [] };
describe('desktop workspace git boundary', () => {
  let database: ReturnType<typeof createTestDb>;
  let service: DesktopWorkspaceGitService;
  let root: string;
  let repository: string;
  let checkout: string;
  let projectId: number;
  let taskId: number;
  let repoId: number;
  let settings: SettingsService;
  let gitBoundary: Pick<GitService, 'commit' | 'push' | 'getStatusSummary'>;
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
    await git(root, 'init', repository);
    await git(repository, 'symbolic-ref', 'HEAD', 'refs/heads/main');
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
    gitBoundary = {
      commit,
      push,
      getStatusSummary: async () => ({
        branch: await git(checkout, 'branch', '--show-current'),
        upstream: 'origin/main',
        headSha: null,
        worktreeFingerprint: '',
        hasChanges: false,
        ahead: 0,
        behind: 0,
        files: [],
        staged: { files: 0, additions: 0, deletions: 0 },
        unstaged: { files: 0, additions: 0, deletions: 0 },
        total: { files: 0, additions: 0, deletions: 0 },
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        DesktopWorkspaceGitService,
        TaskGitService,
        ProjectsService,
        SettingsService,
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
          useValue: gitBoundary,
        },
      ],
    }).compile();
    service = module.get(DesktopWorkspaceGitService);
    settings = module.get(SettingsService);
  });
  afterEach(async () => {
    database?.sqlite.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('computes close confirmation counts from durable task sessions beyond the loaded navigation window', async () => {
    await database.db.insert(schema.sessions).values(
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

  it('keeps workspace Git changes current across sessions, manual edits and later restores', async () => {
    const testing = await Test.createTestingModule({
      providers: [GitService, { provide: TextAgentGenerationService, useValue: {} }],
    }).compile();
    const realGit = testing.get(GitService);
    gitBoundary.getStatusSummary = realGit.getStatusSummary.bind(realGit);
    const [first, second] = await database.db.insert(schema.sessions).values([
      { repoId, workspaceId: taskId, branchName: 'task', worktreePath: checkout, name: 'First' },
      { repoId, workspaceId: taskId, branchName: 'task', worktreePath: checkout, name: 'Second' },
    ]).returning();
    const detector = new TurnChangesService(database.db);
    const waitForFiles = async (files: number) => {
      const deadline = Date.now() + 3500;
      let summary = await service.summary(taskId);
      while (summary.files !== files && Date.now() < deadline) {
        await delay(50);
        summary = await service.summary(taskId);
      }
      expect(summary.files).toBe(files);
      return summary;
    };
    try {
      const clean = await service.summary(taskId);
      const a = await detector.begin(first.id, 'codex', checkout);
      const b = await detector.begin(second.id, 'pi', checkout);
      await writeFile(join(checkout, 'from-agent'), 'agent\n');
      await writeFile(join(checkout, 'initial'), 'manual edit\n');
      const dirty = await waitForFiles(2);
      expect(dirty.changesRevision).not.toBe(clean.changesRevision);
      expect((await detector.finish(a, 'a'))?.turnChanges?.capture?.shared).toBe(true);
      await rm(join(checkout, 'from-agent'));
      await waitForFiles(1);
      expect((await detector.finish(b, 'b'))?.turnChanges?.filesChanged.map(file => file.path)).toEqual(['initial']);
      await git(checkout, 'restore', '--', 'initial');
      await waitForFiles(0);
    } finally {
      await detector.onModuleDestroy();
      await testing.close();
    }
  });

  describe('AI commits through the generation boundary', () => {
    const generate = jest.fn<
      ReturnType<TextAgentGenerationService['generate']>,
      Parameters<TextAgentGenerationService['generate']>
    >();
    beforeEach(async () => {
      generate.mockReset();
      const module = await Test.createTestingModule({
        providers: [
          GitService,
          { provide: TextAgentGenerationService, useValue: { generate } },
        ],
      }).compile();
      const realGit = module.get(GitService);
      gitBoundary.commit = realGit.commit.bind(realGit);
      gitBoundary.getStatusSummary = realGit.getStatusSummary.bind(realGit);
      await git(checkout, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(checkout, 'chosen.txt'), 'chosen change\n');
    });

    it.each(
      (['claude', 'codex', 'pi', 'opencode'] as const).flatMap((provider) =>
        [true, false].map((snapshot) => ({ provider, snapshot })),
      ),
    )(
      'commits using configured $provider (snapshot: $snapshot)',
      async ({ provider, snapshot }) => {
        await settings.update({
          defaultAgentProvider: provider,
          agentModelPresets: [
            {
              id: 'configured',
              name: 'Configured',
              provider,
              model: null,
              reasoningEffort: null,
              isDefault: true,
            },
          ],
        });
        await settings.rememberAgentConfig({
          provider: provider === 'codex' ? 'claude' : 'codex',
          model: null,
          reasoningEffort: null,
          fastMode: false,
        });
        generate.mockResolvedValue({
          provider,
          model: null,
          text: '{"subject":"fix: save chosen change","body":"Explain the change."}',
        });
        const preview = snapshot
          ? await service.commitPreview(taskId, selection)
          : null;
        await service.action(taskId, {
          type: 'commit',
          message: '   ',
          ...(preview ? { selection, revision: preview.revision } : {}),
        });
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate).toHaveBeenCalledWith(
          expect.objectContaining({
            provider,
            worktreePath: checkout,
            taskName: 'commit-message',
          }),
        );
        expect(generate.mock.calls[0][0].prompt).toContain('+chosen change');
        expect(await git(checkout, 'log', '-1', '--format=%B')).toBe(
          'fix: save chosen change\n\nExplain the change.',
        );
        expect(await git(checkout, 'show', 'HEAD:chosen.txt')).toBe(
          'chosen change',
        );
        expect(await git(checkout, 'status', '--porcelain')).toBe('');
        expect(await service.summary(taskId)).not.toHaveProperty('commitPhase');
      },
    );

    it('uses the last-used provider when no explicit provider defaults exist', async () => {
      await settings.rememberAgentConfig({
        provider: 'pi',
        model: 'provider/model',
        reasoningEffort: 'low',
        fastMode: false,
      });
      generate.mockResolvedValue({
        provider: 'pi',
        model: 'provider/model',
        text: '{"subject":"Save chosen change","body":null}',
      });
      await service.action(taskId, { type: 'commit', message: '' });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'pi' }),
      );
      expect(settings.getAgentProviderDefaults('pi').model).toBe(
        'provider/model',
      );
    });

    it('follows the branch the user checked out instead of the branch recorded at task creation', async () => {
      await git(checkout, 'switch', '-c', 'user-choice');
      const preview = await service.commitPreview(taskId, selection);
      await service.action(taskId, {
        type: 'commit',
        message: 'On the chosen branch',
        selection,
        revision: preview.revision,
      });
      expect(
        await git(checkout, 'log', '-1', '--format=%s', 'user-choice'),
      ).toBe('On the chosen branch');
      expect(await git(checkout, 'log', '-1', '--format=%s', 'task')).toBe(
        'Initial',
      );
      await service.action(taskId, { type: 'push' });
      expect(push).toHaveBeenCalledWith(checkout);
      await service.action(taskId, {
        type: 'rename-branch',
        branchName: 'user-renamed',
      });
      expect(await git(checkout, 'branch', '--show-current')).toBe(
        'user-renamed',
      );
      expect(await git(checkout, 'branch', '--list', 'task')).not.toBe('');
    });

    it('commits a selection on a detached checkout but cannot rename a missing branch', async () => {
      await git(checkout, 'switch', '--detach');
      const preview = await service.commitPreview(taskId, selection);
      await service.action(taskId, {
        type: 'commit',
        message: 'Detached',
        selection,
        revision: preview.revision,
      });
      expect(await git(checkout, 'log', '-1', '--format=%s')).toBe('Detached');
      expect(await git(checkout, 'show', 'HEAD:chosen.txt')).toBe(
        'chosen change',
      );
      await expect(
        service.action(taskId, { type: 'rename-branch', branchName: 'named' }),
      ).rejects.toMatchObject({ response: { code: 'branch-detached' } });
    });

    it('commits a manual message without loading settings or starting a provider', async () => {
      const findSettings = jest.spyOn(settings, 'findOne');
      const preview = await service.commitPreview(taskId, selection);
      await service.action(taskId, {
        type: 'commit',
        message: 'Manual message',
        selection,
        revision: preview.revision,
      });
      expect(generate).not.toHaveBeenCalled();
      expect(findSettings).not.toHaveBeenCalled();
      expect(await git(checkout, 'log', '-1', '--format=%B')).toBe(
        'Manual message',
      );
    });
  });
  it.each(['rejected', 'interrupted'])('reports a saved commit after a %s push and allows push without committing again', async (failure) => {
    if (failure === 'rejected') push.mockResolvedValueOnce({ pushed: false });
    else push.mockRejectedValueOnce(new Error('Transport interrupted'));
    await expect(service.action(taskId, { type: 'commit', message: 'Save first', push: true }))
      .rejects.toMatchObject({ response: { code: 'commit-saved-push-failed' } });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await service.summary(taskId)).not.toHaveProperty('commitPhase');
    await service.action(taskId, { type: 'push' });
    expect(push).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
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
  it.each([
    ['git@github.com: Permission denied (publickey).', false, 'git-push-authentication'],
    ['Permission denied (publickey,password).', false, 'git-push-authentication'],
    ['fatal: Authentication failed for https://user:secret@example.test/repo', false, 'git-push-authentication'],
    ["fatal: could not read Username for 'https://example.test': terminal prompts disabled", false, 'git-push-authentication'],
    ['HTTP Basic: Access denied', false, 'git-push-authentication'],
    ['! [rejected] task -> task (fetch first)', true, 'git-push-behind'],
    ['Could not resolve host: example.test', false, 'git-push-failed'],
    ['No git remote is configured for this repository.', false, 'git-push-failed'],
    ['pre-push hook declined https://user:secret@example.test/repo', false, 'git-push-failed'],
  ])('reports a safe push failure for %s', async (message, nonFastForward, code) => {
    push.mockResolvedValueOnce({ pushed: false, message, nonFastForward });
    await expect(service.action(taskId, { type: 'push' })).rejects.toMatchObject({ response: { code } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(await git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('task');
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

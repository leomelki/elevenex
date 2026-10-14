import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskGitService } from './task-git.service';
import { execFileAsync } from '../terminal/async-process';
import { worktreeSimpleGit } from '../config/system-paths';

jest.mock('../terminal/async-process', () => ({ execFileAsync: jest.fn() }));

describe('TaskGitService remote refresh', () => {
  let service: TaskGitService;
  const execute = jest.mocked(execFileAsync);
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TaskGitService();
    jest.spyOn(service, 'remoteRef').mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
    });
    jest.spyOn(service, 'repositoryKey').mockResolvedValue('/repo/.git');
    jest.spyOn(service, 'resolve').mockResolvedValue('saved-revision');
  });

  it('coalesces fetches across checkouts and bounds network and credential waits', async () => {
    let release!: () => void;
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stdout: '', stderr: '' });
        }),
    );
    const first = service.refresh('/repo', 'origin/main');
    const second = service.refresh('/other-checkout', 'origin/main');
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'git',
      [
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ],
      expect.objectContaining({
        timeout: 30_000,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        }),
      }),
    );
    release();
    await Promise.all([first, second]);
    execute.mockResolvedValue({ stdout: '', stderr: '' });
    await service.refresh('/repo', 'origin/main');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('offers the saved revision after a timed-out fetch and permits a later retry', async () => {
    execute.mockRejectedValue(new Error('fetch timed out'));
    const refresh = service.refresh('/repo', 'origin/main');
    await expect(refresh).rejects.toMatchObject({
      response: { code: 'fetch_failed', savedCommit: 'saved-revision' },
    });
    execute.mockResolvedValue({ stdout: '', stderr: '' });
    await service.refresh('/repo', 'origin/main');
    expect(execute).toHaveBeenCalledTimes(2);
    await service.refresh('/repo', 'origin/main', true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('TaskGitService checkout inspection with real Git', () => {
  let root: string;
  let service: TaskGitService;
  const optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'elevenex-task-git-')));
    service = new TaskGitService();
    const git = worktreeSimpleGit(root);
    await git.raw(['init', '--initial-branch=main']);
    await git.addConfig('user.name', 'Task tests');
    await git.addConfig('user.email', 'tasks@example.test');
    await git.addConfig('core.untrackedCache', 'true');
    // Machine-wide signing must not make test commits wait on an agent.
    await git.addConfig('commit.gpgsign', 'false');
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(root, 'nested', 'deeper', 'file.txt'), 'one\n');
    await writeFile(join(root, 'top.txt'), 'one\n');
    await git.add('.');
    await git.commit('Initial');
    // Match the backend process, which disables optional index locks.
    process.env.GIT_OPTIONAL_LOCKS = '0';
  });
  afterEach(async () => {
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
    await rm(root, { recursive: true, force: true });
  });

  it('saves index caches only when asked to persist them', async () => {
    const index = join(root, '.git', 'index');
    const initial = await readFile(index);
    expect(await service.status(root)).toMatchObject({
      dirty: false,
      branch: 'main',
    });
    expect((await readFile(index)).equals(initial)).toBe(true);
    expect(await service.status(root, { persistIndex: true })).toMatchObject({
      dirty: false,
      branch: 'main',
    });
    expect((await readFile(index)).equals(initial)).toBe(false);
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('counts the tracked paths a checkout between revisions rewrites', async () => {
    const git = worktreeSimpleGit(root);
    const first = await service.resolve(root, 'HEAD');
    await writeFile(join(root, 'top.txt'), 'two\n');
    await writeFile(join(root, 'nested', 'added.txt'), 'new\n');
    await git.add('.');
    await git.commit('Second');
    const second = await service.resolve(root, 'HEAD');
    expect(await service.changedPathCount(root, first, first)).toBe(0);
    expect(await service.changedPathCount(root, first, second)).toBe(2);
    expect(await service.changedPathCount(root, 'missing', second)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

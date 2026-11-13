import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskGitService } from './task-git.service';
import { execFileAsync } from '../terminal/async-process';
import { worktreeSimpleGit } from '../config/system-paths';
import * as systemPaths from '../config/system-paths';

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
    await git.raw(['init']);
    await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
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
    jest.restoreAllMocks();
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
    await rm(root, { recursive: true, force: true });
  });

  it('uses one canonical repository key for root, nested, linked and symlinked checkouts', async () => {
    const linked = join(root, 'linked');
    const alias = join(root, 'alias');
    const nested = join(root, 'nested', 'deeper');
    const nestedAlias = join(root, 'nested-alias');
    await worktreeSimpleGit(root).raw([
      'worktree',
      'add',
      '--detach',
      linked,
      'HEAD',
    ]);
    await symlink(linked, alias, 'dir');
    await symlink(nested, nestedAlias, 'dir');
    const key = await realpath(join(root, '.git'));
    for (const checkout of [root, nested, nestedAlias, linked, alias]) {
      expect(await service.repositoryKey(checkout)).toBe(key);
    }
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

  it('reads branch, commit and status in one process without upstream history traversal', async () => {
    const git = worktreeSimpleGit(root);
    const head = await service.resolve(root, 'HEAD');
    const raw = jest.spyOn(git, 'raw');
    jest.spyOn(systemPaths, 'worktreeSimpleGit').mockReturnValue(git);
    expect(await service.status(root)).toEqual({
      branch: 'main',
      head,
      dirty: false,
      conflicts: false,
    });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][0]).toContain('--no-ahead-behind');
    expect(raw.mock.calls[0][0]).toContain('--no-renames');
  });

  it('handles detached HEAD, renames with header-like paths, untracked files and conflicts', async () => {
    const git = worktreeSimpleGit(root);
    const unusualPath =
      process.platform === 'win32'
        ? '# branch.head misleading name'
        : '# branch.head misleading\nname';
    await git.raw(['mv', 'top.txt', unusualPath]);
    expect(await service.status(root)).toMatchObject({
      branch: 'main',
      dirty: true,
      conflicts: false,
    });
    await git.raw(['reset', '--hard', 'HEAD']);
    await writeFile(join(root, '# branch.head false-branch'), 'local');
    await writeFile(join(root, 'u false-conflict'), 'local');
    await git.add('.');
    await git.raw(['commit', '-m', 'Unusual paths']);
    await git.raw(['mv', '# branch.head false-branch', 'renamed.txt']);
    await git.raw(['mv', 'u false-conflict', 'other-renamed.txt']);
    expect(await service.status(root)).toMatchObject({
      branch: 'main',
      dirty: true,
      conflicts: false,
    });
    await git.raw(['reset', '--hard', 'HEAD']);
    await git.raw(['checkout', '--detach']);
    expect(await service.status(root)).toMatchObject({
      branch: null,
      dirty: false,
      conflicts: false,
    });
    await writeFile(
      join(
        root,
        process.platform === 'win32' ? 'untracked file' : 'untracked\nfile',
      ),
      'local',
    );
    expect(await service.status(root)).toMatchObject({
      branch: null,
      dirty: true,
      conflicts: false,
    });
    await git.raw(['checkout', '-b', 'incoming']);
    await writeFile(join(root, 'top.txt'), 'incoming\n');
    await git.raw(['commit', '-am', 'Incoming']);
    await git.raw(['checkout', 'main']);
    await writeFile(join(root, 'top.txt'), 'current\n');
    await git.raw(['commit', '-am', 'Current']);
    await git.raw(['merge', 'incoming']).catch(() => undefined);
    expect(await service.status(root)).toMatchObject({
      branch: 'main',
      dirty: true,
      conflicts: true,
    });
  });

  it('selects configured remote defaults in two processes, including symbolic custom defaults', async () => {
    const git = worktreeSimpleGit(root);
    await git.raw(['remote', 'add', 'upstream', root]);
    await git.raw(['remote', 'add', 'origin', root]);
    await git.raw(['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    await git.raw(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git.raw(['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
    await git.raw([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);
    const raw = jest.spyOn(git, 'raw');
    const remotes = jest.spyOn(git, 'getRemotes');
    jest.spyOn(systemPaths, 'worktreeSimpleGit').mockReturnValue(git);
    expect(await service.defaultBase(root)).toBe('refs/remotes/origin/trunk');
    expect(raw).toHaveBeenCalledTimes(1);
    expect(remotes).toHaveBeenCalledTimes(1);
    await git.raw(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    expect(await service.defaultBase(root)).toBe('refs/remotes/origin/main');
    await git.raw(['remote', 'remove', 'origin']);
    expect(await service.defaultBase(root)).toBe('refs/remotes/upstream/main');
    await git.raw(['remote', 'remove', 'upstream']);
    expect(await service.defaultBase(root)).toBe('refs/heads/main');
    await git.raw(['branch', '-m', 'main', 'master']);
    expect(await service.defaultBase(root)).toBe('refs/heads/master');
    await git.raw(['branch', '-m', 'master', 'feature']);
    expect(await service.defaultBase(root)).toBeNull();
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

import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { scheduledGitRaw } from '../git/git-read-scheduler.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import { prepareProjectRepositories } from '../desktop-workspace/desktop-project-repositories.js';
import { isolateGitEnvironment } from './git-environment.js';
import { worktreeSimpleGit } from './system-paths.js';

const execute = promisify(execFile);

describe('Git repository environment isolation', () => {
  let root: string;
  let foreign: string;
  let target: string;
  let originalEnv: NodeJS.ProcessEnv;
  const git = async (cwd: string, ...args: string[]) =>
    (
      await execute('git', args, {
        cwd,
        env: isolateGitEnvironment(process.env),
      })
    ).stdout.trim();
  beforeEach(async () => {
    originalEnv = { ...process.env };
    root = await realpath(await mkdtemp(join(tmpdir(), 'elevenex-git-env-')));
    foreign = join(root, 'foreign');
    target = join(root, 'target');
    for (const cwd of [foreign, target]) {
      await mkdir(cwd);
      await git(cwd, 'init');
      await git(cwd, 'config', 'user.name', 'Fixture');
      await git(cwd, 'config', 'user.email', 'fixture@example.test');
      await git(cwd, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(cwd, 'initial'), cwd);
      await git(cwd, 'add', '.');
      await git(cwd, 'commit', '-m', 'initial');
    }
    Object.assign(process.env, {
      GIT_DIR: join(foreign, '.git'),
      GIT_COMMON_DIR: join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: join(foreign, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: foreign,
    });
  });
  afterEach(async () => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps discovery, scheduled reads and staging in the requested repository', async () => {
    expect(await new TaskGitService().repositoryKey(target)).toBe(
      join(target, '.git'),
    );
    expect(
      (await scheduledGitRaw(target, ['rev-parse', '--show-toplevel'])).trim(),
    ).toBe(target);
    const before = await readFile(join(foreign, '.git', 'index'));
    await writeFile(join(target, 'target-file'), 'target');
    await worktreeSimpleGit(target).raw(['add', '--', 'target-file']);
    expect(await git(target, 'diff', '--cached', '--name-only')).toBe(
      'target-file',
    );
    expect(await readFile(join(foreign, '.git', 'index'))).toEqual(before);
    expect(await git(foreign, 'status', '--porcelain')).toBe('');
  });

  it('permits an explicit temporary index after clearing inherited Git state', async () => {
    const scratch = join(root, 'temporary index');
    await writeFile(join(target, 'target-file'), 'target');
    await worktreeSimpleGit(target)
      .env('GIT_INDEX_FILE', scratch)
      .raw(['add', '--', 'target-file']);
    const result = await scheduledGitRaw(target, ['ls-files'], 0, {
      GIT_INDEX_FILE: scratch,
    });
    expect(result.trim()).toBe('target-file');
    expect(await git(target, 'diff', '--cached', '--name-only')).toBe('');
    expect(await git(foreign, 'status', '--porcelain')).toBe('');
  });

  it('initializes the selected folder without reinitializing or committing in the inherited repository', async () => {
    const fresh = join(root, 'fresh');
    await mkdir(fresh);
    const foreignHead = await git(foreign, 'rev-parse', 'HEAD');
    await prepareProjectRepositories(
      [{ path: fresh, initialize: true }],
      new AbortController().signal,
    );
    expect(await git(fresh, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await git(foreign, 'rev-parse', 'HEAD')).toBe(foreignHead);
    expect(await git(foreign, 'status', '--porcelain')).toBe('');
  });

  it('preserves global includes, per-repository settings and inherited command options', async () => {
    const global = join(root, 'global config');
    const included = join(root, 'included config');
    const conditional = join(root, 'conditional config');
    const gitPath = (value: string) => value.replace(/\\/g, '/');
    await writeFile(
      included,
      '[core]\n untrackedCache = true\n fsmonitor = /custom/fsmonitor\n[credential]\n helper = !custom-auth-helper\n',
    );
    await writeFile(
      conditional,
      '[test]\n conditional = selected-repository\n',
    );
    await writeFile(
      global,
      `[include]\n path = ${JSON.stringify(included)}\n[includeIf "gitdir/i:${gitPath(target)}/.git"]\n path = ${JSON.stringify(conditional)}\n`,
    );
    // Git 2.25 reads XDG global config but predates GIT_CONFIG_GLOBAL.
    const profile = join(root, 'profile');
    await mkdir(join(profile, 'git'), { recursive: true });
    await writeFile(join(profile, 'git', 'config'), await readFile(global));
    process.env.XDG_CONFIG_HOME = profile;
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_PARAMETERS =
      "'core.preloadIndex=true' 'core.worktree=/foreign'";
    const client = worktreeSimpleGit(target);
    for (const [key, value] of [
      ['core.untrackedCache', 'true'],
      ['core.fsmonitor', '/custom/fsmonitor'],
      ['credential.helper', '!custom-auth-helper'],
      ['core.preloadIndex', 'true'],
      ['test.conditional', 'selected-repository'],
    ])
      expect({
        key,
        value: (await client.raw(['config', '--get', key])).trim(),
      }).toEqual({ key, value });
    await git(target, 'config', 'core.untrackedCache', 'false');
    expect(
      (await client.raw(['config', '--get', 'core.untrackedCache'])).trim(),
    ).toBe('false');
    expect((await client.raw(['rev-parse', '--show-toplevel'])).trim()).toBe(
      target,
    );
  });

  it('honors per-worktree configuration without inheriting another checkout', async () => {
    await git(target, 'config', 'extensions.worktreeConfig', 'true');
    const linked = join(root, 'linked');
    await git(target, 'worktree', 'add', '-b', 'linked', linked);
    await git(linked, 'config', '--worktree', 'core.preloadIndex', 'false');
    await git(target, 'config', '--worktree', 'core.preloadIndex', 'true');
    expect(
      (
        await worktreeSimpleGit(linked).raw([
          'config',
          '--get',
          'core.preloadIndex',
        ])
      ).trim(),
    ).toBe('false');
    expect(
      (
        await worktreeSimpleGit(target).raw([
          'config',
          '--get',
          'core.preloadIndex',
        ])
      ).trim(),
    ).toBe('true');
  });

  it('reads shared alternate objects without redirecting HEAD or index writes', async () => {
    const sha = await git(foreign, 'rev-parse', 'HEAD');
    const targetHead = await git(target, 'rev-parse', 'HEAD');
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(
      foreign,
      '.git',
      'objects',
    );
    expect(
      (await worktreeSimpleGit(target).raw(['cat-file', '-t', sha])).trim(),
    ).toBe('commit');
    expect((await worktreeSimpleGit(target).revparse(['HEAD'])).trim()).toBe(
      targetHead,
    );
    expect(await git(foreign, 'status', '--porcelain')).toBe('');
  });

  it('preserves authentication, global settings and the original environment object', () => {
    const env = {
      GIT_DIR: '/other',
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_CONFIG_GLOBAL: '/config',
      PATH: '/bin',
    };
    expect(isolateGitEnvironment(env)).toEqual({
      GIT_SSH_COMMAND: env.GIT_SSH_COMMAND,
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      PATH: env.PATH,
    });
    expect(env.GIT_DIR).toBe('/other');
  });

  it('handles case-insensitive environment names on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', {
        ...platform,
        value: 'win32',
      });
      expect(
        isolateGitEnvironment({
          Git_Dir: 'C:\\other',
          git_config_count: '1',
          Git_Config_Key_0: 'core.worktree',
          Git_Config_Value_0: 'C:\\other',
          Path: 'C:\\bin',
        }),
      ).toEqual({ Path: 'C:\\bin' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import * as processRunner from '../terminal/async-process.js';
import {
  cloneRepositoryName,
  prepareProjectRepositories,
} from './desktop-project-repositories.js';
import { listWorkspaceFolders } from './desktop-workspace-folders.js';

jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  homedir: jest.fn(),
}));

describe('Desktop project repository setup', () => {
  let root: string;
  const signal = () => new AbortController().signal;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'desktop-project-'));
    jest.mocked(homedir).mockReturnValue(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    'https://github.com/team/api.git',
    'ssh://git@example.com/team/api.git',
    'git@example.com:team/api.git',
  ])('accepts a network Git URL: %s', (url) => {
    expect(cloneRepositoryName(url)).toBe('api');
  });
  it.each([
    'file:///tmp/api',
    'ext::sh payload',
    '-u',
    'https://user:secret@example.com/api',
    'https://example.com/..',
    'https://example.com/api?token=secret',
    'http://example.com/api',
  ])('rejects local, executable and credential-bearing URLs: %s', (url) => {
    expect(cloneRepositoryName(url)).toBeNull();
  });
  it('suggests a completed folder without descending until a trailing slash is supplied', async () => {
    await mkdir(join(root, 'child', 'nested'), { recursive: true });
    const folders = await listWorkspaceFolders(
      join(root, 'child'),
      50,
      signal(),
    );
    expect(folders).toEqual([
      { path: join(root, 'child'), name: 'child', git: null, dir: true },
    ]);
    expect(
      await listWorkspaceFolders(join(root, 'child') + '/', 50, signal()),
    ).toEqual([
      {
        path: join(root, 'child', 'nested'),
        name: 'nested',
        git: null,
        dir: true,
      },
    ]);
    expect(await listWorkspaceFolders(join(root, 'chi'), 1, signal())).toEqual([
      { path: join(root, 'child'), name: 'child', git: null, dir: true },
    ]);
  });
  it('reads only the current branch metadata, including linked workspaces', async () => {
    await mkdir(join(root, 'metadata'));
    await writeFile(
      join(root, 'metadata', 'HEAD'),
      'ref: refs/heads/feature/project\n',
    );
    await mkdir(join(root, 'linked'));
    await writeFile(join(root, 'linked', '.git'), 'gitdir: ../metadata\n');
    expect(
      (await listWorkspaceFolders(join(root, 'linked'), 5, signal()))[0],
    ).toMatchObject({ git: 'feature/project' });
  });
  it('resolves a Git URL without filesystem traversal and rejects malformed URLs', async () => {
    expect(
      await listWorkspaceFolders('git@example.com:team/api.git', 5, signal()),
    ).toEqual([
      {
        path: join(root, 'code', 'api'),
        name: 'api',
        git: null,
        dir: false,
        clone: 'git@example.com:team/api.git',
      },
    ]);
    await expect(
      listWorkspaceFolders('https://example.com', 5, signal()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('initializes only an explicitly selected plain folder and leaves its files uncommitted', async () => {
    await writeFile(join(root, 'work.txt'), 'Keep my work');
    await expect(
      prepareProjectRepositories([{ path: root }], signal()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      await prepareProjectRepositories(
        [{ path: root, initialize: true }],
        signal(),
      ),
    ).toEqual([await realpath(root)]);
    expect(await readFile(join(root, 'work.txt'), 'utf8')).toBe('Keep my work');
    const status = await processRunner.execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd: root },
    );
    expect(status.stdout).toContain('?? work.txt');
    const head = await processRunner.execFileAsync(
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      { cwd: root },
    );
    expect(head.stdout.trim()).toMatch(/^[a-f0-9]{40,64}$/);
  });
  it('validates all paths and canonical duplicates before initializing anything', async () => {
    await expect(
      prepareProjectRepositories(
        [{ path: root, initialize: true }, { path: join(root, 'missing') }],
        signal(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      prepareProjectRepositories(
        [
          { path: root, initialize: true },
          { path: root + '/', initialize: true },
        ],
        signal(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await readdir(root)).not.toContain('.git');
  });
  it('confines clone destinations and never overwrites an existing folder', async () => {
    const clone = 'https://example.com/team/api.git';
    await expect(
      prepareProjectRepositories(
        [{ path: join(root, 'arbitrary'), clone }],
        signal(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await mkdir(join(root, 'code', 'api'), { recursive: true });
    await writeFile(join(root, 'code', 'api', 'keep'), 'keep');
    await expect(
      prepareProjectRepositories(
        [{ path: join(root, 'code', 'api'), clone }],
        signal(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await readFile(join(root, 'code', 'api', 'keep'), 'utf8')).toBe(
      'keep',
    );
  });
  it('runs clone with explicit arguments, disabled prompts and request cancellation, cleaning its failed destination', async () => {
    const run = jest
      .spyOn(processRunner, 'execFileAsync')
      .mockRejectedValue(new Error('private credentials'));
    const controller = new AbortController();
    const path = join(root, 'code', 'api');
    await expect(
      prepareProjectRepositories(
        [{ path, clone: 'https://example.com/api.git' }],
        controller.signal,
      ),
    ).rejects.toThrow('Check Git access');
    expect(run).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'clone',
        '--quiet',
        '--',
        'https://example.com/api.git',
        path,
      ]),
      expect.objectContaining({
        cwd: join(root, 'code'),
        signal: controller.signal,
        timeout: 120_000,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
      }),
    );
    expect(await readdir(join(root, 'code'))).toEqual([]);
    controller.abort();
    await expect(
      prepareProjectRepositories(
        [{ path: root, initialize: true }],
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(root)).not.toContain('.git');
  });
});

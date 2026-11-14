import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import {
  clearLocalRefState,
  readGitDirectoryHead,
  readLocalRefSnapshot,
  readOriginHead,
  readRepositoryIdentity,
} from './git-local-state.js';

// Run explicitly in the modern-Git validation job; a legacy Git cannot create
// this storage format, and must not receive a passing mocked substitute.
const modern =
  process.env.ELEVENEX_TEST_MODERN_GIT === '1' ? describe : describe.skip;

modern('native reftable snapshots with real Git', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'elevenex-reftable-')));
    const git = worktreeSimpleGit(root);
    await git.raw(['init', '--ref-format=reftable', '--initial-branch=main']);
    await git.addConfig('user.name', 'Reftable tests');
    await git.addConfig('user.email', 'refs@example.test');
    await git.addConfig('commit.gpgsign', 'false');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    clearLocalRefState();
    await rm(root, { recursive: true, force: true });
  });

  it('shares native metadata reads, observes same-commit branch changes and does not retain fetched refs', async () => {
    const git = worktreeSimpleGit(root);
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const raw = jest.spyOn(git, 'raw');
    const snapshots = await Promise.all(
      Array.from({ length: 20 }, () => readLocalRefSnapshot(git, root)),
    );
    expect(snapshots[0]).toMatchObject({ branch: 'main', headSha: head });
    expect(raw).toHaveBeenCalledTimes(2); // one discovery + one native HEAD read
    await readLocalRefSnapshot(git, root);
    expect(raw).toHaveBeenCalledTimes(2);
    await git.raw(['checkout', '-b', 'same-commit']);
    const next = await readLocalRefSnapshot(git, root);
    expect(next).toMatchObject({ branch: 'same-commit', headSha: head });
    await git.raw(['update-ref', 'refs/remotes/origin/main', head]);
    await git.raw([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    expect(await readOriginHead(next)).toBe('origin/main');
    raw.mockClear();
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () => next.resolveRef('origin/main')),
      ),
    ).toEqual(Array.from({ length: 20 }, () => head));
    expect(raw).toHaveBeenCalledTimes(1);
    await writeFile(join(root, 'new.txt'), 'new\n');
    await git.add('.');
    await git.raw(['commit', '-m', 'Next']);
    const second = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await git.raw(['update-ref', 'refs/remotes/origin/main', second]);
    expect(await next.resolveRef('origin/main')).toBe(second);
    expect(await readLocalRefSnapshot(git, root)).toMatchObject({
      branch: 'same-commit',
      headSha: second,
    });
    expect(await readGitDirectoryHead(root)).toBe(second);
    expect(await next.resolveRef('origin/missing')).toBeNull();
  });

  it('reads linked-worktree and detached HEAD state from its own ref stack', async () => {
    const git = worktreeSimpleGit(root);
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const linked = join(root, 'linked');
    await git.raw(['worktree', 'add', '-b', 'linked', linked]);
    const linkedGit = worktreeSimpleGit(linked);
    expect(await readLocalRefSnapshot(linkedGit, linked)).toMatchObject({
      branch: 'linked',
      headSha: head,
    });
    await linkedGit.raw(['checkout', '--detach']);
    expect(await readLocalRefSnapshot(linkedGit, linked)).toMatchObject({
      branch: 'HEAD',
      headSha: head,
    });
    expect(await readGitDirectoryHead(linked)).toBe(head);
    expect(await readLocalRefSnapshot(git, root)).toMatchObject({
      branch: 'main',
      headSha: head,
    });
  });

  it('preserves an unborn branch and observes its first commit', async () => {
    const git = worktreeSimpleGit(root);
    expect(await readLocalRefSnapshot(git, root)).toMatchObject({
      branch: 'main',
      headSha: null,
    });
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    expect(await readLocalRefSnapshot(git, root)).toMatchObject({
      branch: 'main',
      headSha: head,
    });
  });

  it('keeps a fixed verification deadline and clears native state on worktree cache release', async () => {
    const git = worktreeSimpleGit(root);
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    const raw = jest.spyOn(git, 'raw');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await readLocalRefSnapshot(git, root);
    expect(raw).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(2_000);
    await readLocalRefSnapshot(git, root);
    expect(raw).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(2_500);
    await readLocalRefSnapshot(git, root);
    expect(raw).toHaveBeenCalledTimes(3);
    clearLocalRefState(root);
    await readLocalRefSnapshot(git, root);
    expect(raw).toHaveBeenCalledTimes(5);
  });

  it('evicts failed native reads so the next request can recover', async () => {
    const git = worktreeSimpleGit(root);
    await git.raw(['commit', '--allow-empty', '-m', 'Initial']);
    await readRepositoryIdentity(git, root);
    jest
      .spyOn(git, 'raw')
      .mockRejectedValueOnce(new Error('Temporary ref read failure'));
    await expect(readLocalRefSnapshot(git, root)).rejects.toThrow(
      'Temporary ref read failure',
    );
    expect(await readLocalRefSnapshot(git, root)).toMatchObject({
      branch: 'main',
    });
  });
});

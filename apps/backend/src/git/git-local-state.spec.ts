import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeSimpleGit } from '../config/system-paths.js';
import {
  clearLocalRefState,
  readLocalRefSnapshot,
  readOriginHead,
} from './git-local-state.js';

const exec = promisify(execFile);
describe('local ref snapshots', () => {
  let repo: string;
  const git = async (...args: string[]) =>
    (await exec('git', args, { cwd: repo })).stdout.trim();
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'local-refs-'));
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(repo, 'file'), 'one\n');
    await git('add', '.');
    await git('commit', '-m', 'initial');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    clearLocalRefState();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('avoids warm Git discovery, shares common refs and observes packed/fetched refs and same-SHA branch switches', async () => {
    const client = worktreeSimpleGit(repo);
    const raw = jest.spyOn(client, 'raw'),
      verify = jest.spyOn(client, 'revparse');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = await readLocalRefSnapshot(client, repo);
    const again = await readLocalRefSnapshot(client, repo);
    expect(again.headSha).toBe(first.headSha);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    );
    await git('pack-refs', '--all', '--prune');
    expect(await again.resolveRef('origin/main')).toBe(first.headSha);
    expect(await readOriginHead(again)).toBe('origin/main');
    await git('checkout', '-b', 'same-sha');
    expect((await readLocalRefSnapshot(client, repo)).branch).toBe('same-sha');
    await fs.writeFile(path.join(repo, 'file'), 'two\n');
    await git('commit', '-am', 'next');
    const next = await readLocalRefSnapshot(client, repo);
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(await next.resolveRef('origin/main')).toBe(next.headSha);
    await git('checkout', '-b', 'branch\u00a0name');
    await git('pack-refs', '--all', '--prune');
    await readLocalRefSnapshot(client, repo);
    const verified = verify.mock.calls.length;
    expect((await readLocalRefSnapshot(client, repo)).branch).toBe(
      'branch\u00a0name',
    );
    expect(verify).toHaveBeenCalledTimes(verified);
    expect(next.headSha).not.toBe(first.headSha);
    await git('pack-refs', '--all', '--prune');
    expect(await next.resolveRef('origin/main')).toBe(next.headSha);
    const worktree = path.join(repo, 'linked');
    await git('worktree', 'add', '-b', 'linked', worktree);
    const linked = await readLocalRefSnapshot(
      worktreeSimpleGit(worktree),
      worktree,
    );
    expect(linked.commonDir).toBe(first.commonDir);
    expect(linked.gitDir).not.toBe(first.gitDir);
    expect(linked.branch).toBe('linked');
    const count = verify.mock.calls.length;
    clock.mockReturnValue(2_500);
    await readLocalRefSnapshot(client, repo);
    expect(verify).toHaveBeenCalledTimes(count + 1);
  });
});

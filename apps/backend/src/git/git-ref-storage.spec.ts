import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { worktreeSimpleGit } from '../config/system-paths.js';
import {
  clearLocalRefState,
  readGitDirectoryHead,
  readLocalRefSnapshot,
  readOriginHead,
} from './git-local-state.js';

const execute = promisify(execFile);
// Probe the installed Git's capabilities, including vendor builds. Unsupported
// storage formats are explicitly skipped on the oldest supported Git.
const help = spawnSync('git', ['init', '-h'], { encoding: 'utf8' });
if (help.error) throw help.error;
const options = help.stdout + help.stderr;
const formats = [
  { name: 'files / SHA-1', args: [], supported: true },
  {
    name: 'files / SHA-256',
    args: ['--object-format=sha256'],
    supported: options.includes('--object-format'),
  },
  {
    name: 'reftable',
    args: ['--ref-format=reftable'],
    supported: options.includes('--ref-format'),
  },
];

for (const format of formats) {
  (format.supported ? describe : describe.skip)(format.name, () => {
    let repo: string;
    const git = async (...args: string[]) =>
      (await execute('git', args, { cwd: repo })).stdout.trim();
    const snapshot = (cwd = repo) =>
      readLocalRefSnapshot(worktreeSimpleGit(cwd), cwd);
    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'elevenex-ref-storage-'));
      await git('init', ...format.args);
      await git('symbolic-ref', 'HEAD', 'refs/heads/main');
      await git('config', 'user.name', 'Fixture');
      await git('config', 'user.email', 'fixture@example.test');
      await git('config', 'commit.gpgsign', 'false');
    });
    afterEach(async () => {
      clearLocalRefState();
      await rm(repo, { recursive: true, force: true });
    });

    it('reads unborn and detached HEADs through the repository storage format', async () => {
      expect(await snapshot()).toMatchObject({ branch: 'main', headSha: null });
      await git('commit', '--allow-empty', '-m', 'initial');
      const sha = await git('rev-parse', 'HEAD');
      await git('checkout', '--detach');
      expect(await snapshot()).toMatchObject({ branch: 'HEAD', headSha: sha });
      expect(await readGitDirectoryHead(repo)).toBe(sha);
    });

    it('tracks same-SHA branch switches, remote symrefs and linked checkout commits', async () => {
      await writeFile(join(repo, 'file'), 'one\n');
      await git('add', '.');
      await git('commit', '-m', 'initial');
      const sha = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/main', sha);
      await git(
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      );
      await git('pack-refs', '--all');
      const first = await snapshot();
      expect(first).toMatchObject({ branch: 'main', headSha: sha });
      expect(await first.resolveRef('origin/main')).toBe(sha);
      expect(await readOriginHead(first)).toBe('origin/main');
      await git('checkout', '-b', 'same-sha');
      expect(await snapshot()).toMatchObject({
        branch: 'same-sha',
        headSha: sha,
      });
      const linked = join(repo, 'linked checkout');
      await git('worktree', 'add', '-b', 'linked', linked);
      expect(await snapshot(linked)).toMatchObject({
        branch: 'linked',
        headSha: sha,
      });
      await execute('git', ['commit', '--allow-empty', '-m', 'next'], {
        cwd: linked,
      });
      const next = (
        await execute('git', ['rev-parse', 'HEAD'], { cwd: linked })
      ).stdout.trim();
      expect(await readGitDirectoryHead(linked)).toBe(next);
      expect(await snapshot(linked)).toMatchObject({
        branch: 'linked',
        headSha: next,
      });
      expect((await snapshot()).headSha).toBe(sha);
    });
  });
}

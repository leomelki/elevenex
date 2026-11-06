import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodeAuthorization } from './code-authorization.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
const execute = promisify(execFile);
describe('new Code task/worktree authority', () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'code-authority-'))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('invalidates file authority after branch changes, task closure and checkout reassignment', async () => {
    const repository = join(root, 'repo'); await mkdir(repository); await execute('git', ['init', '-b', 'main', repository]);
    await writeFile(join(repository, 'file'), 'original'); await execute('git', ['-C', repository, 'add', '.']);
    await execute('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    const task = { id: 1, repoId: 1, path: repository, name: 'Task', createdAt: '2026-01-01', archivedAt: null as string | null, taskState: 'ready', linkStatus: 'linked', taskBranch: 'main', startingCommit: null, unlinkedAt: null };
    const authorization = new CodeAuthorization({ record: async () => task, repo: async () => ({ path: repository }) }, new TaskGitService());
    const first = await authorization.workspace(1);
    await execute('git', ['-C', repository, 'checkout', '-b', 'other']);
    await expect(authorization.assertCurrent(first)).rejects.toThrow('Task workspace changed');
    const switched = await authorization.workspace(1); expect(switched.storageIdentity).toBe(first.storageIdentity); expect(switched.identity).not.toBe(first.identity);
    task.archivedAt = 'now'; await expect(authorization.workspace(1)).rejects.toThrow('unavailable');
    task.archivedAt = null; task.taskState = 'released'; await expect(authorization.workspace(1)).rejects.toThrow('unavailable');
  });
  it('does not authorize a checkout root or parent replaced by a symlink', async () => {
    const physical = join(root, 'physical'); await mkdir(physical);
    const task = { id: 1, repoId: 1, path: join(root, 'link'), name: 'Task', createdAt: '2026-01-01', archivedAt: null, taskState: 'ready', linkStatus: 'linked', taskBranch: 'main', startingCommit: null, unlinkedAt: null };
    const authorization = new CodeAuthorization({ record: async () => task, repo: async () => ({ path: physical }) }, new TaskGitService());
    await symlink(physical, task.path);
    await expect(authorization.workspace(1)).rejects.toThrow('symbolic link');
    task.path = join(root, 'link', 'child'); await mkdir(join(physical, 'child'));
    await expect(authorization.workspace(1)).rejects.toThrow('symbolic link');
  });
});

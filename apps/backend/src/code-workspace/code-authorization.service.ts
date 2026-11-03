import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskGitService } from '../tasks/task-git.service.js';
import { lstat, realpath } from 'node:fs/promises';
import { TasksService } from '../tasks/tasks.service.js';

interface CodeTaskAccess {
  record(id: number): Promise<Pick<Awaited<ReturnType<TasksService['record']>>, 'id' | 'repoId' | 'createdAt' | 'path' | 'archivedAt' | 'taskState' | 'linkStatus' | 'taskBranch' | 'startingCommit' | 'unlinkedAt' | 'name'>>;
  repo(id: number): Promise<{ readonly path: string }>;
}
export interface CodeWorkspace {
  readonly taskId: number;
  readonly identity: string;
  readonly storageIdentity: string;
  readonly root: string;
  readonly name: string;
  readonly branch: string;
}
/** Re-resolves authoritative task ownership on every operation, never saved paths. */
@Injectable()
export class CodeAuthorization implements OnModuleDestroy {
  private readonly lifetime = new AbortController();
  onModuleDestroy(): void { this.lifetime.abort(); this.branches.clear(); }
  private readonly branches = new Map<string, { readonly value: Promise<string>; readonly at: number; pending: boolean }>();
  private probes = 0;
  constructor(@Inject(TasksService) private readonly tasks: CodeTaskAccess, @Inject(TaskGitService) private readonly git: Pick<TaskGitService, 'exclusive' | 'repositoryKey'>) {}
  async mutate<T>(taskId: number, operation: () => Promise<T>): Promise<T> {
    const task = await this.tasks.record(taskId), repo = await this.tasks.repo(task.repoId);
    return this.git.exclusive(await this.git.repositoryKey(repo.path), operation);
  }
  private branch(root: string, force: boolean): Promise<string> {
    const cached = this.branches.get(root);
    if (!force && cached && (cached.pending || Date.now() - cached.at < 1000)) return cached.value;
    if (this.branches.size >= 16 && !cached) this.branches.delete(this.branches.keys().next().value!);
    if (this.probes >= 16) throw new ServiceUnavailableException('Workspace checks are busy. Try again.');
    this.probes++;
    const value = promisify(execFile)('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, signal: this.lifetime.signal, timeout: 2000, maxBuffer: 4096, env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }).then(result => result.stdout.trim(), error => { if (error.code === 1) return '(detached)'; throw error; });
    const entry = { value, at: Date.now(), pending: true };
    entry.value = value.finally(() => { this.probes--; entry.pending = false; });
    this.branches.set(root, entry); return entry.value;
  }
  async workspace(taskId: number, expected?: string, verifyBranch = false, expectedStorage?: string): Promise<CodeWorkspace> {
    if (!Number.isSafeInteger(taskId) || taskId < 1) throw new BadRequestException('Invalid task.');
    const task = await this.tasks.record(taskId);
    const storageIdentity = createHash('sha256').update(JSON.stringify([task.id, task.repoId, task.createdAt])).digest('hex');
    if (expectedStorage !== undefined && expectedStorage !== storageIdentity) throw new ConflictException({ code: 'workspace-changed', message: 'Task identity changed. Reopen it from the task list.' });
    if (task.archivedAt || task.taskState !== 'ready' || task.linkStatus !== 'linked') throw new ConflictException({ code: 'workspace-unavailable', message: 'Task workspace is unavailable.' });
    if (!isAbsolute(task.path) || task.path.length > 4096) throw new ConflictException({ code: 'workspace-unavailable', message: 'Task checkout is not a physical workspace.' });
    const requested = resolve(task.path), root = await realpath(requested);
    if (root !== requested) {
      const filesystemRoot = parse(requested).root;
      let cursor = filesystemRoot;
      for (const part of relative(filesystemRoot, requested).split(sep)) {
        cursor = join(cursor, part);
        const info = await lstat(cursor);
        // macOS /var and /tmp are OS-owned root aliases. User-owned links,
        // including a replaced checkout root, cannot broaden task authority.
        if (info.isSymbolicLink() && !(process.platform !== 'win32' && cursor !== requested && dirname(cursor) === filesystemRoot && info.uid === 0)) throw new ConflictException({ code: 'workspace-unavailable', message: 'Task checkout contains a symbolic link. Select a physical worktree.' });
      }
    }
    const info = await lstat(root);
    if (!info.isDirectory()) throw new ConflictException({ code: 'workspace-unavailable', message: 'Task workspace is unavailable.' });
    const branch = await this.branch(root, verifyBranch);
    const identity = createHash('sha256').update(JSON.stringify([task.id, task.createdAt, root, info.dev, info.ino, info.birthtimeMs, task.taskBranch, task.startingCommit, task.unlinkedAt, branch])).digest('hex');
    if (expected !== undefined && identity !== expected) throw new ConflictException({ code: 'workspace-changed', message: 'Task workspace changed. Reopen Code to reconcile your files.' });
    return { taskId, identity, storageIdentity, root, name: task.name.slice(0, 256), branch: branch.slice(0, 256) };
  }
  async assertCurrent(workspace: CodeWorkspace): Promise<void> {
    await this.workspace(workspace.taskId, workspace.identity, true);
  }
}

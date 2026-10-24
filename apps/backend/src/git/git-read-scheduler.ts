import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { buildAugmentedEnv } from '../config/system-paths.js';

interface Waiting {
  key: string;
  priority: number;
  queuedAt: number;
  start: () => void;
}

export function gitAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : 'Git request aborted');
}

/** One budget across clients/tabs. Aging prevents background starvation. */
export class GitWorkScheduler {
  private active = 0;
  private readonly perRepository = new Map<string, number>();
  private readonly waiting: Waiting[] = [];
  peakActive = 0;
  peakRepositoryActive = 0;
  totalQueueMs = 0;
  completed = 0;
  constructor(
    readonly concurrency: number,
    readonly repositoryConcurrency: number,
  ) {}
  run<T>(
    key: string,
    operation: () => PromiseLike<T>,
    priority = 0,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(gitAbortError(signal));
    if (this.waiting.length >= 2_048)
      return Promise.reject(
        new Error('Git work queue is full; retry the request.'),
      );
    return new Promise<T>((resolve, reject) => {
      const item: Waiting = {
        key,
        priority,
        queuedAt: Date.now(),
        start: () => {
          signal?.removeEventListener('abort', abort);
          this.active++;
          this.peakActive = Math.max(this.peakActive, this.active);
          this.perRepository.set(key, (this.perRepository.get(key) ?? 0) + 1);
          this.peakRepositoryActive = Math.max(
            this.peakRepositoryActive,
            this.perRepository.get(key)!,
          );
          this.totalQueueMs += Date.now() - item.queuedAt;
          void Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              this.completed++;
              this.active--;
              const remaining = this.perRepository.get(key)! - 1;
              if (remaining) this.perRepository.set(key, remaining);
              else this.perRepository.delete(key);
              this.drain();
            });
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          if (signal) reject(gitAbortError(signal));
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(item);
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.concurrency) {
      let candidate = -1,
        score = -Infinity;
      for (let index = 0; index < this.waiting.length; index++) {
        const item = this.waiting[index];
        if (
          (this.perRepository.get(item.key) ?? 0) >= this.repositoryConcurrency
        )
          continue;
        const priority = item.priority + (Date.now() - item.queuedAt) / 250;
        if (priority > score) {
          candidate = index;
          score = priority;
        }
      }
      if (candidate < 0) return;
      this.waiting.splice(candidate, 1)[0].start();
    }
  }
  diagnostics() {
    return {
      active: this.active,
      pending: this.waiting.length,
      peakActive: this.peakActive,
      peakRepositoryActive: this.peakRepositoryActive,
      totalQueueMs: this.totalQueueMs,
      completed: this.completed,
    };
  }
}

export const gitReadScheduler = new GitWorkScheduler(8, 4);
export const gitFileScheduler = new GitWorkScheduler(32, 16);
export const gitHashScheduler = new GitWorkScheduler(4, 2);
// Rendering can yield with rows retained; bound those in-flight allocations
// separately from the content I/O that each render needs to await.
export const gitRenderScheduler = new GitWorkScheduler(8, 4);

/** Cancel one waiter while shared cache builds retain their own bounded lifetime. */
export function consumeSharedGitWork<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(gitAbortError(signal));
    };
    if (signal.aborted) {
      abort();
      void pending.catch(() => undefined);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
const repositoryKeys = new Map<string, string>();
export function registerGitRepository(
  worktreePath: string,
  commonDir: string,
): void {
  const key = path.resolve(worktreePath);
  repositoryKeys.delete(key);
  repositoryKeys.set(key, commonDir);
  if (repositoryKeys.size > 1_000)
    for (const oldest of repositoryKeys.keys()) {
      repositoryKeys.delete(oldest);
      break;
    }
}
export function gitRepositoryKey(worktreePath: string): string {
  const normalized = path.resolve(worktreePath);
  for (let current = normalized; ; current = path.dirname(current)) {
    const key = repositoryKeys.get(current);
    if (key) return key;
    if (path.dirname(current) === current) return normalized;
  }
}

export function scheduledGitRaw(
  worktreePath: string,
  args: string[],
  priority = 0,
  overrides: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<string> {
  if (input && Buffer.byteLength(input) > 16 * 1024 * 1024)
    return Promise.reject(new Error('Git input exceeds the byte limit.'));
  return gitReadScheduler.run(
    gitRepositoryKey(worktreePath),
    () =>
      new Promise<string>((resolve, reject) => {
        const env = {
          ...buildAugmentedEnv(process.env, worktreePath),
          ...overrides,
        };
        delete env.GIT_PAGER;
        delete env.PAGER;
        env.GIT_OPTIONAL_LOCKS = '0';
        env.GIT_NO_LAZY_FETCH = '1';
        const child = execFile(
          'git',
          ['--literal-pathspecs', '-c', 'diff.ignoreSubmodules=dirty', ...args],
          {
            cwd: worktreePath,
            env,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout) =>
            error
              ? reject(
                  error instanceof Error ? error : new Error('Git read failed'),
                )
              : resolve(stdout),
        );
        if (input !== undefined) {
          child.stdin?.on('error', () => undefined); // Git's completion callback reports failed input consumers.
          child.stdin?.end(input);
        }
      }),
    priority,
  );
}

/** Read-only facade: bound process time/output and share scheduling across clients. */
export function scheduledReadGit(
  git: SimpleGit,
  worktreePath: string,
  priority = 0,
  overrides: NodeJS.ProcessEnv = {},
): SimpleGit {
  return new Proxy(git, {
    get(target, property, receiver: unknown) {
      if (property === 'raw')
        return (args: string[]) =>
          scheduledGitRaw(worktreePath, args, priority, overrides);
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'revparse' || property === 'getRemotes')
        return (...args: unknown[]) =>
          gitReadScheduler.run(
            gitRepositoryKey(worktreePath),
            () => Reflect.apply(value, target, args) as PromiseLike<unknown>,
            priority,
          );
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result === target ? receiver : result;
      };
    },
  });
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  buildAugmentedEnv,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import { execFileAsync } from '../terminal/async-process.js';

export function taskBranchSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100)
      .replace(/-+$/g, '') || 'task'
  );
}

@Injectable()
export class TaskGitService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly fetches = new Map<string, Promise<void>>();

  async repositoryKey(repoPath: string): Promise<string> {
    const common = (
      await worktreeSimpleGit(repoPath).raw([
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ])
    ).trim();
    return fs.realpath(path.resolve(repoPath, common));
  }

  async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key);
    }
  }

  async validateBranch(repoPath: string, branch: string): Promise<void> {
    if (!branch.trim() || branch.startsWith('-') || branch.startsWith('@{')) {
      throw new BadRequestException('Enter a valid branch name.');
    }
    try {
      await worktreeSimpleGit(repoPath).raw([
        'check-ref-format',
        '--branch',
        branch,
      ]);
    } catch {
      throw new BadRequestException(`“${branch}” is not a valid branch name.`);
    }
  }

  async resolve(repoPath: string, ref: string): Promise<string> {
    try {
      return (
        await worktreeSimpleGit(repoPath).raw([
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${ref}^{commit}`,
        ])
      ).trim();
    } catch {
      throw new BadRequestException(
        `Could not find “${ref}”. Choose another branch or revision.`,
      );
    }
  }

  async hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.resolve(repoPath, `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  async remoteRef(
    repoPath: string,
    ref: string,
  ): Promise<{ remote: string; branch: string; ref: string } | null> {
    if (ref.startsWith('refs/heads/')) return null;
    const value = ref.replace(/^refs\/remotes\//, '');
    const remotes = await worktreeSimpleGit(repoPath).getRemotes();
    const remote = remotes
      .map((entry) => entry.name)
      .sort((a, b) => b.length - a.length)
      .find((name) => value.startsWith(`${name}/`));
    return remote
      ? {
          remote,
          branch: value.slice(remote.length + 1),
          ref: `refs/remotes/${value}`,
        }
      : null;
  }

  async refresh(
    repoPath: string,
    ref: string,
    useSavedRef = false,
  ): Promise<void> {
    const target = await this.remoteRef(repoPath, ref);
    if (!target || useSavedRef) return;
    const key = `${await this.repositoryKey(repoPath)}:${target.ref}`;
    let pending = this.fetches.get(key);
    if (!pending) {
      pending = execFileAsync(
        'git',
        [
          'fetch',
          '--no-tags',
          target.remote,
          `+refs/heads/${target.branch}:${target.ref}`,
        ],
        {
          cwd: repoPath,
          env: {
            ...buildAugmentedEnv(process.env, repoPath),
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
          },
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      ).then(() => undefined);
      this.fetches.set(key, pending);
    }
    try {
      await pending;
    } catch {
      let savedCommit: string | null = null;
      try {
        savedCommit = await this.resolve(repoPath, target.ref);
      } catch {
        /* No cached revision. */
      }
      throw new ConflictException({
        code: 'fetch_failed',
        message: `Could not refresh ${ref}.`,
        ref,
        savedCommit,
      });
    } finally {
      if (this.fetches.get(key) === pending) this.fetches.delete(key);
    }
  }

  async defaultBase(
    repoPath: string,
    preference?: string | null,
  ): Promise<string | null> {
    if (preference) {
      try {
        await this.resolve(repoPath, preference);
        return preference;
      } catch {
        /* Preference no longer exists. */
      }
    }
    const git = worktreeSimpleGit(repoPath);
    const remotes = (await git.getRemotes()).sort((a, b) =>
      a.name === 'origin'
        ? -1
        : b.name === 'origin'
          ? 1
          : a.name.localeCompare(b.name),
    );
    for (const { name } of remotes) {
      try {
        const ref = (
          await git.raw(['symbolic-ref', '-q', `refs/remotes/${name}/HEAD`])
        ).trim();
        await this.resolve(repoPath, ref);
        return ref;
      } catch {
        /* Some clones lack a remote HEAD symref. */
      }
      for (const branch of ['main', 'master']) {
        const ref = `refs/remotes/${name}/${branch}`;
        try {
          await this.resolve(repoPath, ref);
          return ref;
        } catch {
          /* Try next default. */
        }
      }
    }
    for (const branch of ['main', 'master'])
      if (await this.hasLocalBranch(repoPath, branch))
        return `refs/heads/${branch}`;
    return null;
  }

  async status(worktreePath: string): Promise<{
    dirty: boolean;
    conflicts: boolean;
    branch: string | null;
    head: string;
  }> {
    const git = worktreeSimpleGit(worktreePath);
    const [status, branch, head] = await Promise.all([
      git.raw(['status', '--porcelain=v1', '--untracked-files=normal']),
      git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      this.resolve(worktreePath, 'HEAD'),
    ]);
    return {
      dirty: status.trim().length > 0,
      conflicts: status
        .split('\n')
        .some((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line)),
      branch: branch.trim() || null,
      head,
    };
  }
}

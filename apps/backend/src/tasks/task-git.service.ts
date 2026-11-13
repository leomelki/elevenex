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
import { copyCacheString } from '../git/git-cache.js';

export interface WorktreeStatus {
  dirty: boolean;
  conflicts: boolean;
  branch: string | null;
  head: string;
}

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
    const [common, physicalPath] = await Promise.all([
      worktreeSimpleGit(repoPath).raw(['rev-parse', '--git-common-dir']),
      fs.realpath(repoPath),
    ]);
    // Git before 2.31 echoes the unsupported --path-format option as output.
    // Relative output uses the physical cwd, including through nested symlinks.
    return fs.realpath(path.resolve(physicalPath, common.trim()));
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

  async defaultBase(repoPath: string): Promise<string | null> {
    const git = worktreeSimpleGit(repoPath);
    // Only inspect candidate defaults, without reading every branch's subject
    // or launching a rev-parse process for each missing candidate.
    const [configuredRemotes, output] = await Promise.all([
      git.getRemotes(),
      git.raw([
        'for-each-ref',
        '--format=%(refname)%00%(symref)%00%(objecttype)',
        'refs/remotes/*/HEAD',
        'refs/remotes/*/main',
        'refs/remotes/*/master',
        'refs/heads/main',
        'refs/heads/master',
      ]),
    ]);
    const candidates = new Map(
      output.split('\n').flatMap((line) => {
        const [ref, target, type] = line.split('\0');
        return type === 'commit' ? [[ref, target] as const] : [];
      }),
    );
    const remotes = configuredRemotes.sort((a, b) =>
      a.name === 'origin'
        ? -1
        : b.name === 'origin'
          ? 1
          : a.name.localeCompare(b.name),
    );
    for (const { name } of remotes) {
      const target = candidates.get(`refs/remotes/${name}/HEAD`);
      if (target) return target;
      for (const branch of ['main', 'master']) {
        const ref = `refs/remotes/${name}/${branch}`;
        if (candidates.has(ref)) return ref;
      }
    }
    for (const branch of ['main', 'master'])
      if (candidates.has(`refs/heads/${branch}`)) return `refs/heads/${branch}`;
    return null;
  }

  /** A clean index can still belong to a paused rebase, bisect, or sequencer. */
  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    const gitDir = (
      await worktreeSimpleGit(worktreePath).raw([
        'rev-parse',
        '--absolute-git-dir',
      ])
    ).trim();
    const markers = [
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
    ];
    const present = await Promise.all(
      markers.map(async (marker) => {
        try {
          await fs.stat(path.join(gitDir, marker));
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return false;
          throw error;
        }
      }),
    );
    return present.some(Boolean);
  }

  /** Count the tracked paths a checkout from one commit to another rewrites.
   * Tree comparison reads no blobs, so it stays cheap even in large monorepos.
   */
  async changedPathCount(
    repoPath: string,
    from: string,
    to: string,
  ): Promise<number> {
    if (from === to) return 0;
    try {
      const output = await worktreeSimpleGit(repoPath).raw([
        'diff-tree',
        '-r',
        '-z',
        '--name-only',
        '--no-renames',
        from,
        to,
      ]);
      return output.split('\0').filter(Boolean).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * `persistIndex` is only for idle checkouts no task or process is using.
   * The backend disables optional index locks so its reads never race a
   * foreground write, but then Git cannot save refreshed stat data or the
   * untracked cache, and every status rescans the whole tree (seconds in
   * large repositories). Persisting once keeps later lock-free reads fast.
   */
  async status(
    worktreePath: string,
    options: { persistIndex?: boolean } = {},
  ): Promise<WorktreeStatus> {
    const git = worktreeSimpleGit(worktreePath);
    if (options.persistIndex) git.env('GIT_OPTIONAL_LOCKS', '1');
    const output = await git.raw([
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      // Task ownership needs dirty/conflict flags, not rename identities.
      '--no-renames',
      '-z',
      '--untracked-files=normal',
    ]);
    let branch: string | null = null;
    let head: string | undefined;
    let offset = 0;
    // Headers precede file records. Read only those small fields instead of
    // allocating one string per changed path in a very dirty repository.
    while (output.startsWith('# ', offset)) {
      const end = output.indexOf('\0', offset);
      if (end === -1) throw new Error('Incomplete task status headers.');
      const record = output.slice(offset, end);
      if (record.startsWith('# branch.head ')) {
        const value = record.slice('# branch.head '.length);
        branch = value === '(detached)' ? null : copyCacheString(value);
      } else if (record.startsWith('# branch.oid ')) {
        head = copyCacheString(record.slice('# branch.oid '.length));
      }
      offset = end + 1;
    }
    if (!head || !/^[a-f0-9]{40,64}$/.test(head))
      throw new BadRequestException(
        'Could not find “HEAD”. Choose another branch or revision.',
      );
    const firstRecord = output.slice(offset, offset + 2);
    // With --no-renames every pathname stays inside its prefixed record, so
    // looking for a NUL-delimited unmerged prefix cannot match filename text.
    if (offset < output.length && !/^[1u?] $/.test(firstRecord))
      throw new Error('Unknown task status record.');
    return {
      dirty: offset < output.length,
      conflicts: firstRecord === 'u ' || output.includes('\0u ', offset),
      branch,
      head,
    };
  }
}

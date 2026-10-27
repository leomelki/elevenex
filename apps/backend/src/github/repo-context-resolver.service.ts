import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { readCurrentBranch } from '../git/git-head.js';

export interface RepoContext {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remoteName: string | null;
  host: string | null;
  owner: string | null;
  repo: string | null;
}

@Injectable()
export class RepoContextResolverService {
  private readonly inFlight = new Map<string, Promise<RepoContext>>();

  resolve(worktreePath: string): Promise<RepoContext> {
    worktreePath = path.resolve(worktreePath);
    const existing = this.inFlight.get(worktreePath);
    if (existing) return existing;
    const pending = this.readContext(worktreePath).finally(() => {
      if (this.inFlight.get(worktreePath) === pending) {
        this.inFlight.delete(worktreePath);
      }
    });
    this.inFlight.set(worktreePath, pending);
    return pending;
  }

  private async readContext(worktreePath: string): Promise<RepoContext> {
    const git = worktreeSimpleGit(worktreePath);
    const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
    const branch = await readCurrentBranch(git);

    if (!branch) {
      throw new Error('Detached HEAD is not supported for GitHub cockpit.');
    }
    const headSha = await git
      .revparse(['HEAD'])
      .then((value) => value.trim())
      .catch(() => null);

    let upstream: string | null = null;
    try {
      upstream = (
        await git.raw([
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{u}',
        ])
      ).trim();
    } catch {
      upstream = null;
    }

    let ahead = 0;
    let behind = 0;
    if (upstream) {
      try {
        const counts = (
          await git.raw([
            'rev-list',
            '--left-right',
            '--count',
            `${branch}...${upstream}`,
          ])
        ).trim();
        const [aheadCount, behindCount] = counts.split(/\s+/);
        ahead = Number(aheadCount) || 0;
        behind = Number(behindCount) || 0;
      } catch {
        ahead = 0;
        behind = 0;
      }
    }

    const remotes = await git.getRemotes(true);
    const remoteName =
      upstream?.split('/')[0] ||
      remotes.find((remote) => remote.name === 'origin')?.name ||
      remotes[0]?.name ||
      null;
    const remoteUrl = remoteName
      ? remotes.find((remote) => remote.name === remoteName)?.refs.fetch ||
        remotes.find((remote) => remote.name === remoteName)?.refs.push ||
        null
      : null;
    const parsedRemote = remoteUrl ? this.parseGitHubRemote(remoteUrl) : null;

    return {
      repoRoot,
      worktreePath,
      branch,
      headSha,
      upstream,
      ahead,
      behind,
      remoteName,
      host: parsedRemote?.host ?? null,
      owner: parsedRemote?.owner ?? null,
      repo: parsedRemote?.repo ?? null,
    };
  }

  parseGitHubRemote(
    remoteUrl: string,
  ): { host: string; owner: string; repo: string } | null {
    const trimmed = remoteUrl.trim();
    const patterns = [
      /^git@(?<host>[^:]+):(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/,
      /^ssh:\/\/git@(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/,
      /^https:\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/,
    ];

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (!match?.groups) {
        continue;
      }

      return {
        host: match.groups['host'],
        owner: match.groups['owner'],
        repo: match.groups['repo'],
      };
    }

    return null;
  }
}

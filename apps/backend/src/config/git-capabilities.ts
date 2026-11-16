import * as path from 'node:path';
import simpleGit from 'simple-git';
import { buildAugmentedEnv } from './system-paths.js';

export interface GitCapabilities {
  readonly initialBranch: boolean;
  readonly worktreeListNull: boolean;
}

type VersionProbe = (cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
const CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 64;

/** Detect only features with different command forms; never probe on status reads. */
export class GitCapabilitiesCache {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<GitCapabilities> }
  >();

  constructor(
    private readonly probe: VersionProbe = (cwd, env) =>
      simpleGit(cwd, {
        timeout: { block: 5_000, stdOut: false, stdErr: false },
      })
        .env(env)
        .raw(['--version']),
  ) {}

  get(cwd: string, env: NodeJS.ProcessEnv): Promise<GitCapabilities> {
    const searchPath = env.PATH ?? env.Path ?? '';
    // Relative PATH entries (including an empty entry) resolve from cwd.
    // Absolute PATHs can share the probe across all linked worktrees.
    const relativePath = searchPath
      .split(path.delimiter)
      .some((entry) => !path.isAbsolute(entry));
    const key = JSON.stringify([
      searchPath,
      env.PATHEXT,
      env.GIT_EXEC_PATH,
      relativePath ? path.resolve(cwd) : '',
    ]);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    const value = this.probe(cwd, env)
      .then((output) => {
        const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(output);
        const supports = (minor: number) =>
          !!match &&
          (Number(match[1]) > 2 ||
            (Number(match[1]) === 2 && Number(match[2]) >= minor));
        return { initialBranch: supports(28), worktreeListNull: supports(36) };
      })
      .catch((error: unknown) => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { expiresAt: Date.now() + CACHE_MS, value });
    while (this.entries.size > MAX_ENTRIES) {
      for (const oldest of this.entries.keys()) {
        this.entries.delete(oldest);
        break;
      }
    }
    return value;
  }
}

const capabilities = new GitCapabilitiesCache();

export function readGitCapabilities(
  cwd: string,
  env = buildAugmentedEnv(process.env, cwd),
): Promise<GitCapabilities> {
  return capabilities.get(cwd, env);
}

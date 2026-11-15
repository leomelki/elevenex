import * as path from 'node:path';
import { GitByteLru, GitCacheBudget } from './git-cache.js';

// Match the shared Git scheduler's queue bound rather than reducing its
// capacity when many repositories or ref choices are requested together.
const MAX_PENDING_READS = 2_048;

interface Identity {
  gitDir: string;
  commonDir: string;
}
type ReadGit = (args: string[]) => PromiseLike<string>;
async function readOptional(
  read: ReadGit,
  args: string[],
): Promise<string | null> {
  try {
    return (await read(args)).trim() || null;
  } catch (error: unknown) {
    // Quiet ref lookup uses exit 1 for a missing ref. Operational errors must
    // remain retryable rather than becoming a cached "unborn HEAD" forever.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 1
    )
      return null;
    throw error;
  }
}
export interface ReftableHead {
  ref: string | null;
  sha: string | null;
  version: string;
}
interface CachedRef {
  value: string | null;
  verifiedAt: number;
}
interface Entry {
  version: string;
  head?: ReftableHead;
  headVerifiedAt?: number;
  refs: Map<string, CachedRef>;
}

/** Cache Git's answers, never decode its binary tables. The owning local-ref
 * cache clears this reader when a checkout is released or invalidated. */
export class ReftableRefCache {
  private readonly entries = new GitByteLru<Entry>(
    new GitCacheBudget(4 * 1024 * 1024),
  );
  private readonly heads = new Map<string, Promise<ReftableHead>>();
  private readonly refs = new Map<string, Promise<string | null>>();
  constructor(
    private readonly readVersion: (filePath: string) => Promise<string>,
    private readonly verifyAfterMs: number,
  ) {}

  private fresh(at: number | undefined): boolean {
    if (at === undefined) return false;
    const age = Date.now() - at;
    return age >= 0 && age < this.verifyAfterMs;
  }

  private async version(identity: Identity): Promise<string> {
    const directories =
      identity.gitDir === identity.commonDir
        ? [identity.gitDir]
        : [identity.gitDir, identity.commonDir];
    return (
      await Promise.all(
        directories.map((directory) =>
          this.readVersion(path.join(directory, 'reftable', 'tables.list')),
        ),
      )
    ).join('\0');
  }

  async head(identity: Identity, read: ReadGit): Promise<ReftableHead> {
    const key = identity.gitDir;
    const version = await this.version(identity);
    const cached = this.entries.get(key);
    if (
      cached?.version === version &&
      cached.head &&
      this.fresh(cached.headVerifiedAt)
    )
      return cached.head;
    const existing = this.heads.get(key);
    if (existing) return existing;
    if (this.heads.size >= MAX_PENDING_READS)
      throw new Error('Git ref reads are busy; retry.');
    const build = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = attempt === 0 ? version : await this.version(identity);
        const verifiedAt = Date.now();
        const [ref, sha] = await Promise.all([
          readOptional(read, ['symbolic-ref', '--quiet', 'HEAD']),
          readOptional(read, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        ]);
        if ((await this.version(identity)) !== before) continue;
        const head = { ref, sha, version: before };
        if (this.heads.get(key) === pending) {
          const current = this.entries.get(key);
          this.entries.set(key, {
            version: before,
            head,
            headVerifiedAt: verifiedAt,
            refs:
              current?.version === before
                ? current.refs
                : new Map<string, CachedRef>(),
          });
        }
        return head;
      }
      throw new Error('Repository refs changed repeatedly while reading HEAD');
    };
    const pending = build().finally(() => {
      if (this.heads.get(key) === pending) this.heads.delete(key);
    });
    this.heads.set(key, pending);
    return pending;
  }

  async resolve(
    identity: Identity,
    ref: string,
    symbolic: boolean,
    read: ReadGit,
  ): Promise<string | null> {
    const version = await this.version(identity);
    const key = identity.gitDir;
    const item = `${symbolic ? 'symbolic' : 'sha'}:${ref}`;
    const cached = this.entries.get(key);
    if (
      !symbolic &&
      ref === 'HEAD' &&
      cached?.version === version &&
      cached.head &&
      this.fresh(cached.headVerifiedAt)
    )
      return cached.head.sha;
    const cachedRef =
      cached?.version === version ? cached.refs.get(item) : undefined;
    if (cachedRef && this.fresh(cachedRef.verifiedAt)) return cachedRef.value;
    const request = `${key}\0${version}\0${item}`;
    const existing = this.refs.get(request);
    if (existing) return existing;
    if (this.refs.size >= MAX_PENDING_READS)
      throw new Error('Git ref reads are busy; retry.');
    const verifiedAt = Date.now();
    const pending = readOptional(
      read,
      symbolic
        ? ['symbolic-ref', '--quiet', ref]
        : ['rev-parse', '--verify', '--quiet', ref],
    )
      .then(async (value) => {
        if (
          this.refs.get(request) === pending &&
          (await this.version(identity)) === version
        ) {
          const current = this.entries.get(key);
          const refs = new Map(
            current?.version === version ? current.refs : [],
          );
          refs.delete(item);
          refs.set(item, { value, verifiedAt });
          while (refs.size > 32)
            for (const oldest of refs.keys()) {
              refs.delete(oldest);
              break;
            }
          this.entries.set(key, {
            version,
            head: current?.version === version ? current.head : undefined,
            headVerifiedAt:
              current?.version === version ? current.headVerifiedAt : undefined,
            refs,
          });
        }
        return value;
      })
      .finally(() => {
        if (this.refs.get(request) === pending) this.refs.delete(request);
      });
    this.refs.set(request, pending);
    return pending;
  }

  clear(worktreeGitDir?: string): void {
    if (!worktreeGitDir) {
      this.entries.clear();
      this.heads.clear();
      this.refs.clear();
      return;
    }
    this.entries.delete(worktreeGitDir);
    this.heads.delete(worktreeGitDir);
    for (const key of this.refs.keys())
      if (key.startsWith(worktreeGitDir + '\0')) this.refs.delete(key);
  }
}

import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { RepositoryIdentity } from './git-local-state.js';

interface ReftableState {
  readonly branch: string;
  readonly headSha: string | null;
  readonly resolveRef: (ref: string) => Promise<string | null>;
}

const MAX_ENTRIES = 1_000;
const VERIFY_MS = 1_500;
const states = new Map<
  string,
  {
    version: string;
    worktreePath: string;
    at: number;
    value: Promise<ReftableState>;
  }
>();

async function tableVersion(identity: RepositoryIdentity): Promise<string> {
  const directories = [...new Set([identity.commonDir, identity.gitDir])];
  return (
    await Promise.all(
      directories.map(async (directory) => {
        try {
          const value = await lstat(
            path.join(directory, 'reftable', 'tables.list'),
            { bigint: true },
          );
          return [
            value.dev,
            value.ino,
            value.size,
            value.mtimeNs,
            value.ctimeNs,
          ].join(':');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return 'missing';
          throw error;
        }
      }),
    )
  ).join('\0');
}

/** Let Git decode modern ref storage; HEAD on disk is only a compatibility stub. */
export async function readReftableState(
  git: SimpleGit,
  identity: RepositoryIdentity,
): Promise<ReftableState> {
  const key = identity.gitDir;
  const version = await tableVersion(identity);
  const cached = states.get(key);
  if (
    cached &&
    cached.version === version &&
    Date.now() - cached.at < VERIFY_MS
  ) {
    states.delete(key);
    states.set(key, cached);
    return cached.value;
  }
  const value = (async () => {
    let expectedVersion = version;
    for (let attempt = 0; attempt < 3; attempt++) {
      let branch: string;
      let headSha: string | null;
      try {
        // One metadata-only process returns the OID and full branch name.
        // It also works on reftable Git versions predating --include-root-refs.
        const output = await git.raw([
          'rev-parse',
          'HEAD',
          '--symbolic-full-name',
          'HEAD',
        ]);
        const [oid, ref] = output.trimEnd().split('\n');
        if (
          !/^[a-f0-9]{40,64}$/.test(oid) ||
          (ref !== 'HEAD' && !ref?.startsWith('refs/heads/'))
        )
          throw new Error('Cannot resolve reftable HEAD');
        headSha = oid;
        branch = ref === 'HEAD' ? 'HEAD' : ref.slice('refs/heads/'.length);
      } catch (error) {
        // An unborn branch has a name but no resolvable commit yet.
        const ref = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
        const oid = await git
          .raw(['rev-parse', '--verify', '--quiet', 'HEAD'])
          .catch(() => '');
        if (oid || !ref.startsWith('refs/heads/')) throw error;
        branch = ref.slice('refs/heads/'.length);
        headSha = null;
      }
      const currentVersion = await tableVersion(identity);
      if (currentVersion !== expectedVersion) {
        expectedVersion = currentVersion;
        continue;
      }
      // Share simultaneous lookups, but never retain a resolved remote ref:
      // fetch/update-ref may change it while consumers retain this snapshot.
      const references = new Map<string, Promise<string | null>>();
      return {
        branch,
        headSha,
        resolveRef: (ref: string) => {
          const existing = references.get(ref);
          if (existing) return existing;
          const pending = git
            .raw(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
            .then((output) =>
              /^[a-f0-9]{40,64}$/.test(output.trim()) ? output.trim() : null,
            )
            .catch(() => null)
            .finally(() => references.delete(ref));
          references.set(ref, pending);
          return pending;
        },
      };
    }
    throw new Error(
      'Repository refs changed repeatedly while reading reftable',
    );
  })().catch((error: unknown) => {
    if (states.get(key)?.value === value) states.delete(key);
    throw error;
  });
  states.set(key, {
    version,
    worktreePath: path.resolve(identity.repoRoot),
    at: Date.now(),
    value,
  });
  while (states.size > MAX_ENTRIES) {
    for (const oldest of states.keys()) {
      states.delete(oldest);
      break;
    }
  }
  return value;
}

export function clearReftableState(worktreePath?: string): void {
  if (!worktreePath) states.clear();
  else {
    const key = path.resolve(worktreePath);
    for (const [gitDir, entry] of states) {
      if (gitDir === key || entry.worktreePath === key) states.delete(gitDir);
    }
  }
}

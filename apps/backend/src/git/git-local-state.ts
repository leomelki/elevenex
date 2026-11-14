import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';
import {
  registerGitRepository,
  gitFileScheduler,
  gitRepositoryKey,
} from './git-read-scheduler.js';
import { GitByteLru, GitCacheBudget, copyCacheString } from './git-cache.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { clearReftableState, readReftableState } from './git-reftable-state.js';

const VERIFY_MS = 1_500;
const MAX_ENTRIES = 1_000;
const MAX_PACKED_REF_BYTES = 16 * 1024 * 1024;

export interface RepositoryIdentity {
  repoRoot: string;
  gitDir: string;
  commonDir: string;
}

export interface LocalRefSnapshot extends RepositoryIdentity {
  branch: string;
  headSha: string | null;
  indexVersion: string;
  resolveRef: (ref: string) => Promise<string | null>;
}

const identities = new Map<string, Promise<RepositoryIdentity>>();
const snapshots = new Map<string, Promise<LocalRefSnapshot>>();
const verifications = new Map<string, { at: number; version: string }>();
interface PackedRefs {
  version: string;
  refs: Promise<Map<string, string>>;
  values?: Map<string, string>;
}
const packed = new GitByteLru<PackedRefs>(new GitCacheBudget(16 * 1024 * 1024));
const pathVersions = new Map<string, Promise<string>>();

function retain<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES)
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      break;
    }
}

/** Includes inode/ctime and full timestamp precision to detect atomic/same-size writes. */
export function readPathVersion(filePath: string): Promise<string> {
  const existing = pathVersions.get(filePath);
  if (existing) return existing;
  const pending = gitFileScheduler
    .run(gitRepositoryKey(filePath), async () => {
      const value = await lstat(filePath, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
          throw error;
        },
      );
      if (value?.isDirectory()) {
        const head = await readGitDirectoryHead(filePath);
        if (head) return `gitlink:${head}`;
      }
      return value
        ? [
            value.dev,
            value.ino,
            value.mode,
            value.size,
            value.mtimeNs,
            value.ctimeNs,
          ].join(':')
        : 'missing';
    })
    .finally(() => {
      if (pathVersions.get(filePath) === pending) pathVersions.delete(filePath);
    });
  pathVersions.set(filePath, pending);
  return pending;
}

export function readRepositoryIdentity(
  git: SimpleGit,
  worktreePath: string,
): Promise<RepositoryIdentity> {
  const key = path.resolve(worktreePath);
  const cached = identities.get(key);
  if (cached) {
    retain(identities, key, cached);
    return cached;
  }
  const pending = Promise.all([
    git.raw(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']),
    realpath(key),
  ])
    .then(([output, physicalPath]) => {
      // Git before 2.31 lacks --path-format. These paths are absolute or
      // relative to the physical cwd, so normalize without another process.
      const [repoRoot, gitDir, commonDir] = output
        .trimEnd()
        .split('\n')
        .map((value) => (value ? path.resolve(physicalPath, value) : ''));
      if (!repoRoot || !gitDir || !commonDir)
        throw new Error('Cannot resolve repository identity');
      if (identities.get(key) === pending)
        registerGitRepository(key, commonDir);
      return { repoRoot, gitDir, commonDir };
    })
    .catch((error) => {
      if (identities.get(key) === pending) identities.delete(key);
      throw error;
    });
  retain(identities, key, pending);
  return pending;
}

async function readPackedRefs(commonDir: string): Promise<Map<string, string>> {
  const filePath = path.join(commonDir, 'packed-refs');
  const info = await stat(filePath).catch(() => null);
  const version = info
    ? [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
    : 'missing';
  const cached = packed.get(commonDir);
  if (cached?.version === version) return cached.refs;
  const refs = (async () => {
    const result = new Map<string, string>();
    if (!info || info.size > MAX_PACKED_REF_BYTES) return result;
    const text = await readFile(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^([a-f0-9]{40,64}) (refs\/[\s\S]+)$/.exec(line);
      if (match)
        result.set(copyCacheString(match[2]), copyCacheString(match[1]));
    }
    return result;
  })();
  const entry: PackedRefs = { version, refs };
  retain(packed, commonDir, entry);
  void refs.then(
    (values) => {
      if (packed.get(commonDir) === entry)
        packed.set(commonDir, { ...entry, values });
    },
    () => {
      if (packed.get(commonDir) === entry) packed.delete(commonDir);
    },
  );
  return refs;
}

async function readRef(
  identity: RepositoryIdentity,
  ref: string,
  depth = 0,
): Promise<string | null> {
  if (
    depth > 5 ||
    (ref !== 'HEAD' && !ref.startsWith('refs/')) ||
    [...ref].some(
      (char) =>
        char.charCodeAt(0) <= 32 ||
        char.charCodeAt(0) === 127 ||
        '~^:?*[\\'.includes(char),
    ) ||
    ref.includes('..')
  )
    return null;
  const dir =
    ref === 'HEAD' ||
    ref.startsWith('refs/worktree/') ||
    ref.startsWith('refs/bisect/')
      ? identity.gitDir
      : identity.commonDir;
  const value = (
    await readFile(path.join(dir, ref), 'utf8').catch(() => '')
  ).trim();
  if (value.startsWith('ref: '))
    return readRef(identity, value.slice(5), depth + 1);
  if (/^[a-f0-9]{40,64}$/.test(value)) return value;
  return (await readPackedRefs(identity.commonDir)).get(ref) ?? null;
}

/** Read only a nested repository's HEAD/refs, never its working files. */
export async function readGitDirectoryHead(
  worktreePath: string,
): Promise<string | null> {
  const marker = path.join(worktreePath, '.git');
  const info = await stat(marker).catch(() => null);
  if (!info) return null;
  const line = (text: string) =>
    text.endsWith('\n') ? text.slice(0, -1).replace(/\r$/, '') : text;
  const text = info.isFile() ? line(await readFile(marker, 'utf8')) : '';
  if (info.isFile() && !text.startsWith('gitdir: ')) return null;
  const gitDir = info.isDirectory()
    ? marker
    : path.resolve(worktreePath, text.slice(8));
  const common = line(
    await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => ''),
  );
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(
    () => '',
  );
  if (head.trim() === 'ref: refs/heads/.invalid')
    return (
      await readReftableState(worktreeSimpleGit(worktreePath), {
        repoRoot: worktreePath,
        gitDir,
        commonDir,
      })
    ).headSha;
  if (head.startsWith('ref: '))
    return readRef(
      { repoRoot: worktreePath, gitDir, commonDir },
      head.trim().slice(5),
    );
  return /^[a-f0-9]{40,64}$/.test(head.trim()) ? head.trim() : null;
}

/** Fixed-path reads only. HEAD/index belong to the worktree; refs/objects to commonDir. */
export function readLocalRefSnapshot(
  git: SimpleGit,
  worktreePath: string,
): Promise<LocalRefSnapshot> {
  const key = path.resolve(worktreePath);
  const existing = snapshots.get(key);
  if (existing) return existing;
  const build = async (): Promise<LocalRefSnapshot> => {
    const identity = await readRepositoryIdentity(git, key);
    const readHead = () => readFile(path.join(identity.gitDir, 'HEAD'), 'utf8');
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = (await readHead()).trim();
      if (head === 'ref: refs/heads/.invalid') {
        const [state, indexVersion] = await Promise.all([
          readReftableState(git, identity),
          readPathVersion(path.join(identity.gitDir, 'index')),
        ]);
        return {
          ...identity,
          ...state,
          indexVersion,
          resolveRef: (ref: string) =>
            state.resolveRef(
              ref === 'HEAD' || ref.startsWith('refs/')
                ? ref
                : `refs/remotes/${ref}`,
            ),
        };
      }
      const branchRef = head.startsWith('ref: ') ? head.slice(5) : null;
      let headSha = branchRef
        ? await readRef(identity, branchRef)
        : /^[a-f0-9]{40,64}$/.test(head)
          ? head
          : null;
      const indexVersion = await readPathVersion(
        path.join(identity.gitDir, 'index'),
      );
      if ((await readHead()).trim() !== head) continue;
      const version = [head, headSha, indexVersion].join('\0');
      const last = verifications.get(key);
      // Files/reftable storage can change outside this process. Verify on an
      // absolute deadline, and immediately when HEAD/index changes.
      if (
        !last ||
        last.version !== version ||
        Date.now() - last.at >= VERIFY_MS
      ) {
        const startedAt = Date.now();
        const authoritative = await git
          .revparse(['--verify', 'HEAD'])
          .then((value) => value.trim())
          .catch(() => null);
        if ((await readHead()).trim() !== head) continue;
        headSha = authoritative;
        if (snapshots.get(key) === pending)
          retain(verifications, key, {
            at: startedAt,
            version: [head, headSha, indexVersion].join('\0'),
          });
      }
      return {
        ...identity,
        branch: branchRef?.replace(/^refs\/heads\//, '') ?? 'HEAD',
        headSha,
        indexVersion,
        resolveRef: async (ref: string) => {
          const full =
            ref === 'HEAD'
              ? ref
              : ref.startsWith('refs/')
                ? ref
                : `refs/remotes/${ref}`;
          const sha = await readRef(identity, full);
          if (sha) return sha;
          // Reftable and oversized packed-refs use Git's storage implementation.
          const reftable = await stat(
            path.join(identity.commonDir, 'reftable'),
          ).catch(() => null);
          const packedInfo = await stat(
            path.join(identity.commonDir, 'packed-refs'),
          ).catch(() => null);
          return reftable ||
            (packedInfo && packedInfo.size > MAX_PACKED_REF_BYTES)
            ? git
                .raw(['rev-parse', '--verify', '--quiet', full])
                .then((value) => value.trim() || null)
                .catch(() => null)
            : null;
        },
      };
    }
    throw new Error('Repository HEAD changed repeatedly while reading refs');
  };
  const pending = build().finally(() => {
    if (snapshots.get(key) === pending) snapshots.delete(key);
  });
  snapshots.set(key, pending);
  return pending;
}

export function clearLocalRefState(worktreePath?: string): void {
  if (!worktreePath) {
    clearReftableState();
    identities.clear();
    snapshots.clear();
    verifications.clear();
    packed.clear();
    return;
  }
  const key = path.resolve(worktreePath);
  clearReftableState(key);
  identities.delete(key);
  snapshots.delete(key);
  verifications.delete(key);
}

export async function readOriginHead(
  identity: RepositoryIdentity,
): Promise<string | null> {
  const text = (
    await readFile(
      path.join(identity.commonDir, 'refs/remotes/origin/HEAD'),
      'utf8',
    ).catch(() => '')
  ).trim();
  if (text.startsWith('ref: refs/remotes/'))
    return text.slice('ref: refs/remotes/'.length);
  if (
    await stat(path.join(identity.commonDir, 'reftable', 'tables.list')).catch(
      () => null,
    )
  ) {
    const ref = (
      await worktreeSimpleGit(identity.repoRoot)
        .raw(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
        .catch(() => '')
    ).trim();
    return ref.startsWith('refs/remotes/')
      ? ref.slice('refs/remotes/'.length)
      : null;
  }
  return null;
}

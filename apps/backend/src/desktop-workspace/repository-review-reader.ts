import { RepositoryReviewContentReader } from './repository-review-content.js';
import { reviewGit } from './repository-review-git.js';
export { reviewGit } from './repository-review-git.js';
import type { RepositoryReviewEntry as Entry } from './repository-review.types.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseGitDiffRecords,
  type GitDiffRecord,
} from '../git/git-diff-records.js';
import { readPathVersion } from '../git/git-local-state.js';
import { readWorktreeTextStats } from '../git/git-file-stats.js';
import {
  consumeSharedGitWork,
  gitRenderScheduler,
  gitRepositoryKey,
} from '../git/git-read-scheduler.js';
import { GitByteLru, GitCacheBudget } from '../git/git-cache.js';
import type {
  RepositoryReviewQuery,
  RepositoryReviewPage,
  RepositoryReviewFile,
  RepositoryReviewHunk,
} from './repository-review.types.js';

const hash = (...values: string[]) =>
  createHash('sha256').update(values.join('\0')).digest('hex');
const conflict = (code: string, message: string) =>
  new ConflictException({ code, message });
const PAGE = 100;

interface Snapshot extends Omit<
  RepositoryReviewPage,
  'files' | 'content' | 'offset' | 'nextOffset' | 'matched'
> {
  entries: Entry[];
  created: number;
}

export function reviewQuery(
  input: Record<string, unknown>,
): RepositoryReviewQuery {
  const source = input.source;
  if (
    source !== 'uncommitted' &&
    source !== 'last-commit' &&
    source !== 'branch'
  )
    throw new BadRequestException('Invalid review source.');
  const allowed = [
    'taskId',
    'requestId',
    'source',
    'baseRef',
    'revision',
    'query',
    'offset',
    'fileId',
    'fileRev',
    'mode',
    'lineOffset',
    'context',
    'expansions',
    'force',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Invalid review argument.');
  const text = (key: string, max: number): string | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max || value.includes('\0'))
      throw new BadRequestException('Invalid review text.');
    return value;
  };
  const count = (key: string, max: number): number | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > max
    )
      throw new BadRequestException('Invalid review window.');
    return value;
  };
  const digest = (key: string): string | undefined => {
    const value = text(key, 64);
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value))
      throw new BadRequestException('Invalid review revision.');
    return value;
  };
  const taskId = count('taskId', Number.MAX_SAFE_INTEGER),
    requestId = text('requestId', 100);
  if (!taskId || !requestId || !/^[a-z0-9-]+$/i.test(requestId))
    throw new BadRequestException('A task and request identity are required.');
  const baseRef = text('baseRef', 240),
    revision = digest('revision'),
    fileId = text('fileId', 4200),
    fileRev = digest('fileRev');
  if (
    baseRef !== undefined &&
    (!baseRef || baseRef.startsWith('-') || /[~^:?*[\\\s]/.test(baseRef))
  )
    throw new BadRequestException('Choose a branch or full commit ID.');
  if (fileId !== undefined && (!fileId || !revision || !fileRev))
    throw new BadRequestException(
      'File reads require a pinned review and file revision.',
    );
  const mode = input.mode,
    force = input.force;
  if (mode !== undefined && mode !== 'changes' && mode !== 'full')
    throw new BadRequestException('Invalid review mode.');
  if (force !== undefined && typeof force !== 'boolean')
    throw new BadRequestException('Invalid content permission.');
  let expansions: RepositoryReviewQuery['expansions'];
  if (input.expansions !== undefined) {
    if (!Array.isArray(input.expansions) || input.expansions.length > 32)
      throw new BadRequestException('Invalid context expansion.');
    expansions = input.expansions.map((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        !('hunkId' in value) ||
        typeof value.hunkId !== 'string' ||
        value.hunkId.length > 100 ||
        !('before' in value) ||
        !('after' in value)
      )
        throw new BadRequestException('Invalid context expansion.');
      const before = value.before,
        after = value.after;
      if (
        typeof before !== 'number' ||
        typeof after !== 'number' ||
        !Number.isSafeInteger(before) ||
        !Number.isSafeInteger(after) ||
        before < 0 ||
        after < 0 ||
        before > 200 ||
        after > 200
      )
        throw new BadRequestException('Invalid context expansion.');
      return { hunkId: value.hunkId, before, after };
    });
  }
  return {
    taskId,
    requestId,
    source,
    baseRef,
    revision,
    fileId,
    fileRev,
    mode,
    force,
    expansions,
    query: text('query', 1000),
    offset: count('offset', 1000000),
    lineOffset: count('lineOffset', 2000000),
    context: count('context', 200),
  };
}

export class RepositoryReviewReader {
  private readonly lifetime = new AbortController();
  private readonly contentReader = new RepositoryReviewContentReader(
    this.lifetime.signal,
  );
  private git(cwd: string, args: string[], diffExit = false): Promise<string> {
    return reviewGit(cwd, args, this.lifetime.signal, diffExit);
  }
  private readonly snapshots = new GitByteLru<Snapshot>(
    new GitCacheBudget(64 * 1024 * 1024),
  );
  private readonly latest = new Map<string, string>();
  private readonly rows = new GitByteLru<readonly RepositoryReviewHunk[]>(
    new GitCacheBudget(16 * 1024 * 1024),
  );
  private readonly pending = new Map<string, Promise<Snapshot>>();
  private readonly rendering = new Map<
    string,
    Promise<readonly RepositoryReviewHunk[]>
  >();
  clear(): void {
    this.lifetime.abort();
    this.snapshots.clear();
    this.rows.clear();
    this.latest.clear();
  }

  async read(
    cwd: string,
    taskId: number,
    input: RepositoryReviewQuery,
    defaultBase: string | null,
    signal?: AbortSignal,
  ): Promise<RepositoryReviewPage> {
    let snapshot: Snapshot | undefined;
    if (input.revision)
      snapshot = this.snapshots.get(cwd + ':' + input.revision);
    if (snapshot && Date.now() - snapshot.created > 10 * 60_000)
      snapshot = undefined;
    if (
      input.revision &&
      (!snapshot ||
        snapshot.source !== input.source ||
        snapshot.taskId !== taskId ||
        (input.baseRef && input.baseRef !== snapshot.baseRef))
    )
      throw conflict(
        'review-expired',
        'This review expired. Refresh to read a coherent revision.',
      );
    if (!snapshot) {
      const key = JSON.stringify([
        cwd,
        taskId,
        input.source,
        input.baseRef,
        defaultBase,
      ]);
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= 32)
          throw conflict(
            'review-busy',
            'Too many repository reviews are pending. Try again shortly.',
          );
        // Shared bounded work has its own timeout. One caller disconnecting must not abort another.
        pending = this.capture(cwd, taskId, input, defaultBase).finally(() =>
          this.pending.delete(key),
        );
        this.pending.set(key, pending);
      }
      snapshot = await consumeSharedGitWork(pending, signal);
    }
    if (signal?.aborted) throw new Error('Review cancelled.');
    const query = (input.query ?? '').toLocaleLowerCase();
    const entries = snapshot.entries.filter(
      (entry) =>
        !query ||
        entry.file.path.toLocaleLowerCase().includes(query) ||
        entry.file.oldPath?.toLocaleLowerCase().includes(query),
    );
    const offset = Math.min(input.offset ?? 0, entries.length);
    const files = entries
      .slice(offset, offset + PAGE)
      .map((entry) => entry.file);
    let content: RepositoryReviewPage['content'] = null;
    if (input.fileId) {
      const entry = snapshot.entries.find(
        (entry) => entry.file.id === input.fileId,
      );
      if (!entry || entry.file.rev !== input.fileRev)
        throw conflict(
          'review-expired',
          'This file revision is unavailable. Refresh the review.',
        );
      const mode = input.mode ?? 'changes',
        lineOffset = input.lineOffset ?? 0;
      let notice: string | undefined;
      let hunks: readonly RepositoryReviewHunk[] = [];
      if (entry.file.binary) notice = 'Binary file · no text preview';
      else if (
        (entry.file.large || entry.file.add + entry.file.del > 400) &&
        !input.force
      )
        notice = 'Large file · choose Load the diff to read a bounded preview.';
      else {
        const key = [
          cwd,
          entry.file.rev,
          mode,
          input.context ?? 3,
          JSON.stringify(input.expansions ?? []),
        ].join(':');
        let result = this.rows.get(key);
        if (!result) {
          let pending = this.rendering.get(key);
          if (!pending) {
            if (this.rendering.size >= 32)
              throw conflict(
                'review-busy',
                'Too many files are pending. Try again shortly.',
              );
            pending = gitRenderScheduler
              .run(
                gitRepositoryKey(cwd),
                () =>
                  this.contentReader.render(
                    cwd,
                    entry,
                    mode,
                    input.context ?? 3,
                    input.expansions ?? [],
                  ),
                0,
                this.lifetime.signal,
              )
              .then((value) => {
                this.rows.set(key, value);
                return value;
              })
              .finally(() => this.rendering.delete(key));
            this.rendering.set(key, pending);
          }
          result = await consumeSharedGitWork(pending, signal);
        }
        if (result[0]?.id === 'binary') notice = result[0].heading;
        else hunks = result;
      }
      let consumed = 0,
        total = 0;
      const window = hunks.flatMap((hunk) => {
        const start = total;
        total += hunk.lines.length;
        const from = Math.max(0, lineOffset - start),
          until = Math.min(hunk.lines.length, lineOffset + 400 - start);
        if (until <= from) return [];
        consumed += until - from;
        return [
          {
            ...hunk,
            lines: hunk.lines.slice(from, until),
            before: from === 0 ? hunk.before : undefined,
            after: until === hunk.lines.length ? hunk.after : undefined,
          },
        ];
      });
      if (JSON.stringify(window).length > 3 * 1024 * 1024)
        throw conflict(
          'review-limit',
          'File exceeds the content page byte limit.',
        );
      content = {
        fileId: entry.file.id,
        rev: entry.file.rev,
        mode,
        offset: lineOffset,
        nextOffset:
          lineOffset + consumed < total ? lineOffset + consumed : null,
        hunks: window,
        ...(notice ? { notice } : {}),
      };
    }
    if (signal?.aborted) throw new Error('Review cancelled.');
    const { entries: _entries, created: _created, ...metadata } = snapshot;
    return {
      ...metadata,
      files,
      matched: entries.length,
      offset,
      nextOffset:
        offset + files.length < entries.length ? offset + files.length : null,
      content,
    };
  }

  private async capture(
    cwd: string,
    taskId: number,
    input: RepositoryReviewQuery,
    defaultBase: string | null,
  ): Promise<Snapshot> {
    const git = (args: string[]) => this.git(cwd, args);
    const headSha = await git(['rev-parse', '--verify', 'HEAD']).then(
      (value) => value.trim(),
      () => null,
    );
    let baseSha: string | null = null,
      targetSha: string | null = null,
      baseRef: string | null = null;
    let explanation = '';
    let rootCommit = false;
    const entries: Entry[] = [];
    let identity = hash(cwd, String(taskId), input.source, headSha ?? '');
    const reuse = (key: string) => {
      const revision = this.latest.get(key);
      const cached = revision
        ? this.snapshots.get(cwd + ':' + revision)
        : undefined;
      return cached && Date.now() - cached.created < 10 * 60_000
        ? cached
        : undefined;
    };
    if (input.source === 'last-commit') {
      const cached = reuse(identity);
      if (cached) return cached;
    }
    let fingerprint: string | null = null;
    if (input.source === 'uncommitted') {
      const before = await this.workingVersion(cwd);
      identity = hash(identity, before);
      const cached = reuse(identity);
      if (cached) return cached;
      const flags = [
        '--raw',
        '--numstat',
        '-z',
        '--no-abbrev',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames=50%',
        '-l200',
      ];
      const [staged, unstaged, untracked] = await Promise.all([
        git([
          'diff',
          '--cached',
          ...flags,
          ...(headSha ? [headSha] : []),
          '--',
        ]),
        git(['diff', ...flags, '--']),
        git(['ls-files', '--others', '--exclude-standard', '-z']),
      ]);
      if (
        /(?:^|\0):[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ U\0/.test(
          staged + '\0' + unstaged,
        )
      )
        throw conflict(
          'review-conflicts',
          'Uncommitted review is unavailable while the index contains unmerged entries. Resolve conflicts or choose a committed source.',
        );
      for (const [layer, raw] of [
        ['staged', staged],
        ['unstaged', unstaged],
      ] as const) {
        const records = parseGitDiffRecords(raw);
        for (let offset = 0; offset < records.length; offset += 32)
          entries.push(
            ...(await Promise.all(
              records
                .slice(offset, offset + 32)
                .map((record) => this.entry(cwd, record, layer)),
            )),
          );
      }
      const untrackedPaths = untracked.split('\0').filter(Boolean);
      for (let offset = 0; offset < untrackedPaths.length; offset += 16)
        entries.push(
          ...(await Promise.all(
            untrackedPaths.slice(offset, offset + 16).map(async (file) => {
              const version = await readPathVersion(path.join(cwd, file));
              const stats = await readWorktreeTextStats(cwd, file);
              const info = await lstat(path.join(cwd, file));
              const record: GitDiffRecord = {
                path: file,
                oldPath: null,
                status: 'added',
                oldMode: '000000',
                newMode: info.isSymbolicLink()
                  ? '120000'
                  : info.mode & 0o111
                    ? '100755'
                    : '100644',
                oldOid: '',
                newOid: '',
                additions: stats.lines ?? 0,
                deletions: 0,
                binary: stats.binary,
              };
              const entry = await this.entry(cwd, record, 'untracked', version);
              entry.file = { ...entry.file, countsExact: stats.lines !== null };
              return entry;
            }),
          )),
        );
      const after = await this.workingVersion(cwd);
      if (
        before !== after ||
        headSha !==
          (await git(['rev-parse', '--verify', 'HEAD']).then(
            (value) => value.trim(),
            () => null,
          ))
      )
        throw conflict(
          'review-moving',
          'Working changes moved during the review. Refresh to try again.',
        );
      fingerprint = before;
      baseSha = headSha;
      explanation =
        'Staged: HEAD → index. Unstaged: index → working files. Untracked: new files. A file can appear twice; counts describe both layers.';
    } else if (headSha) {
      if (input.source === 'last-commit') {
        const parents = (
          await git(['rev-list', '--parents', '-n', '1', headSha])
        )
          .trim()
          .split(/\s+/)
          .slice(1);
        rootCommit = !parents.length;
        baseSha =
          parents[0] ??
          createHash(
            (await git(['rev-parse', '--show-object-format'])).trim() ===
              'sha256'
              ? 'sha256'
              : 'sha1',
          )
            .update('tree 0\0')
            .digest('hex');
        explanation =
          parents.length > 1
            ? 'Merge commit: comparing HEAD with its first parent. Working changes excluded.'
            : parents.length
              ? 'HEAD compared with its parent. Working changes excluded.'
              : 'Initial commit compared with an empty tree. Working changes excluded.';
      } else {
        baseRef = input.baseRef ?? defaultBase;
        if (!baseRef)
          throw conflict(
            'review-no-base',
            'Choose a base branch. No task or repository default is available.',
          );
        targetSha = await git([
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${baseRef}^{commit}`,
        ]).then(
          (value) => value.trim(),
          () => {
            throw conflict(
              'review-base-missing',
              `Base ${baseRef} is missing or deleted. Choose another branch.`,
            );
          },
        );
        identity = hash(identity, baseRef, targetSha);
        const cached = reuse(identity);
        if (cached) return cached;
        const bases = (
          await git(['merge-base', '--all', headSha, targetSha]).catch(() => '')
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (bases.length !== 1)
          throw conflict(
            bases.length ? 'review-base-ambiguous' : 'review-base-unrelated',
            bases.length
              ? 'This history has multiple merge-bases. Choose a more specific base commit.'
              : 'The base and task have unrelated histories. Choose another branch.',
          );
        baseSha = bases[0];
        explanation = `Merge-base of ${baseRef} (${targetSha.slice(0, 8)}) and task HEAD → HEAD. Committed changes only; index and working files excluded. Local refs are used; this review never fetches.`;
      }
      const raw = await git([
        ...(rootCommit
          ? ['diff-tree', '--root', '--no-commit-id', '-r']
          : ['diff']),
        '--raw',
        '--numstat',
        '-z',
        '--no-abbrev',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames=50%',
        '-l200',
        ...(rootCommit ? [headSha] : [baseSha!, headSha]),
        '--',
      ]);
      for (const record of parseGitDiffRecords(raw))
        entries.push(await this.entry(cwd, record, 'committed'));
    } else {
      if (input.source === 'branch') baseRef = input.baseRef ?? defaultBase;
      explanation =
        'This repository has no commits. Uncommitted changes remain available.';
    }
    entries.sort(
      (a, b) =>
        a.file.path.localeCompare(b.file.path) ||
        a.file.layer.localeCompare(b.file.layer),
    );
    const revision = hash(
      String(taskId),
      input.source,
      headSha ?? '',
      baseSha ?? '',
      targetSha ?? '',
      baseRef ?? '',
      fingerprint ?? '',
      ...entries.map((entry) => entry.file.rev),
    );
    const snapshot: Snapshot = {
      taskId,
      source: input.source,
      revision,
      headSha,
      baseSha,
      baseRef,
      targetSha,
      fingerprint,
      explanation,
      total: entries.length,
      additions: entries.reduce((sum, entry) => sum + entry.file.add, 0),
      deletions: entries.reduce((sum, entry) => sum + entry.file.del, 0),
      countsExact: entries.every((entry) => entry.file.countsExact),
      entries,
      created: Date.now(),
    };
    this.snapshots.set(cwd + ':' + revision, snapshot);
    this.latest.set(identity, revision);
    while (this.latest.size > 64) {
      const key = this.latest.keys().next().value;
      if (key) this.latest.delete(key);
    }
    return snapshot;
  }

  private async workingVersion(cwd: string): Promise<string> {
    const [status, head, indexPath] = await Promise.all([
      this.git(cwd, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
      ]),
      this.git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      this.git(cwd, ['rev-parse', '--git-path', 'index']),
    ]);
    // ls-files includes tracked changes and untracked files, never every clean file.
    const changed = (
      await this.git(cwd, [
        'ls-files',
        '-m',
        '-d',
        '-o',
        '--exclude-standard',
        '-z',
      ])
    )
      .split('\0')
      .filter(Boolean);
    const digest = createHash('sha256').update(status).update(head);
    const index = path.resolve(cwd, indexPath.trim());
    const handle = await open(index, 'r').catch(() => null);
    if (handle) {
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          digest.update(chunk);
      } finally {
        await handle.close();
      }
    }
    for (let offset = 0; offset < changed.length; offset += 32) {
      const versions = await Promise.all(
        changed
          .slice(offset, offset + 32)
          .map((file) => readPathVersion(path.join(cwd, file))),
      );
      versions.forEach((version) => digest.update(version));
    }
    return digest.digest('hex');
  }

  private async entry(
    cwd: string,
    record: GitDiffRecord,
    layer: RepositoryReviewFile['layer'],
    knownVersion?: string,
  ): Promise<Entry> {
    const version =
      layer === 'unstaged' || layer === 'untracked'
        ? (knownVersion ?? (await readPathVersion(path.join(cwd, record.path))))
        : '';
    const info = version
      ? await lstat(path.join(cwd, record.path)).catch(() => null)
      : null;
    const rev = hash(
      record.path,
      record.oldPath ?? '',
      layer,
      record.oldOid,
      record.newOid,
      record.oldMode,
      record.newMode,
      version,
    );
    return {
      oldOid: record.oldOid,
      newOid: record.newOid,
      version,
      file: {
        id: `${layer}:${record.path}`,
        path: record.path,
        ...(record.oldPath ? { oldPath: record.oldPath } : {}),
        status:
          record.status === 'added'
            ? 'A'
            : record.status === 'deleted'
              ? 'D'
              : record.status === 'renamed'
                ? 'R'
                : 'M',
        layer,
        rev,
        add: record.additions,
        del: record.deletions,
        binary:
          record.binary ||
          record.newMode === '160000' ||
          record.oldMode === '160000',
        large: (info?.size ?? 0) > 1_000_000,
        countsExact: true,
        oldRevision:
          !record.oldOid || /^0+$/.test(record.oldOid) ? null : record.oldOid,
        newRevision:
          version ||
          (!record.newOid || /^0+$/.test(record.newOid) ? null : record.newOid),
        oldMode: record.oldMode,
        newMode: record.newMode,
      },
    };
  }
}

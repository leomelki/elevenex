import { ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  readlink,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readPathVersion } from '../git/git-local-state.js';
import { reviewGit } from './repository-review-git.js';
import type {
  RepositoryReviewEntry as Entry,
  RepositoryReviewHunk,
  RepositoryReviewLine,
  RepositoryReviewQuery,
} from './repository-review.types.js';
const MAX_BYTES = 8 * 1024 * 1024;
const conflict = (code: string, message: string) =>
  new ConflictException({ code, message });
/** Bounded file access, native diff generation and text-only presentation. The owner supplies shutdown. */
export class RepositoryReviewContentReader {
  constructor(private readonly signal: AbortSignal) {}
  private git(cwd: string, args: string[], diffExit = false): Promise<string> {
    return reviewGit(cwd, args, this.signal, diffExit);
  }
  private async blob(cwd: string, oid: string): Promise<string> {
    if (!oid || /^0+$/.test(oid)) return '';
    const size = Number((await this.git(cwd, ['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size > MAX_BYTES)
      throw conflict(
        'review-limit',
        'File exceeds the 8 MiB text preview limit. Open the exact revision in Code.',
      );
    return this.git(cwd, ['cat-file', 'blob', oid]);
  }
  private async workingText(cwd: string, entry: Entry): Promise<string> {
    const file = path.resolve(cwd, entry.file.path);
    const root = await realpath(cwd),
      parent = await realpath(path.dirname(file));
    if (parent !== root && !parent.startsWith(root + path.sep))
      throw conflict('review-path', 'File is outside the task workspace.');
    if ((await readPathVersion(file)) !== entry.version)
      throw conflict(
        'review-file-changed',
        'This file changed. Refresh the review before reading it.',
      );
    const info = await lstat(file);
    let text: string;
    if (info.isSymbolicLink())
      text = await readlink(file); // Review link text; never follow its target.
    else {
      if (!info.isFile() || info.size > MAX_BYTES)
        throw conflict(
          'review-limit',
          'File exceeds the 8 MiB text preview limit.',
        );
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, info.size + 1));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead,
          );
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > MAX_BYTES)
          throw conflict(
            'review-limit',
            'File exceeds the text preview limit.',
          );
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    }
    if ((await readPathVersion(file)) !== entry.version)
      throw conflict(
        'review-file-changed',
        'This file changed while loading. Refresh the review.',
      );
    return text;
  }
  async render(
    cwd: string,
    entry: Entry,
    mode: 'changes' | 'full',
    context: number,
    expansions: NonNullable<RepositoryReviewQuery['expansions']>,
  ): Promise<readonly RepositoryReviewHunk[]> {
    const old = await this.blob(cwd, entry.oldOid);
    const next =
      entry.file.status === 'D'
        ? ''
        : entry.version
          ? await this.workingText(cwd, entry)
          : await this.blob(cwd, entry.newOid);
    if (old.split('\n').length + next.split('\n').length > 200000)
      throw conflict(
        'review-limit',
        'File exceeds the 200,000-line combined review budget.',
      );
    if (old.includes('\0') || next.includes('\0'))
      return [
        {
          id: 'binary',
          heading: 'Binary content · text preview unavailable',
          lines: [],
        },
      ];
    const directory = await mkdtemp(path.join(tmpdir(), 'elevenex-diff-'));
    try {
      const left = path.join(directory, 'old'),
        right = path.join(directory, 'new');
      await Promise.all([writeFile(left, old), writeFile(right, next)]);
      let patch: string;
      if (entry.file.layer === 'unstaged') {
        // Git applies repository text/EOL rules to the working side. Pin the
        // path's stage-zero index identity on both sides of that native diff;
        // comparing raw temporary files would disagree with numstat on CRLF.
        const indexIdentity = async () =>
          (
            await this.git(cwd, [
              'ls-files',
              '--stage',
              '-z',
              '--',
              entry.file.path,
            ])
          ).split('\t')[0];
        const expected = `${entry.file.oldMode} ${entry.oldOid} 0`;
        if (
          (await indexIdentity()) !== expected ||
          (await readPathVersion(path.join(cwd, entry.file.path))) !==
            entry.version
        )
          throw conflict(
            'review-file-changed',
            'This file or index entry changed. Refresh the review.',
          );
        patch = await this.git(cwd, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${mode === 'full' ? 2000000 : context}`,
          '--',
          entry.file.path,
        ]);
        if (
          (await indexIdentity()) !== expected ||
          (await readPathVersion(path.join(cwd, entry.file.path))) !==
            entry.version
        )
          throw conflict(
            'review-file-changed',
            'This file or index entry changed during loading. Refresh the review.',
          );
      } else {
        patch = await this.git(
          cwd,
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            `--unified=${mode === 'full' ? 2000000 : context}`,
            '--',
            left,
            right,
          ],
          true,
        );
      }
      const hunks: {
        id: string;
        heading: string;
        lines: RepositoryReviewLine[];
        before?: number;
        after?: number;
      }[] = [];
      let oldLine = 0,
        newLine = 0;
      const oldTotal = old.split('\n').length - (old.endsWith('\n') ? 1 : 0);
      const newTotal = next.split('\n').length - (next.endsWith('\n') ? 1 : 0);
      for (const line of patch.split('\n')) {
        const heading = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
          line,
        );
        if (heading) {
          oldLine = Number(heading[1]);
          newLine = Number(heading[3]);
          hunks.push({
            id: `${oldLine}:${newLine}`,
            heading: line,
            lines: [],
            before: Math.max(0, Math.min(oldLine, newLine) - 1),
          });
          continue;
        }
        const hunk = hunks.at(-1);
        if (!hunk || !/^[ +\-]/.test(line)) continue;
        const kind =
          line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'context';
        const text = line.slice(1);
        hunk.lines.push({
          id: `${kind}:${oldLine}:${newLine}`,
          kind,
          ...(kind === 'add' ? {} : { oldNumber: oldLine++ }),
          ...(kind === 'del' ? {} : { newNumber: newLine++ }),
          text,
          spans: codeSpans(text),
        });
        hunk.after = Math.max(
          0,
          Math.min(oldTotal - oldLine + 1, newTotal - newLine + 1),
        );
      }
      for (const hunk of hunks)
        hunk.id =
          hunk.lines.find((line) => line.kind !== 'context')?.id ?? hunk.id;
      if (mode === 'changes') expandContext(hunks, old, next, expansions);
      if (!hunks.length && mode === 'full') {
        const lines = (entry.file.status === 'D' ? old : next).split('\n');
        if (lines.at(-1) === '') lines.pop();
        hunks.push({
          id: 'unchanged',
          heading: 'Full file · no text changes',
          lines: lines.map((text, index) => ({
            id: `context:${index + 1}:${index + 1}`,
            kind: 'context',
            oldNumber: index + 1,
            newNumber: index + 1,
            text,
            spans: codeSpans(text),
          })),
        });
      }
      if (
        hunks.some((hunk) =>
          hunk.lines.some((line) => line.text.length > 32768),
        )
      )
        throw conflict(
          'review-limit',
          'File exceeds the maximum line length for a text preview.',
        );
      return hunks;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
/** Small lexical spans only; plain text interpolation remains the renderer boundary. */
function codeSpans(text: string): NonNullable<RepositoryReviewLine['spans']> {
  if (text.length > 16000) return [{ text }];
  const spans: {
    text: string;
    token?: 'keyword' | 'string' | 'number' | 'comment';
  }[] = [];
  const expression =
    /(\/\/.*$|#[^!].*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:const|let|function|return|if|else|class|import|export|from|async|await|true|false|null)\b|\b\d+(?:\.\d+)?\b)/g;
  let start = 0;
  for (const match of text.matchAll(expression)) {
    if (spans.length >= 128) return [{ text }];
    if (match.index > start)
      spans.push({ text: text.slice(start, match.index) });
    const value = match[0];
    spans.push({
      text: value,
      token:
        value.startsWith('//') || value.startsWith('#')
          ? 'comment'
          : /^["']/.test(value)
            ? 'string'
            : /^\d/.test(value)
              ? 'number'
              : 'keyword',
    });
    start = match.index + value.length;
  }
  if (start < text.length) spans.push({ text: text.slice(start) });
  return spans;
}

/** Expand only the requested gap; neighbouring expansions cannot duplicate lines. */
function expandContext(
  hunks: {
    id: string;
    lines: RepositoryReviewLine[];
    before?: number;
    after?: number;
  }[],
  old: string,
  next: string,
  expansions: NonNullable<RepositoryReviewQuery['expansions']>,
): void {
  const oldLines = old.split('\n'),
    newLines = next.split('\n');
  if (oldLines.at(-1) === '') oldLines.pop();
  if (newLines.at(-1) === '') newLines.pop();
  let previousOldEnd = 0,
    previousNewEnd = 0;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index],
      expansion = expansions.find((item) => item.hunkId === hunk.id);
    const startOld =
      hunk.lines.find((line) => line.oldNumber !== undefined)?.oldNumber ?? 1;
    const startNew =
      hunk.lines.find((line) => line.newNumber !== undefined)?.newNumber ?? 1;
    const endOld =
      hunk.lines.findLast((line) => line.oldNumber !== undefined)?.oldNumber ??
      0;
    const endNew =
      hunk.lines.findLast((line) => line.newNumber !== undefined)?.newNumber ??
      0;
    const following = hunks[index + 1];
    const nextOld =
      following?.lines.find((line) => line.oldNumber !== undefined)
        ?.oldNumber ?? oldLines.length + 1;
    const nextNew =
      following?.lines.find((line) => line.newNumber !== undefined)
        ?.newNumber ?? newLines.length + 1;
    const gapBefore = Math.max(
      0,
      Math.min(startOld - previousOldEnd - 1, startNew - previousNewEnd - 1),
    );
    const gapAfter = Math.max(
      0,
      Math.min(nextOld - endOld - 1, nextNew - endNew - 1),
    );
    const before = Math.min(expansion?.before ?? 0, gapBefore),
      after = Math.min(expansion?.after ?? 0, gapAfter);
    const contextLine = (
      oldNumber: number,
      newNumber: number,
    ): RepositoryReviewLine => ({
      id: `context:${oldNumber}:${newNumber}`,
      kind: 'context',
      oldNumber,
      newNumber,
      text: newLines[newNumber - 1] ?? '',
      spans: codeSpans(newLines[newNumber - 1] ?? ''),
    });
    hunk.lines = [
      ...Array.from({ length: before }, (_, offset) =>
        contextLine(startOld - before + offset, startNew - before + offset),
      ),
      ...hunk.lines,
      ...Array.from({ length: after }, (_, offset) =>
        contextLine(endOld + offset + 1, endNew + offset + 1),
      ),
    ];
    hunk.before = gapBefore - before;
    hunk.after = gapAfter - after;
    previousOldEnd = endOld + after;
    previousNewEnd = endNew + after;
  }
}

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { worktreeSimpleGit } from '../config/system-paths.js';
import { parseBooleanConfig } from './git-config.js';
import {
  chunkedLiteralPathspecArgs,
  literalPathspecArgs,
  MAX_PATHSPEC_BYTES,
  withDefaultPathspecParsing,
} from './git-pathspec.js';

describe('literalPathspecArgs', () => {
  it('anchors each unique path at the root and disables globbing', () => {
    expect(literalPathspecArgs(['a/b.txt', 'a/b.txt', '', 'c*'])).toEqual([
      '--',
      ':(top,literal)a/b.txt',
      ':(top,literal)c*',
    ]);
  });

  it('returns null for no paths, which git would read as "everything"', () => {
    expect(literalPathspecArgs([])).toBeNull();
  });

  it('returns null past the command-line budget', () => {
    const paths = Array.from({ length: 1_000 }, (_, i) =>
      `dir/${i}`.padEnd(40, 'x'),
    );
    expect(literalPathspecArgs(paths)).toBeNull();
  });
});

describe('chunkedLiteralPathspecArgs', () => {
  it('keeps every path and stays within the budget per chunk', () => {
    const paths = Array.from({ length: 2_000 }, (_, i) =>
      `dir/${i}`.padEnd(40, 'x'),
    );
    const chunks = chunkedLiteralPathspecArgs(paths);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.slice(1))).toHaveLength(2_000);
    for (const chunk of chunks) {
      expect(chunk[0]).toBe('--');
      const bytes = chunk
        .slice(1)
        .reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(MAX_PATHSPEC_BYTES);
    }
  });
});

describe('withDefaultPathspecParsing', () => {
  const saved = process.env.GIT_LITERAL_PATHSPECS;
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a*b.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'aXb.txt'), 'x\n');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
    else process.env.GIT_LITERAL_PATHSPECS = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('keeps pathspec magic working when the user exports GIT_LITERAL_PATHSPECS', async () => {
    process.env.GIT_LITERAL_PATHSPECS = '1';
    const git = withDefaultPathspecParsing(worktreeSimpleGit(repo));
    const output = await git.raw([
      'ls-files',
      '--others',
      ...literalPathspecArgs(['a*b.txt'])!,
    ]);
    expect(output.trim().split('\n')).toEqual(['a*b.txt']);
  });
});

describe('parseBooleanConfig', () => {
  it('follows git boolean rules, last value wins', () => {
    const values = parseBooleanConfig(
      [
        'core.untrackedcache keep',
        'core.splitindex',
        'feature.manyfiles true',
        'feature.manyfiles 0',
        'fetch.writecommitgraph ',
        'core.commitgraph Yes',
        '',
      ].join('\n'),
    );
    expect(Object.fromEntries(values)).toEqual({
      'core.untrackedcache': undefined,
      'core.splitindex': true,
      'feature.manyfiles': false,
      'fetch.writecommitgraph': false,
      'core.commitgraph': true,
    });
  });
});

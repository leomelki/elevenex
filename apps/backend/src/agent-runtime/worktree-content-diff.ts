import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPatch, parsePatch, structuredPatch } from 'diff';
import { buildAugmentedEnv } from '../config/system-paths.js';
import { isolateGitEnvironment } from '../config/git-environment.js';

const OUTPUT_BYTES = 32 * 1024 * 1024;

export function nulStrings(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

export function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  allowedCodes = [0],
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((done, reject) => {
    const env = isolateGitEnvironment(buildAugmentedEnv());
    env.GIT_OPTIONAL_LOCKS = '0';
    // Only ls-tree receives filename pathspecs; check-ignore rejects this mode.
    if (args[0] === 'ls-tree') env.GIT_LITERAL_PATHSPECS = '1';
    const child = spawn('git', ['--no-optional-locks', ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Change capture git operation timed out');
      child.kill();
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) {
        failure = new Error('Change capture exceeded its path inventory limit');
        child.kill();
      } else chunks.push(chunk);
    });
    // Errors must never expose repository contents or subprocess credentials.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code === null || !allowedCodes.includes(code))
        reject(
          Object.assign(
            failure ??
              new Error(`Change capture git ${args[0]} failed (${code})`),
            { code },
          ),
        );
      else done(Buffer.concat(chunks, bytes));
    });
    child.stdin.end(input);
  });
}

export async function renderPatch(
  path: string,
  before: string,
  after: string,
): Promise<
  { patch: string; additions: number; deletions: number } | undefined
> {
  const rendered = await new Promise<
    { patch: string; additions: number; deletions: number } | undefined
  >((done) => {
    structuredPatch(path, path, before, after, undefined, undefined, {
      context: 3,
      timeout: 50,
      maxEditLength: 10_000,
      callback: (diff) => {
        if (!diff) return done(undefined);
        let additions = 0;
        let deletions = 0;
        for (const hunk of diff.hunks)
          for (const line of hunk.lines) {
            if (line.startsWith('+')) additions++;
            else if (line.startsWith('-')) deletions++;
          }
        done({ patch: formatPatch(diff), additions, deletions });
      },
    });
  });
  if (rendered) return rendered;

  // Keep expensive comparisons off the backend event loop. Use the captured
  // bytes, never the live checkout, so later edits cannot change this turn's diff.
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-turn-diff-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'before'), before, { mode: 0o600 }),
      writeFile(join(directory, 'after'), after, { mode: 0o600 }),
    ]);
    const output = await git(
      directory,
      [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--text',
        '--no-color',
        '--diff-algorithm=myers',
        '--unified=3',
        '--',
        'before',
        'after',
      ],
      undefined,
      [0, 1],
    );
    const diff = parsePatch(output.toString('utf8'))[0];
    if (!diff) return undefined;
    diff.oldFileName = path;
    diff.newFileName = path;
    let additions = 0;
    let deletions = 0;
    for (const hunk of diff.hunks)
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }
    return { patch: formatPatch(diff), additions, deletions };
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

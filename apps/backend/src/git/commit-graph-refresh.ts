/**
 * Keeps a repository's commit-graph current after the backend fetches.
 *
 * Why
 * ---
 * merge-base, ahead/behind counts, and `git status -b` all walk history.
 * Commits missing from the commit-graph have to be parsed out of packfiles
 * one by one. In a busy monorepo whose graph had not been rewritten for two
 * months, `merge-base` took 3.4 s and `rev-list --left-right --count` 3.9 s;
 * with a current graph, 0.14 s and 0.19 s. Scheduled `git maintenance` can
 * silently stop running (a container without a scheduler, for example), and
 * fetches only update the graph when `fetch.writeCommitGraph` is enabled.
 *
 * What
 * ----
 * After a successful fetch, appends one incremental layer holding only the
 * newly fetched history: `git commit-graph write --split --stdin-commits`,
 * seeded with the fetched tips. This is what `fetch.writeCommitGraph` does,
 * scoped to the refs actually fetched; a few hundred new commits cost about
 * 50 ms. Git merges small layers into larger ones by itself.
 *
 * Safety
 * ------
 * - Runs in the background and never affects the fetch that triggered it.
 * - At most one write per repository at a time; tips that arrive meanwhile
 *   are batched into the next write.
 * - Git writes the chain atomically under its own lock, and readers never
 *   see a partial graph. Timeouts send SIGTERM, so Git removes its lock file.
 * - Respects `core.commitGraph=false` and an explicit
 *   `fetch.writeCommitGraph=false`; skips shallow clones, where Git ignores
 *   commit-graphs.
 */
import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';

import {
  buildAugmentedEnv,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import { parseBooleanConfig } from './git-config.js';

const WRITE_TIMEOUT_MS = 5 * 60_000;
const logger = new Logger('CommitGraphRefresh');

interface RepositoryQueue {
  tips: Set<string>;
  running: Promise<void> | null;
}

const queues = new Map<string, RepositoryQueue>();

/**
 * Schedules a background commit-graph update covering `tips` (ref names or
 * commit IDs) after they were fetched into the repository at `repoPath`.
 */
export function refreshCommitGraphAfterFetch(
  repoPath: string,
  tips: readonly string[],
): void {
  if (tips.length === 0) return;
  let queue = queues.get(repoPath);
  if (!queue) {
    queue = { tips: new Set(), running: null };
    queues.set(repoPath, queue);
  }
  for (const tip of tips) queue.tips.add(tip);
  if (queue.running) return;

  const active = queue;
  active.running = drain(repoPath, active).finally(() => {
    active.running = null;
    if (active.tips.size === 0 && queues.get(repoPath) === active) {
      queues.delete(repoPath);
    }
  });
}

/** Resolves once all scheduled writes have finished. For tests. */
export async function settleCommitGraphRefreshes(): Promise<void> {
  for (;;) {
    const running = [...queues.values()]
      .map((queue) => queue.running)
      .filter((write): write is Promise<void> => write !== null);
    if (running.length === 0) return;
    await Promise.all(running);
  }
}

async function drain(repoPath: string, queue: RepositoryQueue): Promise<void> {
  while (queue.tips.size > 0) {
    const tips = [...queue.tips];
    queue.tips.clear();
    try {
      await writeIncrementalLayer(repoPath, tips);
    } catch (error) {
      logger.debug(
        `[${repoPath}] commit-graph refresh skipped: ${
          error instanceof Error ? error.message.split('\n', 1)[0] : error
        }`,
      );
    }
  }
}

async function writeIncrementalLayer(
  repoPath: string,
  tips: string[],
): Promise<void> {
  const git = worktreeSimpleGit(repoPath);
  const [config, shallow] = await Promise.all([
    git.raw([
      'config',
      '--get-regexp',
      '^(core\\.commitgraph|fetch\\.writecommitgraph)$',
    ]),
    git.raw(['rev-parse', '--is-shallow-repository']),
  ]);
  const settings = parseBooleanConfig(config);
  if (
    settings.get('core.commitgraph') === false ||
    settings.get('fetch.writecommitgraph') === false ||
    shallow.trim() === 'true'
  ) {
    return;
  }

  // `--stdin-commits` takes object IDs; unknown tips are dropped.
  const commits = await Promise.all(
    tips.map((tip) =>
      git
        .raw([
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${tip}^{commit}`,
        ])
        .then((value) => value.trim())
        .catch(() => ''),
    ),
  );
  const ids = [...new Set(commits.filter(Boolean))];
  if (ids.length === 0) return;

  await runWithInput(
    'git',
    ['commit-graph', 'write', '--split', '--stdin-commits', '--no-progress'],
    `${ids.join('\n')}\n`,
    repoPath,
  );
}

function runWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...buildAugmentedEnv(process.env, cwd), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: WRITE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `exited with ${signal ?? code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

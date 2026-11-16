import { spawn } from 'node:child_process';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';
import { isolateGitEnvironment } from '../config/git-environment.js';
import { gitReadScheduler, gitRepositoryKey } from './git-read-scheduler.js';

/** Read only the prompt's prefix, including one overflow character for truncation.
 * Do not buffer the full patch or invoke user diff drivers/textconv programs.
 * The optional index is the caller's frozen selection, never an inherited index.
 */
export function readCommitMessageDiff(
  worktreePath: string,
  maxChars: number,
  indexFile?: string,
): Promise<string> {
  return gitReadScheduler.run(gitRepositoryKey(worktreePath), async () => {
    const env = isolateGitEnvironment(
      await buildAugmentedEnvAsync(process.env, worktreePath),
    );
    delete env.GIT_PAGER;
    delete env.PAGER;
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_NO_LAZY_FETCH = '1';
    if (indexFile) env.GIT_INDEX_FILE = indexFile;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        'git',
        [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--no-color',
          '--ignore-submodules=dirty',
          '--',
        ],
        {
          cwd: worktreePath,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: 15_000,
          killSignal: 'SIGKILL',
        },
      );
      let text = '';
      let stderr = '';
      let truncated = false;
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      child.once('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (truncated) return;
        text += chunk.slice(0, maxChars + 1 - text.length);
        if (text.length > maxChars) {
          truncated = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      // Wait for close even after truncation so the scheduler owns the process
      // through pipe shutdown. Intentional prefix termination is the only
      // nonzero exit accepted as success; timeouts and Git failures still fail.
      child.once('close', (code) => {
        if (failure) reject(failure);
        else if (truncated || code === 0) resolve(text);
        else reject(new Error(stderr.trim() || 'Could not read staged diff.'));
      });
    });
  });
}

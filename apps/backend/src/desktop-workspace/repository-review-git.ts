import { execFile } from 'node:child_process';
import { buildAugmentedEnv } from '../config/system-paths.js';
import {
  gitReadScheduler,
  gitRepositoryKey,
} from '../git/git-read-scheduler.js';

/** No shell, external diff, textconv, lazy network fetch or index writes. */
export function reviewGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  diffExit = false,
): Promise<string> {
  return gitReadScheduler.run(
    gitRepositoryKey(cwd),
    () =>
      new Promise<string>((resolve, reject) => {
        const env = {
          ...buildAugmentedEnv(process.env, cwd),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        };
        execFile(
          'git',
          [
            '--literal-pathspecs',
            '-c',
            'core.quotePath=false',
            '-c',
            'color.ui=false',
            '-c',
            'diff.external=',
            ...args,
          ],
          {
            cwd,
            env,
            signal,
            encoding: 'utf8',
            maxBuffer: 24 * 1024 * 1024,
            timeout: 20000,
          },
          (error, stdout) => {
            if (!error || (diffExit && 'code' in error && error.code === 1))
              resolve(stdout);
            else reject(error);
          },
        );
      }),
    0,
    signal,
  );
}

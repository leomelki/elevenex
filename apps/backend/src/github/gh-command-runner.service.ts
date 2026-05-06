import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { buildAugmentedEnv } from '../config/system-paths.js';

export class GhCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly missingBinary = false,
  ) {
    super(message);
  }
}

@Injectable()
export class GhCommandRunnerService {
  private readonly timeoutMs = 15_000;

  async run(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'gh',
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 5_000_000,
          env: {
            ...buildAugmentedEnv(),
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
            NO_COLOR: '1',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const nodeError = error as NodeJS.ErrnoException & { code?: string | number | null };
            reject(
              new GhCommandError(
                stderr?.trim() || stdout?.trim() || error.message,
                typeof nodeError.code === 'number' ? nodeError.code : null,
                stdout,
                stderr,
                nodeError.code === 'ENOENT',
              ),
            );
            return;
          }

          resolve(stdout);
        },
      );
    });
  }

  async isInstalled(cwd: string): Promise<boolean> {
    try {
      await this.run(['--version'], cwd);
      return true;
    } catch (error) {
      if (error instanceof GhCommandError && error.missingBinary) {
        return false;
      }

      return true;
    }
  }
}

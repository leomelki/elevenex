import { execFile, type ExecFileOptions } from 'node:child_process';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        ...options,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

export async function execFileQuiet(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<void> {
  await execFileAsync(file, args, {
    ...options,
    maxBuffer: options.maxBuffer ?? 64 * 1024,
  });
}

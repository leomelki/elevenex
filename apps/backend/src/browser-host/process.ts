import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

export interface HostCommandResult {
  readonly code: number | null;
  readonly output: string;
}

/** Short, bounded probes. Never return their raw output to a viewer. */
export function probeHostCommand(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<HostCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error
            ? typeof error.code === 'number'
              ? error.code
              : null
            : 0,
          output: stdout + stderr,
        });
      },
    );
  });
}

/** Explicit CLI provisioning only. Own the entire process group through close,
 * including an installer's downloader/package-manager children on interruption. */
export function runHostStep(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  environment = process.env,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: tmpdir(),
      env: environment,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      failure ??= new Error(
        'Browser setup was interrupted or exceeded its time limit.',
      );
      if (!child.pid) return;
      if (stopping) return;
      const pid = child.pid;
      stopping = new Promise<void>((done) => {
        if (process.platform === 'win32') {
          execFile(
            'taskkill',
            ['/pid', String(pid), '/T', '/F'],
            { timeout: 5000, windowsHide: true },
            () => done(),
          );
        } else {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* Already closed. */
          }
          // A group leader can exit while a downloader/compiler child ignores
          // TERM. Keep ownership until the whole group's kill grace expires.
          setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* Already closed. */
            }
            done();
          }, 5000);
        }
      });
    };
    const deadline = setTimeout(stop, 600000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      void (stopping ?? Promise.resolve()).then(() => {
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(`Browser setup step ${command} exited with ${code}.`),
          );
        else resolve();
      });
    });
  });
}

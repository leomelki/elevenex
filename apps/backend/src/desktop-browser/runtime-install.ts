import { spawn, execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';

/** Supervise the approved runtime's installer, including its downloader child processes. */
export async function installRuntimeBrowser(
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const cli = join(
    dirname(createRequire(__filename).resolve('playwright-core/package.json')),
    'cli.js',
  );
  await access(cli);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'install', 'chromium', '--no-shell'],
      {
        cwd: directory,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stopped = false,
      bytes = 0;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === 'win32')
        execFile(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { timeout: 5000, windowsHide: true },
          () => undefined,
        );
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* Already exited. */
        }
        force = setTimeout(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null)
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
        }, 5000);
      }
    };
    const timer = setTimeout(stop, 180000);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(force);
      signal.removeEventListener('abort', stop);
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) stop();
    });
    child.once('error', () => {
      cleanup();
      reject(new Error('Browser installation could not start'));
    });
    child.once('exit', (code) => {
      cleanup();
      code === 0 && !stopped
        ? resolve()
        : reject(
            new Error(
              'Browser installation failed. Check the host connection and system requirements.',
            ),
          );
    });
  });
}

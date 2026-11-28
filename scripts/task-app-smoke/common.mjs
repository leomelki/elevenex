import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const backend = join(root, 'apps/backend');
export const desktop = join(root, 'apps/desktop');
export const backendRequire = createRequire(join(backend, 'package.json'));
export const desktopRequire = createRequire(join(desktop, 'package.json'));
export const exec = promisify(execFile);

export async function until(label, predicate, signal, interval = 100) {
  for (;;) {
    if (signal.aborted) throw new Error('Timed out or interrupted while ' + label, { cause: signal.reason });
    const value = await predicate();
    if (value) return value;
    await sleep(interval, undefined, { signal }).catch(error => {
      throw new Error('Timed out or interrupted while ' + label, { cause: error });
    });
  }
}

export function testEnvironment(home) {
  const env = { ...process.env };
  // Never connect the isolated smoke to the caller's backend, SSH agent or provider.
  for (const key of Object.keys(env)) {
    if (/^(ELEVENEX_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|SSH_AUTH_SOCK$|DB_PATH$|GIT_|CODEX_|ANTHROPIC_|OPENAI_)/.test(key)) delete env[key];
  }
  return {
    ...env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

/** Every long-lived fixture child is owned from spawn through close, including startup errors. */
export function startProcess(executable, args, options) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '', failure;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  child.once('error', error => { failure = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  return {
    assertAlive() {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(executable + ' exited (' + (child.signalCode ?? child.exitCode) + '). ' + diagnostics);
      }
    },
    diagnostics: () => diagnostics,
    async stop() {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
      // Allow the managed daemon to stop its backend and supervised child trees.
      const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
      try { await closed; } finally { clearTimeout(deadline); }
    },
  };
}

export async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

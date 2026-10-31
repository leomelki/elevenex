import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { boundedBody } from './download';
import type { InstalledBackend } from './install';
import { signalBackendTree } from './process-tree';

export interface BackendExit { readonly code: number | null; readonly signal: NodeJS.Signals | null }
export interface RunningBackend {
  readonly url: string;
  readonly exited: Promise<BackendExit>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (!address || typeof address === 'string') reject(new Error('Could not allocate backend port'));
        else resolve(address.port);
      });
    });
  });
}

function environment(installation: InstalledBackend, root: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Do not inherit Electron or Node injection/debug flags into downloaded code.
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELEVENEX_') || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  return {
    ...env, NODE_ENV: 'production', DB_PATH: join(root, 'data/elevenex.db'),
    ELEVENEX_DATA_ROOT: join(root, 'data'),
    ELEVENEX_BACKEND_RUNTIME_ROOT: installation.directory,
    ELEVENEX_BACKEND_MODE: 'local', ELEVENEX_BACKEND_SUPERVISED: '1',
    ELEVENEX_BIND_HOST: '127.0.0.1', ELEVENEX_PROXY_PORT: String(port), FRONTEND_PORT: String(port),
  };
}

async function waitReady(url: string, version: string, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${url}/api/info`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (response.ok) {
        const info: unknown = JSON.parse((await boundedBody(response, 4096)).toString('utf8'));
        if (info && typeof info === 'object' && 'backendSha' in info && info.backendSha === version) return;
      } else await response.body?.cancel();
    } catch { signal.throwIfAborted(); }
    await delay(200, undefined, { signal });
  }
}

function stopHost(child: ChildProcess, exited: Promise<BackendExit>, backendPid: number | undefined): Promise<void> {
  return (async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (child.connected) child.send({ type: 'stop' }, () => undefined);
    else child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 5000);
      })]);
      if (!graceful) {
        if (backendPid) await signalBackendTree(backendPid, true);
        child.kill('SIGKILL');
        await exited;
      }
    } finally { if (timer) clearTimeout(timer); }
  })();
}

/** Startup retries only known port races and transient Windows executable locks. */
export async function startBackend(
  installation: InstalledBackend, root: string, version: string, signal: AbortSignal,
  supervisor = join(__dirname, 'host.js'),
): Promise<RunningBackend> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const port = await freePort();
    signal.throwIfAborted();
    const url = `http://127.0.0.1:${port}`;
    const child = fork(supervisor, [installation.entry, installation.directory], {
      execPath: installation.executable, execArgv: [], cwd: root,
      env: environment(installation, root, port), silent: true, windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    let backendPid: number | undefined;
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'spawned'
        && 'pid' in message && typeof message.pid === 'number' && Number.isSafeInteger(message.pid) && message.pid > 0) backendPid = message.pid;
    });
    let spawnError: Error | undefined;
    // Drain both pipes while retaining only a bounded diagnostic tail in memory.
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + stripVTControlCharacters(chunk.toString('utf8'))).slice(-2048); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + stripVTControlCharacters(chunk.toString('utf8'))).slice(-8192); });
    const diagnostic = () => [spawnError?.message, stderr.trim() && `stderr:\n${stderr.trim()}`, stdout.trim() && `stdout:\n${stdout.trim()}`].filter(Boolean).join('\n\n') || 'The backend exited without diagnostic output.';
    const exited = new Promise<BackendExit>(resolve => {
      child.once('error', error => { spawnError = error; resolve({ code: null, signal: null }); });
      // close follows pipe drainage, so the final error cannot overtake its output.
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= stopHost(child, exited, backendPid);
    const readiness = new AbortController();
    const timeout = AbortSignal.timeout(30_000);
    try {
      await Promise.race([
        waitReady(url, version, AbortSignal.any([signal, readiness.signal, timeout])),
        exited.then(result => { throw new Error(`Backend stopped during startup (${result.code ?? result.signal ?? 'spawn error'}).\n\n${diagnostic()}`); }),
      ]);
      signal.throwIfAborted();
      return { url, exited, stop };
    } catch (error) {
      await stop();
      signal.throwIfAborted();
      const portConflict = /EADDRINUSE|address already in use/.test(`${stderr} ${stdout}`);
      const windowsLock = process.platform === 'win32' && /EBUSY|EPERM|EACCES|ETXTBSY|UNKNOWN|ENOENT|permission denied/.test(`${spawnError?.message ?? ''} ${stderr}`);
      if (attempt >= 3 || (!portConflict && !windowsLock)) {
        if (timeout.aborted) throw new Error(`Backend did not become ready within 30 seconds.\n\n${diagnostic()}`, { cause: error });
        throw error;
      }
      await delay(250 * (attempt + 1), undefined, { signal });
    } finally { readiness.abort(); }
  }
}

/**
 * Runs under the downloaded Node, outside Electron. The IPC pipe is our lease:
 * even an Electron crash disconnects it and triggers process-tree cleanup.
 * This file is an executable boundary, not an importable application service.
 */
import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { signalBackendTree } from './process-tree';

const [entry, directory, ownershipGate] = process.argv.slice(2);
if (!entry || !directory || !process.send) throw new Error('Backend supervisor requires an IPC parent and runtime paths');
const backendEntry = entry;
let child: ChildProcess | undefined;
let stopping: Promise<void> | undefined;
let exitCode = 1;
let ownership: import('node:net').Server | import('node:dgram').Socket | undefined;
let resolveExit: () => void;
const exit = new Promise<void>(resolve => { resolveExit = resolve; });

function start(): void {
  if (child || stopping) return;
  child = spawn(process.execPath, [backendEntry], {
    cwd: directory, env: process.env, detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', error => { console.error('Backend spawn failed:', error); resolveExit(); });
  child.once('exit', code => { exitCode = code ?? 1; resolveExit(); });
  if (child.pid && process.send) process.send({ type: 'spawned', pid: child.pid }, error => { if (error) shutdown(); });
}

function stop(): Promise<void> {
  stopping ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (child?.pid) {
        await signalBackendTree(child.pid, false);
        await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
        // Also kill descendants after a graceful leader exit: PTYs can outlive it.
        // Give the OS a turn to reap descendants that already accepted SIGTERM.
        await delay(100);
        await signalBackendTree(child.pid, true);
      } else resolveExit();
      await exit;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  return stopping;
}

const shutdown = () => { void stop().then(() => { ownership?.close(); process.exit(exitCode); }, error => { console.error(error); process.exit(1); }); };
process.once('disconnect', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.on('message', (message: unknown, handle: SendHandle | undefined) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'stop') shutdown();
  // Remote daemons lend us their kernel ownership lock. Retaining its handle
  // until tree cleanup finishes prevents a replacement from racing a crash.
  if (message && typeof message === 'object' && 'type' in message && message.type === 'ownership' && handle && ('listen' in handle || 'bind' in handle)) {
    ownership = handle;
    if (ownershipGate === '--ownership') start();
  }
});
void exit.then(shutdown);
if (!process.connected) shutdown();
else if (ownershipGate !== '--ownership') start();

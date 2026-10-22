/**
 * Runs under the downloaded Node, outside Electron. The IPC pipe is our lease:
 * even an Electron crash disconnects it and triggers process-tree cleanup.
 * This file is an executable boundary, not an importable application service.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { signalBackendTree } from './process-tree';

const [entry, directory] = process.argv.slice(2);
if (!entry || !directory || !process.send) throw new Error('Backend supervisor requires an IPC parent and runtime paths');
const child = spawn(process.execPath, [entry], {
  cwd: directory, env: process.env, detached: process.platform !== 'win32',
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
});
let stopping: Promise<void> | undefined;
let exitCode = 1;
const exit = new Promise<void>(resolve => {
  child.once('error', error => { console.error('Backend spawn failed:', error); resolve(); });
  child.once('exit', code => { exitCode = code ?? 1; resolve(); });
});

function stop(): Promise<void> {
  stopping ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (child.pid) {
        await signalBackendTree(child.pid, false);
        await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
        // Also kill descendants after a graceful leader exit: PTYs can outlive it.
        // Give the OS a turn to reap descendants that already accepted SIGTERM.
        await delay(100);
        await signalBackendTree(child.pid, true);
      }
      await exit;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  return stopping;
}

const shutdown = () => { void stop().then(() => process.exit(exitCode), error => { console.error(error); process.exit(1); }); };
process.once('disconnect', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'stop') shutdown();
});
void exit.then(shutdown);
if (!process.connected) shutdown();
else if (child.pid) process.send({ type: 'spawned', pid: child.pid }, error => { if (error) shutdown(); });

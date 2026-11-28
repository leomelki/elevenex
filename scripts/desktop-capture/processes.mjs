import { spawn } from 'node:child_process';

/** Owns only processes launched by one capture invocation. No global signal handlers. */
export class CaptureProcesses {
  children = new Set();
  stopped = false;
  stopping;

  start(executable, args, cwd) {
    if (this.stopped) throw new Error('Capture stopped');
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit' });
    const done = new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`Capture process exited with ${signal ?? code}`)));
    });
    // Observe rejection immediately, including long-lived Angular processes.
    void done.catch(() => undefined);
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    child.once('error', () => this.children.delete(child));
    return { child, done };
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.all([...this.children].map(child => new Promise(resolveExit => {
      // Failed spawns emit close without exit. Cancellation can race their error.
      child.once('close', resolveExit);
      // A failed/pending spawn has no OS process to signal. In particular, never
      // allow an unset PID to reach native process-group signalling.
      if (!Number.isInteger(child.pid) || child.pid <= 0) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    })));
    return this.stopping;
  }
}

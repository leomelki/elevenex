import type { IPty } from 'node-pty';

const terminations = new WeakMap<IPty, Promise<void>>();

/** Await process exit before allowing its working directory to be reused. */
export function terminatePtyAndWait(
  pty: IPty,
  options: { signal?: string; graceMs?: number } = {},
): Promise<void> {
  const existing = terminations.get(pty);
  if (existing) return existing;
  // Register before signalling: kill can synchronously deliver an exit event.
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  terminations.set(pty, pending);
  const begin = () => {
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      clearTimeout(deadline);
      subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    let subscription: { dispose(): void } | undefined;
    try {
      subscription = pty.onExit(() => finish());
    } catch (error) {
      finish(error);
      return;
    }
    if (settled) {
      subscription?.dispose();
      return;
    }
    const kill = (signal?: string) => {
      try {
        if (signal === undefined) pty.kill();
        else pty.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') finish();
        else finish(error);
      }
    };
    deadline = setTimeout(
      () =>
        finish(
          new Error(
            'The process did not stop. Its environment is still reserved.',
          ),
        ),
      7000,
    );
    // node-pty closes the Windows pseudoconsole with a signal-free kill.
    // Repeating it is unnecessary. Wait for the same exit confirmation as Unix.
    if (process.platform === 'win32') kill();
    else {
      escalation = setTimeout(() => kill('SIGKILL'), options.graceMs ?? 1500);
      kill(options.signal ?? 'SIGTERM');
    }
  };
  begin();
  // A failed stop can be retried. Successful stops remain known for late callers.
  void pending.catch(() => {
    if (terminations.get(pty) === pending) terminations.delete(pty);
  });
  return pending;
}

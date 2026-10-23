import type { IPty } from 'node-pty';

const terminations = new WeakMap<IPty, Promise<void>>();

/** Await process exit before allowing its working directory to be reused. */
export function terminatePtyAndWait(
  process: IPty,
  options: { signal?: string; graceMs?: number } = {},
): Promise<void> {
  const existing = terminations.get(process);
  if (existing) return existing;
  // Register before signalling: kill can synchronously deliver an exit event.
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  terminations.set(process, pending);
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
      subscription = process.onExit(() => finish());
    } catch (error) {
      finish(error);
      return;
    }
    if (settled) {
      subscription?.dispose();
      return;
    }
    const kill = (signal: string) => {
      try {
        process.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') finish();
        else finish(error);
      }
    };
    escalation = setTimeout(() => kill('SIGKILL'), options.graceMs ?? 1500);
    deadline = setTimeout(
      () =>
        finish(
          new Error(
            'The process did not stop. Its environment is still reserved.',
          ),
        ),
      7000,
    );
    kill(options.signal ?? 'SIGTERM');
  };
  begin();
  // A failed stop can be retried. Successful stops remain known for late callers.
  void pending.catch(() => {
    if (terminations.get(process) === pending) terminations.delete(process);
  });
  return pending;
}

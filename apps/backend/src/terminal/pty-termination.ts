import type { IPty } from 'node-pty';

/** Await process exit before allowing its working directory to be reused. */
export function terminatePtyAndWait(process: IPty): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      clearTimeout(deadline);
      subscription.dispose();
      if (error) reject(error);
      else resolve();
    };
    const subscription = process.onExit(() => finish());
    const kill = (signal: string) => {
      try {
        process.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') finish();
        else finish(error);
      }
    };
    escalation = setTimeout(() => kill('SIGKILL'), 1500);
    deadline = setTimeout(
      () =>
        finish(
          new Error(
            'The process did not stop. Its environment is still reserved.',
          ),
        ),
      7000,
    );
    kill('SIGTERM');
  });
}

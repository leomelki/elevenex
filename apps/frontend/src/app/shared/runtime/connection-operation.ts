/** Bound actual work; callers omit the deadline while waiting for user input. */
export function awaitConnectionOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('SSH connection canceled.'));
    };
    // Always observe the operation, including a late rejection after cancellation.
    operation.then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('SSH connection timed out. Check the network and retry.'));
      }, timeoutMs);
    }
  });
}

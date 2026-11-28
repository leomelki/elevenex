/** A timeout/cancellation disconnects the caller, while the started operation retains ownership. */
export function untilSessionDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', expire);
    };
    const expire = () => {
      cleanup();
      resolve(undefined);
    };
    const timer = setTimeout(expire, milliseconds);
    signal?.addEventListener('abort', expire, { once: true });
    if (signal?.aborted) expire();
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

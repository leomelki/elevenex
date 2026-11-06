import { setImmediate } from 'node:timers/promises';

// These operations are shared by MCP search, review and merge-conflict tools.
// Keep their concurrency bounded independently of any editor integration.
export class FileOperationQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly capacity: number,
  ) {}

  async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.concurrency) {
      if (this.pending.length >= this.capacity)
        throw new Error('File operation queue is full');
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = this.pending.indexOf(resume);
          if (index >= 0) this.pending.splice(index, 1);
          reject(signal?.reason);
        };
        this.pending.push(resume);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export function yieldFileOperation(): Promise<void> {
  return setImmediate();
}

export async function awaitFileOperation<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function sortFileItems<T>(
  items: T[],
  compare: (left: T, right: T) => number,
  signal?: AbortSignal,
): Promise<T[]> {
  // Merge bounded runs, yielding between passes so unrelated backend work runs.
  let sorted = items.slice();
  for (let width = 1; width < sorted.length; width *= 2) {
    const merged: T[] = [];
    for (let start = 0; start < sorted.length; start += width * 2) {
      const middle = Math.min(start + width, sorted.length);
      const end = Math.min(start + width * 2, sorted.length);
      let left = start,
        right = middle;
      while (left < middle || right < end) {
        if (
          right >= end ||
          (left < middle && compare(sorted[left], sorted[right]) <= 0)
        )
          merged.push(sorted[left++]);
        else merged.push(sorted[right++]);
      }
      signal?.throwIfAborted();
      if (start % 4096 === 0) await setImmediate();
    }
    sorted = merged;
  }
  return sorted;
}

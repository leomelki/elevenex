import { ServiceUnavailableException } from '@nestjs/common';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

export const yieldEditorWork = () => yieldImmediate();

/** A caller can leave shared work without cancelling its other consumers. */
export async function waitForEditorWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Bound both running and waiting work; cancellation removes queued closures. */
export class EditorWorkQueue {
  private active = 0;
  private pending: Array<() => void> = [];
  constructor(
    private concurrency = 2,
    private capacity = 16,
  ) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.concurrency) {
      if (this.pending.length >= this.capacity)
        throw new ServiceUnavailableException('Editor is busy. Retry shortly.');
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.pending = this.pending.filter((item) => item !== start);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        this.pending.push(start);
      });
    } else {
      this.active++;
    }
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Stable merge sort with finite slices, including index construction. */
export async function sortEditorItems<T>(
  items: T[],
  compare: (a: T, b: T) => number,
  signal?: AbortSignal,
): Promise<T[]> {
  let source = items;
  let target = new Array<T>(items.length);
  let operations = 0;
  for (let width = 1; width < items.length; width *= 2) {
    for (let start = 0; start < items.length; start += width * 2) {
      const mid = Math.min(start + width, items.length);
      const end = Math.min(start + width * 2, items.length);
      let left = start,
        right = mid;
      for (let out = start; out < end; out++) {
        target[out] =
          right >= end ||
          (left < mid && compare(source[left], source[right]) <= 0)
            ? source[left++]
            : source[right++];
        if (++operations % 2048 === 0) {
          await yieldEditorWork();
          signal?.throwIfAborted();
        }
      }
    }
    [source, target] = [target, source];
  }
  return source;
}

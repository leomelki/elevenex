/** Bound filesystem/Git fan-out without retaining results after a read completes. */
export async function mapWorktrees<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await read(items[index]);
      }
    }),
  );
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}

export interface WorktreeStatusSnapshot {
  currentBranch: string | null;
  isDirty: boolean;
  hasConflicts: boolean;
  error: string | null;
}

interface InputJob {
  readonly motion?: string;
  run(): Promise<void>;
  reject(error: Error): void;
}

/** Ordered admission and receipts are separate: only compatible motion may overlap.
 * Every other operation is an exclusive barrier, including complete input batches.
 */
export class RuntimeInputLane {
  private readonly queue: InputJob[] = [];
  private active = 0;
  private motion?: string;
  private pending = 0;
  private scheduled = false;
  private disposed = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly capacity = 8,
    private readonly onIdle?: () => void,
  ) {}

  get idle(): boolean {
    return this.pending === 0;
  }

  enqueue<T>(operation: () => Promise<T>, motion?: string): Promise<T> {
    if (this.disposed)
      return Promise.reject(new Error('Browser input stopped'));
    if (this.pending >= this.capacity)
      return Promise.reject(new Error('Browser input capacity reached'));
    this.pending++;
    const result = new Promise<T>((resolve, reject) => {
      this.queue.push({
        motion,
        reject,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('Browser input failed'),
            );
          }
        },
      });
    });
    this.schedule();
    return result;
  }

  settled(): Promise<void> {
    return this.idle
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.add(resolve));
  }

  destroy(): void {
    this.disposed = true;
    for (const job of this.queue.splice(0)) {
      this.pending--;
      job.reject(new Error('Browser input stopped'));
    }
    this.notifyIdle();
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (!this.disposed && this.queue.length) {
      const job = this.queue[0];
      if (
        this.active &&
        (job.motion === undefined ||
          job.motion !== this.motion ||
          this.active >= 4)
      )
        return;
      this.queue.shift();
      this.motion = job.motion;
      this.active++;
      void job.run().finally(() => {
        this.active--;
        this.pending--;
        if (!this.active) this.motion = undefined;
        this.notifyIdle();
        this.schedule();
      });
      if (job.motion === undefined) return;
    }
  }

  private notifyIdle(): void {
    if (!this.idle) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    this.onIdle?.();
  }
}

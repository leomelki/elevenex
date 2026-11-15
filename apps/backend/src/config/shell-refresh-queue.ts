import type { ShellEnvironmentOptions } from './shell-environment-options.js';

type Environment = NodeJS.ProcessEnv | null;
interface CaptureJob {
  readonly cwd: string | undefined;
  readonly controller: AbortController;
  readonly promise: Promise<Environment>;
  readonly resolve: (env: Environment) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  required: boolean;
  running: boolean;
}

/** Owns bounded capture admission, priority, queue deadlines and cancellation. */
export class ShellRefreshQueue {
  private readonly jobs = new Map<string | undefined, CaptureJob>();
  private active = 0;
  private waiting = 0;
  private optionalWaiting = 0;
  private disposed = false;

  constructor(
    private readonly options: Pick<
      ShellEnvironmentOptions,
      'concurrency' | 'maxPending' | 'queueTimeoutMs'
    >,
    private readonly capture: (
      cwd: string | undefined,
      signal: AbortSignal,
    ) => Promise<Environment>,
  ) {}

  has(cwd?: string): boolean {
    return this.jobs.has(cwd);
  }

  request(cwd?: string, required = false): Promise<Environment> {
    if (this.disposed) return Promise.resolve(null);
    const existing = this.jobs.get(cwd);
    if (existing) {
      if (
        required &&
        !existing.required &&
        !existing.running &&
        cwd !== undefined
      )
        this.optionalWaiting--;
      existing.required ||= required;
      return existing.promise;
    }
    // Global bootstrap has a reserved slot so background work cannot deny it.
    if (cwd !== undefined && this.waiting >= this.options.maxPending) {
      const optional =
        required && this.optionalWaiting
          ? [...this.jobs.values()].find(
              (job) => !job.running && !job.required && job.cwd !== undefined,
            )
          : undefined;
      if (optional) this.settle(optional, null);
      else
        return required
          ? Promise.reject(
              new Error(
                'Shell environment setup is busy. Retry after current captures finish.',
              ),
            )
          : Promise.resolve(null);
    }
    let resolve!: CaptureJob['resolve'], reject!: CaptureJob['reject'];
    const promise = new Promise<Environment>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: CaptureJob = {
      cwd,
      required,
      promise,
      resolve,
      reject,
      running: false,
      controller: new AbortController(),
    };
    this.jobs.set(cwd, job);
    if (cwd !== undefined) {
      this.waiting++;
      if (!required) this.optionalWaiting++;
    }
    job.timer = setTimeout(() => {
      this.settle(
        job,
        null,
        job.required
          ? new Error(
              'Shell environment setup waited too long in the queue. Retry after current captures finish.',
            )
          : undefined,
      );
      this.drain();
    }, this.options.queueTimeoutMs);
    job.timer.unref();
    this.drain();
    return promise;
  }

  /** Eviction can drop optional queued work, never an active/caller-owned capture. */
  dropOptional(cwd: string): void {
    const job = this.jobs.get(cwd);
    if (job && !job.required && !job.running) this.settle(job, null);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  /** Transport environment changes invalidate work begun under the old input. */
  invalidate(): void {
    for (const job of [...this.jobs.values()]) {
      job.controller.abort();
      this.settle(
        job,
        null,
        !this.disposed && job.required
          ? new Error(
              'SSH agent environment changed during shell setup. Retry the operation.',
            )
          : undefined,
      );
    }
  }

  private settle(job: CaptureJob, env: Environment, error?: Error): void {
    if (this.jobs.get(job.cwd) !== job) return;
    this.jobs.delete(job.cwd);
    clearTimeout(job.timer);
    if (job.running) this.active--;
    else if (job.cwd !== undefined) {
      this.waiting--;
      if (!job.required) this.optionalWaiting--;
    }
    if (error) job.reject(error);
    else job.resolve(env);
  }

  private drain(): void {
    while (!this.disposed && this.active < this.options.concurrency) {
      let job: CaptureJob | undefined;
      for (const candidate of this.jobs.values()) {
        if (candidate.running) continue;
        if (candidate.cwd === undefined) {
          job = candidate;
          break;
        }
        if (!job || (!job.required && candidate.required)) job = candidate;
      }
      if (!job) return;
      job.running = true;
      if (job.cwd !== undefined) {
        this.waiting--;
        if (!job.required) this.optionalWaiting--;
      }
      this.active++;
      clearTimeout(job.timer);
      const run = async () => this.capture(job.cwd, job.controller.signal);
      void run().then(
        (env) => {
          this.settle(job, env);
          this.drain();
        },
        () => {
          this.settle(job, null);
          this.drain();
        },
      );
    }
  }
}

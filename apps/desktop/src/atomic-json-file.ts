import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Private atomic settings writes: one active snapshot plus one coalesced pending snapshot. */
export class AtomicJsonFile {
  private pending: { body: string; readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void } | undefined;
  private writing = false;
  private written: string | undefined;
  constructor(private readonly path: string, private readonly limit: number, private readonly deduplicate = false) {}
  write(body: string): Promise<void> {
    if (Buffer.byteLength(body) > this.limit) return Promise.reject(new Error('Settings exceed their size limit'));
    if (this.deduplicate && !this.writing && this.written === body) return Promise.resolve();
    if (this.pending) { this.pending.body = body; return this.pending.promise; }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.pending = { body, promise, resolve, reject };
    if (!this.writing) { this.writing = true; queueMicrotask(() => { void this.flush(); }); }
    return promise;
  }
  private async flush(): Promise<void> {
    while (this.pending) {
      const job = this.pending; this.pending = undefined;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(job.body); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path); this.written = job.body; job.resolve();
      } catch (error) { job.reject(error); }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
    this.writing = false;
  }
}

import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MachineAppearance } from '@elevenex/shared';
import { editInput } from './validation';

/** Application-owned, monotonic first-run flag. A failed write can be retried. */
export class MachinePreferences {
  private opened = false;
  private pending?: Promise<void>;
  private loadError = false;
  private appearance?: MachineAppearance;
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}

  get hasOpenedMachine(): boolean { return this.opened; }
  get localAppearance(): MachineAppearance | undefined { return this.appearance; }
  get error(): string | null { return this.loadError ? 'Machine preferences could not be read. Your saved settings have been preserved.' : null; }
  flush(): Promise<void> { return this.writes; }

  async load(): Promise<void> {
    try {
      const file = await open(this.path, 'r');
      try {
        if ((await file.stat()).size > 4096) throw new Error('Preferences exceed their limit');
        const value: unknown = JSON.parse(await file.readFile('utf8'));
        if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
          || !('hasOpenedMachine' in value) || typeof value.hasOpenedMachine !== 'boolean') throw new Error('Invalid preferences');
        this.opened = value.hasOpenedMachine;
        if ('localAppearance' in value) this.appearance = editInput(value.localAppearance, false);
      } finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) this.loadError = true;
    }
  }

  markOpened(): Promise<void> {
    if (this.loadError) return Promise.reject(new Error(this.error ?? 'Preferences unavailable'));
    if (this.opened) return Promise.resolve();
    return this.pending ??= this.enqueue(async () => { await this.write(true, this.appearance); this.opened = true; }).finally(() => { this.pending = undefined; });
  }

  saveAppearance(appearance: MachineAppearance): Promise<void> {
    if (this.loadError) return Promise.reject(new Error(this.error ?? 'Preferences unavailable'));
    const validated = editInput(appearance, false);
    return this.enqueue(async () => { await this.write(this.opened, validated); this.appearance = validated; });
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const job = this.writes.then(write);
    this.writes = job.catch(() => undefined);
    return job;
  }

  private async write(hasOpenedMachine: boolean, localAppearance?: MachineAppearance): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, hasOpenedMachine, localAppearance })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}

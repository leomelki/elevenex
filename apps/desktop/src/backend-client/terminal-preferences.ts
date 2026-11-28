import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskTerminalPreferences } from '@elevenex/shared';
import { terminalPreferences } from './terminal-launch-validation';

/** Main-only per-machine settings. Overrides never enter renderer storage or
 * task checkouts. A corrupt file is preserved; writes are atomic and private. */
export class TerminalPreferences {
  private readonly values = new Map<string, TaskTerminalPreferences>();
  private loaded?: Promise<void>;
  private writes = Promise.resolve();
  constructor(private readonly path: string | null) {}
  async flush(): Promise<void> { await this.loaded; await this.writes; }
  async get(machine: string): Promise<TaskTerminalPreferences> {
    await this.load();
    return this.values.get(this.key(machine)) ?? { profile: null, prediction: 'auto' };
  }
  async save(machine: string, value: TaskTerminalPreferences): Promise<void> {
    const parsed = terminalPreferences(value);
    await this.load();
    const save = this.writes.then(async () => {
      const values = new Map(this.values), key = this.key(machine);
      values.delete(key); values.set(key, parsed);
      while (values.size > 128) values.delete(values.keys().next().value!);
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify({ version: 1, machines: Object.fromEntries(values) })); await file.sync(); }
          finally { await file.close(); }
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      }
      this.values.clear(); for (const [id, entry] of values) this.values.set(id, entry);
    });
    this.writes = save.catch(() => {}); await save;
  }
  private key(machine: string): string { return createHash('sha256').update(machine).digest('hex'); }
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      if (!this.path) return;
      try {
        const file = await open(this.path, 'r');
        try {
          if ((await file.stat()).size > 5 * 1024 * 1024) throw new Error('Terminal settings exceed their limit');
          const raw: unknown = JSON.parse(await file.readFile('utf8'));
          if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('machines' in raw) ||
              !raw.machines || typeof raw.machines !== 'object' || Array.isArray(raw.machines)) throw new Error('Invalid terminal settings');
          const entries = Object.entries(raw.machines);
          if (entries.length > 128) throw new Error('Too many terminal settings');
          for (const [key, value] of entries) {
            if (!/^[a-f\d]{64}$/.test(key)) throw new Error('Invalid terminal settings key');
            this.values.set(key, terminalPreferences(value));
          }
        } finally { await file.close(); }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    })();
  }
}

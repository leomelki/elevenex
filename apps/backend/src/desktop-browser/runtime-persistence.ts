import { Injectable } from '@nestjs/common';
import { mkdir, open, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getElevenexDataRoot } from '../config/app-data-paths.js';
import { runtimeUrl } from './runtime-network.js';
import { z } from 'zod';
const saved = z
  .object({
    active: z.number().int().min(0).max(11),
    tabs: z
      .array(
        z
          .object({
            url: z.string().max(2048),
            width: z.enum(['full', 'phone']),
            by: z.enum(['you', 'agent']),
            agentSessionId: z.number().int().positive().safe().nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type SavedRuntimeBrowser = z.infer<typeof saved>;
function safeLocations(value: SavedRuntimeBrowser): SavedRuntimeBrowser {
  return {
    ...value,
    tabs: value.tabs.map((tab) => {
      const url = runtimeUrl(tab.url);
      url.search = '';
      url.hash = '';
      return { ...tab, url: url.href };
    }),
  };
}
interface Write {
  data: string;
  readonly result: Promise<boolean>;
  resolve(saved: boolean): void;
}
/** Private bounded metadata. Writes coalesce by task; no cookies, queries, form data or frames reach disk. */
@Injectable()
export class RuntimeBrowserPersistence {
  private readonly root = join(getElevenexDataRoot(), 'task-browser-state');
  private readonly pending = new Map<string, Write>();
  private writing = false;
  async read(identity: string): Promise<SavedRuntimeBrowser | null> {
    if (!/^[a-f0-9]{64}$/.test(identity))
      throw new Error('Invalid browser identity');
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(join(this.root, identity + '.json'), 'r');
      const bytes = Buffer.alloc(32769);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 32768) return null;
      const result = saved.safeParse(
        JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')),
      );
      return result.success ? safeLocations(result.data) : null;
    } catch {
      return null;
    } finally {
      await file?.close();
    }
  }
  save(identity: string, value: SavedRuntimeBrowser): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(identity)) return Promise.resolve(false);
    let data: string;
    try {
      data = JSON.stringify(safeLocations(saved.parse(value)));
    } catch {
      return Promise.resolve(false);
    }
    if (Buffer.byteLength(data) > 32768) return Promise.resolve(false);
    const current = this.pending.get(identity);
    if (current) {
      current.data = data;
      return current.result;
    }
    if (this.pending.size >= 8) return Promise.resolve(false);
    let resolve!: (success: boolean) => void;
    const result = new Promise<boolean>((yes) => {
      resolve = yes;
    });
    this.pending.set(identity, { data, result, resolve });
    void this.drain();
    return result;
  }
  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      for (const [identity, job] of this.pending) {
        let success = false;
        try {
          await mkdir(this.root, { recursive: true, mode: 0o700 });
          let written: string;
          do {
            written = job.data;
            const temporary = join(
              this.root,
              identity + '.' + randomUUID() + '.tmp',
            );
            try {
              await writeFile(temporary, written, { mode: 0o600, flag: 'wx' });
              await rename(temporary, join(this.root, identity + '.json'));
            } finally {
              await unlink(temporary).catch(() => undefined);
            }
          } while (written !== job.data);
          success = true;
        } catch {
          /* Ordinary disk failure cannot leak a location into logs. */
        } finally {
          this.pending.delete(identity);
          job.resolve(success);
        }
      }
    } finally {
      this.writing = false;
    }
  }
  async flush(): Promise<void> {
    while (this.pending.size)
      await Promise.all([...this.pending.values()].map((job) => job.result));
  }
}

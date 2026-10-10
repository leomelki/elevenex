import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';

function revision(file: Stats): string {
  return `${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
}

/** Bounded LRU of parsed transcripts; every read validates the file revision. */
export class TranscriptFileCache<T> {
  private readonly entries = new Map<
    string,
    { revision: string; bytes: number; value: T }
  >();
  private readonly inFlight = new Map<string, Promise<T>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 32,
  ) {}

  async read(path: string, load: () => Promise<T>): Promise<T> {
    const file = await stat(path);
    const version = revision(file);
    const cached = this.entries.get(path);
    if (cached?.revision === version) {
      this.entries.delete(path);
      this.entries.set(path, cached);
      // Callers attach interactions and may mutate nested tool inputs. Never
      // let those mutations contaminate another session's cached transcript.
      return structuredClone(cached.value);
    }
    if (cached) this.remove(path);

    const key = JSON.stringify([path, version]);
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await load();
        const after = await stat(path).catch(() => null);
        // An append, rewind or replacement during the read must not populate
        // the cache with a snapshot claiming to represent the new revision.
        if (after && revision(after) === version && file.size <= this.maxBytes) {
          this.remove(path);
          this.entries.set(path, {
            revision: version,
            bytes: file.size,
            value,
          });
          this.bytes += file.size;
          while (
            this.bytes > this.maxBytes ||
            this.entries.size > this.maxEntries
          ) {
            this.remove(this.entries.keys().next().value!);
          }
        }
        return value;
      })();
      this.inFlight.set(key, pending);
    }
    try {
      return structuredClone(await pending);
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private remove(path: string): void {
    const entry = this.entries.get(path);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(path);
  }
}

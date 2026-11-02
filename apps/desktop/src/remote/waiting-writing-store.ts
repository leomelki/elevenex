import { readFile, stat } from 'node:fs/promises';
import type { WaitingWriting } from '@elevenex/shared';
import { AtomicJsonFile } from '../atomic-json-file';
import { object } from './validation';
import { waitingWriting } from './waiting-writing';

/** Separate sidecar: older desktop releases keep reading their unchanged settings format. */
export class WaitingWritingStore {
  private readonly writer: AtomicJsonFile;
  constructor(private readonly path: string) { this.writer = new AtomicJsonFile(path, 16 * 1024 * 1024, true); }
  async load(hostIds: readonly string[]): Promise<readonly Record<string, WaitingWriting>[]> {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new Error('Waiting writing exceeds its limit.');
      const raw = object(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'windows']);
      if (raw['version'] !== 1 || !Array.isArray(raw['windows']) || raw['windows'].length > 32) throw new Error('Invalid waiting writing.');
      const allowed = new Set(['local', ...hostIds]);
      return raw['windows'].map((raw: unknown) => {
        const records = object(raw, Object.keys(typeof raw === 'object' && raw !== null ? raw : {}));
        if (Object.keys(records).length > 101) throw new Error('Too many saved machines.');
        // A crash between the two files can leave a removed host in the journal.
        return Object.fromEntries(Object.entries(records).filter(([key]) => allowed.has(key)).map(([key, value]) => [key, waitingWriting(value)]));
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error('Waiting writing could not be read. Repair the desktop waiting-writing file before saving more.', { cause: error });
    }
  }
  save(windows: readonly Record<string, WaitingWriting>[]): Promise<void> { return this.writer.write(JSON.stringify({ version: 1, windows })); }
}

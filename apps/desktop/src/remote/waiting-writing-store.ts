import { readFile, stat } from 'node:fs/promises';
import type { WaitingWriting } from '@elevenex/shared';
import { AtomicJsonFile } from '../atomic-json-file';
import { object, text } from './validation';
import { waitingWriting } from './waiting-writing';

export interface SavedWaitingWriting extends WaitingWriting {
  /** Absent only for journals written before destination verification. */
  readonly identity?: string;
}

/** Separate sidecar: older desktop releases keep reading their unchanged settings format. */
export class WaitingWritingStore {
  private readonly writer: AtomicJsonFile;
  constructor(private readonly path: string) { this.writer = new AtomicJsonFile(path, 16 * 1024 * 1024, true); }
  async load(hostIds: readonly string[]): Promise<readonly Record<string, SavedWaitingWriting>[]> {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new Error('Waiting writing exceeds its limit.');
      const raw = object(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'windows']);
      const version = raw['version'];
      if ((version !== 1 && version !== 2) || !Array.isArray(raw['windows']) || raw['windows'].length > 32) throw new Error('Invalid waiting writing.');
      const allowed = new Set(['local', ...hostIds]);
      return raw['windows'].map((raw: unknown) => {
        const records = object(raw, Object.keys(typeof raw === 'object' && raw !== null ? raw : {}));
        if (Object.keys(records).length > 101) throw new Error('Too many saved machines.');
        // A crash between the two files can leave a removed host in the journal.
        return Object.fromEntries(Object.entries(records).filter(([key]) => allowed.has(key)).map(([key, value]) => {
          if (version === 1) return [key, waitingWriting(value)];
          const saved = object(value, ['identity', 'writing']);
          const identity = saved['identity'] === null ? undefined : text(saved['identity'], 64);
          if (identity !== undefined && !/^[a-f0-9]{64}$/.test(identity)) throw new Error('Invalid waiting destination.');
          return [key, { ...waitingWriting(saved['writing']), ...(identity === undefined ? {} : { identity }) }];
        }));
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error('Waiting writing could not be read. Repair the desktop waiting-writing file before saving more.', { cause: error });
    }
  }
  save(windows: readonly Record<string, SavedWaitingWriting>[]): Promise<void> {
    // The binding and writing share one atomic file. A settings-file update may
    // otherwise survive a crash before its old destination's queue is removed.
    const saved = windows.map(records => Object.fromEntries(Object.entries(records).map(([key, { identity, ...writing }]) =>
      [key, { identity: identity ?? null, writing }])));
    return this.writer.write(JSON.stringify({ version: 2, windows: saved }));
  }
}

import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface ClaudeChildRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: unknown;
  parentUuid?: string | null;
  agentId?: string;
  parentAgentId?: string | null;
  [key: string]: unknown;
}
interface Entry {
  identity: string;
  offset: number;
  mtime: number;
  partial: string;
  decoder: StringDecoder;
  records: ClaudeChildRecord[];
  bytes: number;
  trimmed: boolean;
}
const PAGE_SIZE = 300;
const MAX_RECORDS = 4000;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

/** Async, append-only reads for live children. No whole-file read on each refresh. */
export class ClaudeChildTranscriptStore {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<void>>();

  async read(
    path: string,
    before?: string,
  ): Promise<{
    records: ClaudeChildRecord[];
    hasEarlier: boolean;
    revision: string;
  }> {
    let pending = this.inFlight.get(path);
    if (!pending) {
      pending = this.refresh(path);
      this.inFlight.set(path, pending);
    }
    try {
      await pending;
    } finally {
      if (this.inFlight.get(path) === pending) this.inFlight.delete(path);
    }
    const entry = this.entries.get(path)!;
    let records = entry.records;
    let trimmed = entry.trimmed;
    let index = before
      ? records.findIndex((record) => record.uuid === before)
      : records.length;
    if (before && index < 0) {
      // Only an explicit request for older history scans the earlier part.
      const earlier = await this.readBefore(path, before);
      records = earlier.records;
      trimmed = earlier.trimmed;
      index = records.length;
    }
    const end = records
      .slice(0, index)
      .filter(
        (record) =>
          (record.type === 'assistant' || record.type === 'user') &&
          record.message &&
          record.uuid,
      );
    return {
      records: structuredClone(end.slice(-PAGE_SIZE)),
      hasEarlier: end.length > PAGE_SIZE || trimmed,
      revision: `${entry.identity}:${entry.offset}:${entry.mtime}`,
    };
  }

  private async refresh(path: string): Promise<void> {
    const file = await stat(path);
    const identity = `${file.dev}:${file.ino}`;
    let entry = this.entries.get(path);
    if (
      !entry ||
      entry.identity !== identity ||
      file.size < entry.offset ||
      (file.size === entry.offset && file.mtimeMs !== entry.mtime)
    ) {
      entry = {
        identity,
        offset: 0,
        mtime: 0,
        partial: '',
        decoder: new StringDecoder('utf8'),
        records: [],
        bytes: 0,
        trimmed: false,
      };
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (entry.offset < file.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, file.size - entry.offset),
          entry.offset,
        );
        if (!bytesRead) break;
        entry.offset += bytesRead;
        this.append(entry, entry.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await handle.close();
    }
    entry.mtime = file.mtimeMs;
    this.entries.delete(path);
    this.entries.set(path, entry);
    let bytes = [...this.entries.values()].reduce(
      (sum, cached) => sum + cached.bytes,
      0,
    );
    while (this.entries.size > 24 || bytes > MAX_CACHE_BYTES) {
      const key = this.entries.keys().next().value!;
      bytes -= this.entries.get(key)!.bytes;
      this.entries.delete(key);
    }
  }

  private append(entry: Entry, text: string): void {
    const lines = (entry.partial + text).split('\n');
    entry.partial = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as ClaudeChildRecord;
        if (!record || typeof record !== 'object') continue;
        entry.records.push(record);
        entry.bytes += JSON.stringify(record).length * 2;
      } catch {
        /* A damaged completed line must not hide the rest of the chat. */
      }
    }
    while (
      entry.records.length > MAX_RECORDS ||
      entry.bytes > MAX_ENTRY_BYTES
    ) {
      const removed = entry.records.shift();
      if (!removed) break;
      entry.bytes = Math.max(
        0,
        entry.bytes - JSON.stringify(removed).length * 2,
      );
      entry.trimmed = true;
    }
    // A malformed writer must not grow an unterminated line without a bound.
    if (entry.partial.length > MAX_ENTRY_BYTES) entry.partial = '';
  }

  private async readBefore(
    path: string,
    before: string,
  ): Promise<{ records: ClaudeChildRecord[]; trimmed: boolean }> {
    const handle = await open(path, 'r');
    const file: Stats = await handle.stat();
    const entry: Entry = {
      identity: '',
      offset: 0,
      mtime: 0,
      partial: '',
      decoder: new StringDecoder('utf8'),
      records: [],
      bytes: 0,
      trimmed: false,
    };
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (entry.offset < file.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          entry.offset,
        );
        if (!bytesRead) break;
        entry.offset += bytesRead;
        this.append(entry, entry.decoder.write(buffer.subarray(0, bytesRead)));
        const index = entry.records.findIndex(
          (record) => record.uuid === before,
        );
        if (index >= 0)
          return {
            records: entry.records.slice(0, index),
            trimmed: entry.trimmed,
          };
      }
      return { records: [], trimmed: false };
    } finally {
      await handle.close();
    }
  }
}

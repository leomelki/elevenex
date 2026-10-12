import { open, stat } from 'node:fs/promises';
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
interface CachedRecord {
  record: ClaudeChildRecord;
  offset: number;
  bytes: number;
}
interface OlderPage {
  records: CachedRecord[];
  hasEarlier: boolean;
}
interface Entry {
  identity: string;
  offset: number;
  mtime: number;
  partial: string;
  lineOffset: number;
  decoder: StringDecoder;
  records: CachedRecord[];
  cursors: Map<string, number>;
  olderInFlight: Map<string, Promise<OlderPage>>;
  bytes: number;
  trimmed: boolean;
}
const PAGE_SIZE = 300;
const MAX_RECORDS = 4000;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const READ_SIZE = 64 * 1024;
const MAX_CURSORS = 64;

function parseRecord(line: string): ClaudeChildRecord | null {
  try {
    const record = JSON.parse(line) as ClaudeChildRecord;
    return record &&
      (record.type === 'assistant' || record.type === 'user') &&
      record.message &&
      typeof record.uuid === 'string'
      ? record
      : null;
  } catch {
    // A damaged completed line must not hide the rest of the chat.
    return null;
  }
}

/** Async, append-only reads for live children. No whole-file read on each refresh. */
export class ClaudeChildTranscriptStore {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Entry>>();

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
    let entry: Entry;
    try {
      entry = await pending;
    } finally {
      if (this.inFlight.get(path) === pending) this.inFlight.delete(path);
    }
    let records = entry.records;
    let trimmed = entry.trimmed;
    let index = before
      ? records.findIndex((item) => item.record.uuid === before)
      : records.length;
    if (before && (index < 0 || (trimmed && index < PAGE_SIZE))) {
      // Read across the retained boundary, including when the cursor is the
      // first retained record. Coalesce clients requesting the same page.
      let older = entry.olderInFlight.get(before);
      if (!older) {
        older = this.readBefore(path, before, entry);
        entry.olderInFlight.set(before, older);
      }
      let page: OlderPage;
      try {
        page = await older;
      } finally {
        if (entry.olderInFlight.get(before) === older)
          entry.olderInFlight.delete(before);
      }
      records = page.records;
      trimmed = page.hasEarlier;
      index = records.length;
    }
    const page = records.slice(Math.max(0, index - PAGE_SIZE), index);
    const first = page[0];
    if (first) {
      entry.cursors.delete(first.record.uuid!);
      entry.cursors.set(first.record.uuid!, first.offset);
      while (entry.cursors.size > MAX_CURSORS)
        entry.cursors.delete(entry.cursors.keys().next().value!);
    }
    return {
      records: structuredClone(page.map((item) => item.record)),
      hasEarlier: index > PAGE_SIZE || trimmed,
      revision: `${entry.identity}:${entry.offset}:${entry.mtime}`,
    };
  }

  private async refresh(path: string): Promise<Entry> {
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
        lineOffset: 0,
        decoder: new StringDecoder('utf8'),
        records: [],
        cursors: new Map(),
        olderInFlight: new Map(),
        bytes: 0,
        trimmed: false,
      };
    }
    // Unchanged polling needs only stat; do not reopen and allocate a buffer.
    if (entry.offset < file.size) {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(READ_SIZE);
        while (entry.offset < file.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, file.size - entry.offset),
            entry.offset,
          );
          if (!bytesRead) break;
          entry.offset += bytesRead;
          this.append(
            entry,
            entry.decoder.write(buffer.subarray(0, bytesRead)),
          );
        }
      } finally {
        await handle.close();
      }
    }
    entry.mtime = file.mtimeMs;
    this.entries.delete(path);
    this.entries.set(path, entry);
    let bytes = [...this.entries.values()].reduce(
      (sum, cached) => sum + cached.bytes + cached.partial.length * 2,
      0,
    );
    while (this.entries.size > 24 || bytes > MAX_CACHE_BYTES) {
      const key = this.entries.keys().next().value!;
      const cached = this.entries.get(key)!;
      bytes -= cached.bytes + cached.partial.length * 2;
      this.entries.delete(key);
    }
    // Return the entry directly: concurrent refreshes can evict this cache key.
    return entry;
  }

  private append(entry: Entry, text: string): void {
    const lines = (entry.partial + text).split('\n');
    entry.partial = lines.pop()!;
    for (const line of lines) {
      const offset = entry.lineOffset;
      entry.lineOffset += Buffer.byteLength(line) + 1;
      const record = parseRecord(line);
      if (record) {
        const bytes = line.length * 2;
        entry.records.push({ record, offset, bytes });
        entry.bytes += bytes;
      }
    }
    let removed = 0;
    while (
      entry.records.length - removed > MAX_RECORDS ||
      entry.bytes > MAX_ENTRY_BYTES
    ) {
      const item = entry.records[removed++];
      if (!item) break;
      entry.bytes -= item.bytes;
      entry.trimmed = true;
    }
    if (removed) entry.records.splice(0, removed);
    // A malformed writer must not grow an unterminated line without a bound.
    if (entry.partial.length > MAX_ENTRY_BYTES) {
      entry.lineOffset += Buffer.byteLength(entry.partial);
      entry.partial = '';
    }
  }

  private async readBefore(
    path: string,
    before: string,
    entry: Entry,
  ): Promise<OlderPage> {
    const handle = await open(path, 'r');
    try {
      const file = await handle.stat();
      const sameFile =
        `${file.dev}:${file.ino}` === entry.identity &&
        file.size >= entry.offset &&
        (file.size > entry.offset || file.mtimeMs === entry.mtime);
      const cursor = sameFile
        ? (entry.records.find((item) => item.record.uuid === before)?.offset ??
          entry.cursors.get(before))
        : undefined;
      let position =
        cursor ?? (sameFile ? Math.min(entry.offset, file.size) : file.size);
      let found = cursor !== undefined;
      // Ignore the unfinished trailing line when searching from EOF.
      let discardTrailing = !found;
      let partial = Buffer.alloc(0);
      const records: CachedRecord[] = [];
      let bytes = 0;
      const collect = (line: Buffer, offset: number) => {
        if (discardTrailing) {
          discardTrailing = false;
          return;
        }
        if (!line.length || line.length > MAX_ENTRY_BYTES) return;
        const text = line.toString('utf8');
        const record = parseRecord(text);
        if (!record) return;
        if (!found) {
          if (record.uuid === before) found = true;
        } else if (text.length * 2 <= MAX_ENTRY_BYTES) {
          const item = { record, offset, bytes: text.length * 2 };
          records.push(item);
          bytes += item.bytes;
        }
      };
      const buffer = Buffer.allocUnsafe(READ_SIZE);
      // Seek directly to known page cursors and read backwards only until one
      // page plus a lookahead is available. Bound both page and line memory.
      const needsEarlier = () =>
        records.length <= PAGE_SIZE && bytes <= MAX_ENTRY_BYTES;
      while (position > 0 && needsEarlier()) {
        const start = Math.max(0, position - buffer.length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          position - start,
          start,
        );
        if (!bytesRead) break;
        const chunk = Buffer.concat([buffer.subarray(0, bytesRead), partial]);
        let end = chunk.length;
        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] !== 10) continue;
          collect(chunk.subarray(i + 1, end), start + i + 1);
          end = i;
          if (!needsEarlier()) break;
        }
        partial = chunk.subarray(0, end);
        if (partial.length > MAX_ENTRY_BYTES) {
          partial = Buffer.alloc(0);
          discardTrailing = true;
        }
        position = start;
      }
      if (position === 0 && needsEarlier()) collect(partial, 0);
      const hasEarlier = !needsEarlier();
      if (hasEarlier) records.pop(); // lookahead proves that another page exists
      return { records: records.reverse(), hasEarlier };
    } finally {
      await handle.close();
    }
  }
}

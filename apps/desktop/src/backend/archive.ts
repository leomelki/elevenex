import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

/** A bounded reader: neither the tar nor an individual file is buffered in memory. */
class TarReader {
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  private expanded = 0;

  constructor(private readonly source: AsyncIterator<Buffer>, private readonly signal: AbortSignal) {}

  async read(length: number): Promise<Buffer> {
    const result = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      this.signal.throwIfAborted();
      if (this.offset === this.chunk.length) {
        const next = await this.source.next();
        if (next.done) throw new Error('Truncated backend archive');
        this.chunk = next.value;
        this.offset = 0;
        this.expanded += this.chunk.length;
        if (this.expanded > MAX_EXPANDED_BYTES) throw new Error('Backend archive expands beyond its size limit');
      }
      const count = Math.min(length - written, this.chunk.length - this.offset);
      this.chunk.copy(result, written, this.offset, this.offset + count);
      this.offset += count;
      written += count;
    }
    return result;
  }

  async finish(): Promise<void> {
    if (this.chunk.subarray(this.offset).some(byte => byte !== 0)) throw new Error('Unexpected trailing archive data');
    for (;;) {
      this.signal.throwIfAborted();
      const next = await this.source.next();
      if (next.done) return;
      this.expanded += next.value.length;
      if (this.expanded > MAX_EXPANDED_BYTES || next.value.some(byte => byte !== 0)) throw new Error('Invalid archive padding');
    }
  }
}

function stringField(header: Buffer, start: number, length: number): string {
  return header.subarray(start, start + length).toString('utf8').split('\0')[0] ?? '';
}

function octal(header: Buffer, start: number, length: number): number {
  const value = stringField(header, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Unsupported tar numeric field');
  const parsed = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid tar numeric field');
  return parsed;
}

function archivePath(value: string): string {
  const name = value.replace(/\/$/, '');
  const parts = name.split('/');
  // Use portable rules even on macOS: the same archives run on Windows.
  if (name.length > 4096 || parts[0] !== 'backend' || parts.some(part => !part || part === '.' || part === '..'
    || Array.from(part).some(character => character.charCodeAt(0) < 32)
    || /[\\:<>"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe backend archive path');
  }
  return name;
}

function paxAttributes(body: Buffer): Record<string, string> {
  const attributes: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    const lengthText = body.subarray(offset, space).toString('ascii');
    const length = Number(lengthText);
    if (space < offset || !/^\d+$/.test(lengthText) || !Number.isSafeInteger(length)
      || length <= space - offset + 2 || offset + length > body.length || body[offset + length - 1] !== 10) {
      throw new Error('Invalid PAX archive metadata');
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('Invalid PAX attribute');
    const key = record.slice(0, equals);
    if (key.includes('sparse') || key === 'linkpath') throw new Error('Unsupported archive link or sparse file');
    attributes[key] = record.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

/** Accept regular files/directories plus PAX/GNU names; never extract links or devices. */
export async function extractBackend(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  await pipeline(createReadStream(archive), createGunzip(), async (source: AsyncIterable<Buffer>) => {
    const reader = new TarReader(source[Symbol.asyncIterator](), signal);
    let attributes: Record<string, string> = {};
    let longName: string | undefined;
    for (let entries = 0; entries < MAX_ENTRIES; entries++) {
      const header = await reader.read(BLOCK);
      if (header.every(byte => byte === 0)) {
        if (!(await reader.read(BLOCK)).every(byte => byte === 0)) throw new Error('Invalid tar end marker');
        await reader.finish();
        return;
      }
      const expected = octal(header, 148, 8);
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== expected) throw new Error('Invalid tar header checksum');
      let size = octal(header, 124, 12);
      const type = stringField(header, 156, 1);
      if (['x', 'g', 'L'].includes(type)) {
        if (size > 64 * 1024) throw new Error('Archive metadata exceeds its size limit');
        const body = await reader.read(size);
        await reader.read((BLOCK - size % BLOCK) % BLOCK);
        if (type === 'L') longName = body.toString('utf8').replace(/\0$/, '');
        else {
          const next = paxAttributes(body);
          if (type === 'g' && ('path' in next || 'size' in next)) throw new Error('Unsupported global archive path');
          if (type === 'x') attributes = { ...attributes, ...next };
        }
        continue;
      }
      if (!['', '0', '5'].includes(type)) throw new Error('Backend archives cannot contain links or special files');
      if (attributes['size'] !== undefined) {
        if (!/^\d+$/.test(attributes['size'])) throw new Error('Invalid PAX file size');
        size = Number(attributes['size']);
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES) throw new Error('Invalid archive file size');
      const prefix = stringField(header, 257, 6) === 'ustar' ? stringField(header, 345, 155) : '';
      const rawName = attributes['path'] ?? longName ?? `${prefix ? `${prefix}/` : ''}${stringField(header, 0, 100)}`;
      attributes = {};
      longName = undefined;
      // BSD tar may prepend a root AppleDouble metadata file on macOS. Ignore
      // its bounded payload; it is not part of the executable runtime tree.
      if (rawName === '._backend' && type !== '5' && size <= 64 * 1024) {
        await reader.read(size);
        await reader.read((BLOCK - size % BLOCK) % BLOCK);
        continue;
      }
      const name = archivePath(rawName);
      const path = join(destination, name);
      if (type === '5') {
        if (size !== 0) throw new Error('Invalid archive directory');
        await mkdir(path, { recursive: true, mode: 0o700 });
      } else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const mode = octal(header, 100, 8) & 0o111 ? 0o700 : 0o600;
        const file = await open(path, 'wx', mode);
        try {
          for (let remaining = size; remaining > 0;) {
            const bytes = await reader.read(Math.min(64 * 1024, remaining));
            let offset = 0;
            while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
            remaining -= bytes.length;
          }
        } finally { await file.close(); }
      }
      await reader.read((BLOCK - size % BLOCK) % BLOCK);
    }
    throw new Error('Backend archive contains too many entries');
  }, { signal });
}

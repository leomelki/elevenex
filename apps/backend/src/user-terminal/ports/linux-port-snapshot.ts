import { open, opendir, readlink } from 'node:fs/promises';
import { endianness } from 'node:os';
import {
  listenerHost,
  MAX_PORT_PROCESSES,
  type PortProcess,
} from './port-processes.js';
import type { SocketListener } from './posix-port-snapshot.js';

async function readBounded(
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit)
      throw new Error('Proc data exceeds the discovery limit');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

function vanished(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
  );
}

export function parseProcProcess(raw: string): PortProcess {
  // comm can contain spaces and ')' characters. Fields after the last ')' are
  // state (3), ppid (4), ... starttime (22, in clock ticks since boot).
  const close = raw.lastIndexOf(')');
  const pid = Number(raw.slice(0, raw.indexOf(' ')));
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const started = Number(fields[19]);
  if (
    close < 0 ||
    ![pid, parentPid, started].every(Number.isSafeInteger) ||
    pid < 1
  )
    throw new Error('Invalid proc process identity');
  return { pid, parentPid, started };
}

/** Used only when a minimal Linux installation has no ps binary. */
export async function procProcesses(
  signal: AbortSignal,
): Promise<PortProcess[]> {
  const rows: PortProcess[] = [];
  const directory = await opendir('/proc');
  let count = 0;
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (!/^\d+$/.test(entry.name)) continue;
    if (++count > MAX_PORT_PROCESSES)
      throw new Error('Process table exceeds the discovery limit');
    try {
      rows.push(
        parseProcProcess(
          await readBounded(`/proc/${entry.name}/stat`, 8192, signal),
        ),
      );
    } catch (error) {
      if (!vanished(error)) throw error;
    }
  }
  return rows;
}

export interface ProcListener {
  readonly inode: string;
  readonly host: string;
  readonly port: number;
}

export function parseProcListeners(
  raw: string,
  littleEndian = endianness() === 'LE',
): ProcListener[] {
  const rows: ProcListener[] = [];
  for (const line of raw.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A') continue;
    const match = /^([a-f\d]{8}|[a-f\d]{32}):([a-f\d]{4})$/i.exec(fields[1]);
    if (!match || !/^\d+$/.test(fields[9]))
      throw new Error('Invalid proc listener');
    const bytes = Buffer.from(match[1], 'hex');
    if (littleEndian) bytes.swap32();
    const address =
      bytes.length === 4
        ? [...bytes].join('.')
        : Array.from({ length: 8 }, (_, index) =>
            bytes.readUInt16BE(index * 2).toString(16),
          ).join(':');
    const host = listenerHost(address);
    const port = Number.parseInt(match[2], 16);
    if (host && port > 0) rows.push({ host, port, inode: fields[9] });
  }
  return rows;
}

/** Read sockets only for owned descendants. No whole-machine fd/environment scan. */
export async function procListeners(
  pids: readonly number[],
  signal: AbortSignal,
): Promise<SocketListener[]> {
  const tables = await Promise.allSettled(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((path) =>
      readBounded(path, 4 * 1024 * 1024, signal),
    ),
  );
  const listeners = new Map<string, ProcListener[]>();
  let readable = false;
  for (const result of tables) {
    if (result.status === 'rejected') {
      if (!vanished(result.reason)) throw result.reason;
      continue;
    }
    readable = true;
    for (const listener of parseProcListeners(result.value)) {
      const existing = listeners.get(listener.inode) ?? [];
      existing.push(listener);
      listeners.set(listener.inode, existing);
    }
  }
  if (!readable) throw new Error('Proc listener tables unavailable');
  if (!listeners.size) return [];
  const rows: SocketListener[] = [];
  let budget = 50_000;
  for (let offset = 0; offset < pids.length; offset += 16) {
    const results = await Promise.allSettled(
      pids.slice(offset, offset + 16).map(async (pid) => {
        try {
          signal.throwIfAborted();
          const directory = await opendir(`/proc/${pid}/fd`);
          for await (const entry of directory) {
            signal.throwIfAborted();
            if (--budget < 0)
              throw new Error('Socket descriptors exceed the discovery limit');
            let link: string;
            try {
              link = await readlink(`/proc/${pid}/fd/${entry.name}`);
            } catch (error) {
              if (vanished(error)) continue;
              throw error;
            }
            const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
            if (inode)
              for (const listener of listeners.get(inode) ?? [])
                rows.push({ pid, host: listener.host, port: listener.port });
          }
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }),
    );
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  }
  return rows;
}

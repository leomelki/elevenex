import {
  listenerHost,
  MAX_PORT_PROCESSES,
  portCommand,
  type PortProcess,
} from './port-processes.js';

export function parsePsProcesses(raw: string): PortProcess[] {
  const rows: PortProcess[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const started = match ? Date.parse(match[3] + ' UTC') : NaN;
    if (!match || !Number.isFinite(started))
      throw new Error('Invalid process table');
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), started });
    if (rows.length > MAX_PORT_PROCESSES)
      throw new Error('Process table exceeds the discovery limit');
  }
  if (!rows.length) throw new Error('Process table is unavailable');
  return rows;
}

export async function posixProcesses(
  signal: AbortSignal,
): Promise<PortProcess[]> {
  return parsePsProcesses(
    await portCommand('ps', ['-axo', 'pid=,ppid=,lstart='], signal),
  );
}

export interface SocketListener {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
}

export function parseLsofListeners(raw: string): SocketListener[] {
  const rows: SocketListener[] = [];
  let pid: number | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) {
      if (!/^p[1-9]\d*$/.test(line)) throw new Error('Invalid socket owner');
      pid = Number(line.slice(1));
    } else if (line.startsWith('n')) {
      const match = /^n(.+):(\d+)$/.exec(line);
      if (!match || pid === null) throw new Error('Invalid socket address');
      const host = listenerHost(match[1]);
      const port = Number(match[2]);
      if (host && port > 0 && port <= 65535) rows.push({ pid, host, port });
    }
  }
  return rows;
}

export async function lsofListeners(
  pids: readonly number[],
  signal: AbortSignal,
): Promise<SocketListener[]> {
  if (!pids.length) return [];
  // -a is essential: without it, -p and -i are ORed and unrelated listeners leak in.
  return parseLsofListeners(
    await portCommand(
      process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
      ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn'],
      signal,
      true,
    ),
  );
}

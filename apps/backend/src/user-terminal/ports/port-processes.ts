import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

export interface PortProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly started: number;
}

export interface TerminalListener {
  readonly pid: number;
  readonly started: number;
  readonly host: string;
  readonly port: number;
}

export const MAX_PORT_PROCESSES = 50_000;

/** Commands are fixed by the collectors; neither terminal input nor output is executable. */
export function portCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  emptyExit = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
        encoding: 'utf8',
        windowsHide: true,
        signal,
        timeout: 2500,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // lsof can exit 1 when only some requested PIDs have matching files
        // (a short-lived child may exit during the scan). Complete stdout is
        // still usable without diagnostics; limits/signals/other failures are not.
        if (error && !(emptyExit && error.code === 1 && !stderr.trim()))
          reject(
            new Error(
              `${file} failed (${String(error?.code ?? 'unknown')}): ${stderr.slice(0, 240)}`,
              { cause: error },
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

/** Only addresses reachable through loopback can be handed to Browser/SSH. */
export function listenerHost(address: string): string | null {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '*' || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '0:0:0:0:0:0:0:0') return '::1';
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return '::1';
  if (isIP(host) === 4 && host.startsWith('127.')) return host;
  const mapped = /^::ffff:(127\.\d+\.\d+\.\d+)$/.exec(host);
  return mapped && isIP(mapped[1]) === 4 ? mapped[1] : null;
}

/** One linear process-table walk, irrespective of the number of terminals. */
export function terminalProcessOwners(
  processes: readonly PortProcess[],
  roots: readonly number[],
): ReadonlyMap<number, number> {
  if (processes.length > MAX_PORT_PROCESSES)
    throw new Error('Process table exceeds the discovery limit');
  const table = new Map(processes.map((row) => [row.pid, row]));
  const children = new Map<number, PortProcess[]>();
  for (const row of processes) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row);
    children.set(row.parentPid, siblings);
  }
  const owners = new Map<number, number>();
  const queue: PortProcess[] = [];
  for (const pid of roots) {
    const root = table.get(pid);
    if (root) {
      owners.set(pid, pid);
      queue.push(root);
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    for (const child of children.get(parent.pid) ?? []) {
      // Parent PIDs can be reused after exit (notably on Windows). A process
      // cannot belong to a parent born after it. Visited rows also bound cycles.
      if (owners.has(child.pid) || child.started < parent.started) continue;
      owners.set(child.pid, owners.get(parent.pid)!);
      queue.push(child);
    }
  }
  return owners;
}

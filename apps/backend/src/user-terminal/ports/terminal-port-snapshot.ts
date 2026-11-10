import { lsofListeners, posixProcesses } from './posix-port-snapshot.js';
import { procListeners, procProcesses } from './linux-port-snapshot.js';
import { windowsListeners, windowsProcesses } from './windows-port-snapshot.js';
import {
  terminalProcessOwners,
  type TerminalListener,
} from './port-processes.js';

export interface TerminalPortSnapshot {
  readonly roots: ReadonlyMap<number, number>;
  readonly listeners: ReadonlyMap<number, readonly TerminalListener[]>;
}

export type TerminalPortScan = (
  roots: readonly number[],
  signal: AbortSignal,
) => Promise<TerminalPortSnapshot>;

export const scanTerminalPorts: TerminalPortScan = async (roots, signal) => {
  const processes =
    process.platform === 'win32'
      ? await windowsProcesses(signal)
      : await posixProcesses(signal).catch((error: unknown) => {
          if (process.platform !== 'linux' || signal.aborted) throw error;
          return procProcesses(signal);
        });
  const owners = terminalProcessOwners(processes, roots);
  if (owners.size > 4096) throw new Error('Terminal process limit exceeded');
  const pids = [...owners.keys()];
  const sockets =
    process.platform === 'win32'
      ? await windowsListeners(signal)
      : process.platform === 'linux'
        ? await procListeners(pids, signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return lsofListeners(pids, signal);
          })
        : await lsofListeners(pids, signal);
  signal.throwIfAborted();
  const table = new Map(processes.map((row) => [row.pid, row]));
  const listeners = new Map<number, TerminalListener[]>();
  const identities = new Map<number, number>();
  for (const pid of roots) {
    const root = table.get(pid);
    if (root) identities.set(pid, root.started);
    listeners.set(pid, []);
  }
  for (const socket of sockets) {
    const root = owners.get(socket.pid);
    const process = table.get(socket.pid);
    if (root === undefined || !process) continue;
    listeners.get(root)!.push({ ...socket, started: process.started });
  }
  return { roots: identities, listeners };
};

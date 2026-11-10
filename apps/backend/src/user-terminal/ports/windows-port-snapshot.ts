import {
  listenerHost,
  MAX_PORT_PROCESSES,
  portCommand,
  type PortProcess,
} from './port-processes.js';
import type { SocketListener } from './posix-port-snapshot.js';

// CIM replaces removed wmic.exe. Read identity/ancestry only, never command lines
// or environments, which may contain credentials. There is no interpolated input.
const PROCESS_QUERY =
  "$ErrorActionPreference='Stop'; " +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
  "ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f " +
  '$_.ProcessId,$_.ParentProcessId,([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }';

export function parseWindowsProcesses(raw: string): PortProcess[] {
  const rows: PortProcess[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error('Invalid Windows process table');
    const [pid, parentPid, started] = match.slice(1).map(Number);
    if (![pid, parentPid, started].every(Number.isSafeInteger))
      throw new Error('Invalid Windows process identity');
    rows.push({ pid, parentPid, started });
    if (rows.length > MAX_PORT_PROCESSES)
      throw new Error('Process table exceeds the discovery limit');
  }
  if (!rows.length) throw new Error('Process table is unavailable');
  return rows;
}

export async function windowsProcesses(
  signal: AbortSignal,
): Promise<PortProcess[]> {
  return parseWindowsProcesses(
    await portCommand(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY],
      signal,
    ),
  );
}

export function parseWindowsListeners(raw: string): SocketListener[] {
  const rows: SocketListener[] = [];
  let foundHeader = false;
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'Proto') foundHeader = true;
    if (fields[0] !== 'TCP') continue;
    // netstat -ano (without -q) includes remote port zero only for listeners.
    // This avoids depending on localized LISTENING/State labels.
    if (fields.length !== 5) throw new Error('Invalid Windows listener');
    const local = /^(.+):(\d+)$/.exec(fields[1]);
    const remote = /^(.+):(\d+)$/.exec(fields[2]);
    if (!local || !remote || !/^\d+$/.test(fields[4]))
      throw new Error('Invalid Windows listener address');
    if (Number(remote[2]) !== 0) continue;
    const host = listenerHost(local[1]);
    const port = Number(local[2]);
    const pid = Number(fields[4]);
    if (
      host &&
      port > 0 &&
      port <= 65535 &&
      Number.isSafeInteger(pid) &&
      pid > 0
    )
      rows.push({ pid, port, host });
  }
  // Nonempty command errors must never masquerade as a successful empty scan.
  if (!foundHeader && !rows.length)
    throw new Error('Windows listeners unavailable');
  return rows;
}

export async function windowsListeners(
  signal: AbortSignal,
): Promise<SocketListener[]> {
  return parseWindowsListeners(
    await portCommand('netstat.exe', ['-ano'], signal),
  );
}

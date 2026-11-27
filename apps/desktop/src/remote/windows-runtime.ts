import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const system32 = () => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');

/** OpenSSH sessions have no interactive window station. The installer registers
 * a per-user task with InteractiveToken and Limited privileges. Task Scheduler
 * starts the daemon on the logged-in user's desktop without storing a password. */
export async function startWindowsRuntime(signal?: AbortSignal): Promise<void> {
  const task = process.env['ELEVENEX_WINDOWS_RUNTIME_TASK'];
  if (!task || !/^Elevenex Desktop [A-Za-z0-9 -]{1,200}$/.test(task))
    throw new Error('EX11_CONFIGURATION: missing per-user Windows runtime task');
  try {
    await execute(join(system32(), 'schtasks.exe'),
      ['/Run', '/TN', task], { windowsHide: true, signal, timeout: 5000, maxBuffer: 8192 });
  } catch {
    throw new Error('EX11_COMPATIBILITY: Windows interactive runtime unavailable; sign in to the host with the SSH account');
  }
}

/** CSV rows from tasklist, which prints a localized notice (no quoted row) when nothing matches. */
export function listsProcesses(output: string): boolean {
  return output.split(/\r?\n/).some(line => line.startsWith('"'));
}

/**
 * Task Scheduler accepts a run request for an interactive task while the user
 * is signed out and then never starts it, so check for a desktop session first.
 * SSH sessions run in session 0; any process of this account in another
 * session means a console or Remote Desktop sign-in (including a locked or
 * disconnected one) where the scheduler can start the runtime.
 */
export async function desktopSessionAvailable(signal?: AbortSignal): Promise<boolean> {
  const user = process.env['USERNAME']; const domain = process.env['USERDOMAIN'];
  if (!user || !domain || /["\\]/.test(user + domain)) throw new Error('EX11_CONFIGURATION: missing Windows account identity');
  try {
    const { stdout } = await execute(join(system32(), 'tasklist.exe'),
      ['/FI', `USERNAME eq ${domain}\\${user}`, '/FI', 'SESSION ne 0', '/FO', 'CSV', '/NH'],
      { windowsHide: true, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return listsProcesses(stdout);
  } catch (error) {
    signal?.throwIfAborted();
    // A very busy desktop can exceed the output bound; that still proves a session.
    if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
    throw new Error('EX11_CONFIGURATION: the Windows desktop session could not be checked', { cause: error });
  }
}

export interface BackgroundRuntime { readonly root: string; readonly installation: string; readonly version: string; readonly runtime: string }

/**
 * OpenSSH ends every process in a session's job when the connection closes.
 * WMI creates the daemon outside that job, as this account in session 0. It has
 * no desktop, so the backend reports apps as needing a Windows sign-in.
 */
export async function startBackgroundRuntime(target: BackgroundRuntime, signal?: AbortSignal): Promise<void> {
  // Windows paths cannot contain a double quote; every argument is quoted.
  const commandLine = [process.execPath, target.runtime, 'daemon-background', target.root, target.installation, target.version].map(value => `"${value}"`).join(' ');
  const script = "$ErrorActionPreference='Stop'\n"
    + '$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine=$env:EX11_COMMAND_LINE; CurrentDirectory=$env:EX11_DIRECTORY }\n'
    + 'if ($r.ReturnValue -ne 0) { exit 1 }';
  try {
    await execute(join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, signal, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, EX11_COMMAND_LINE: commandLine, EX11_DIRECTORY: target.root } });
  } catch {
    signal?.throwIfAborted();
    throw new Error('EX11_CONFIGURATION: the background Windows runtime could not be started');
  }
}

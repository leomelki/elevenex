import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** OpenSSH sessions have no interactive window station. The installer registers
 * a per-user task with InteractiveToken and Limited privileges. Task Scheduler
 * starts the daemon on the logged-in user's desktop without storing a password. */
export async function startWindowsRuntime(signal?: AbortSignal): Promise<void> {
  const task = process.env['ELEVENEX_WINDOWS_RUNTIME_TASK'];
  if (!task || !/^Elevenex Desktop [A-Za-z0-9 -]{1,200}$/.test(task))
    throw new Error('EX11_CONFIGURATION: missing per-user Windows runtime task');
  try {
    await execute(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'schtasks.exe'),
      ['/Run', '/TN', task], { windowsHide: true, signal, timeout: 5000, maxBuffer: 8192 });
  } catch {
    throw new Error('EX11_COMPATIBILITY: Windows interactive runtime unavailable; sign in to the host with the SSH account');
  }
}

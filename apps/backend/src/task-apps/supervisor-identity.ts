import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function supervisorBoot(): Promise<string> {
  const value =
    process.platform === 'linux'
      ? await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      : (
          await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
            timeout: 2500,
            maxBuffer: 128,
          })
        ).stdout;
  const boot = value.trim().toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot))
    throw new Error('Invalid OS boot identity');
  return process.platform + ':' + boot;
}

/** Return null only when the process is gone. An unreadable live process keeps
 * its recovery reservation. A PID is never used as authority to send a signal. */
export async function supervisorBirth(
  pid: number,
  readBoot = supervisorBoot,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Invalid supervisor PID');
  const exists = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!exists()) return null;
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([
        readFile('/proc/' + pid + '/stat', 'utf8'),
        readBoot(),
      ]);
      // comm can contain spaces and parentheses. starttime is field 22.
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      if (!/^\d+$/.test(fields[19] ?? '')) throw new Error();
      return boot + ':' + fields[19];
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execute(
        '/bin/ps',
        ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='],
        { env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2500, maxBuffer: 1024 },
      );
      const match =
        /^([A-Za-z+<>Ns]+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})$/.exec(
          stdout.trim(),
        );
      if (!match) throw new Error();
      if (match[1].startsWith('Z')) return null;
      return (await readBoot()) + ':' + match[2].replace(/\s+/g, ' ');
    }
    if (process.platform === 'win32') {
      const powershell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const { stdout } = await execute(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ErrorActionPreference="Stop"; [Console]::Write((Get-Process -Id ' +
            pid +
            ').StartTime.ToUniversalTime().Ticks)',
        ],
        { timeout: 5000, maxBuffer: 1024, windowsHide: true },
      );
      if (!/^\d{10,20}$/.test(stdout.trim())) throw new Error();
      return 'win32:' + stdout.trim();
    }
  } catch {
    if (!exists()) return null;
  }
  throw new Error('Could not verify the app supervisor process identity.');
}

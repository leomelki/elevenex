import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const avdName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function androidArguments(avd: string, data: string): string[] {
  return [
    '-avd',
    avd,
    '-datadir',
    data,
    '-read-only',
    '-no-snapshot',
    '-no-audio',
    '-camera-front',
    'none',
    '-camera-back',
    'none',
  ];
}

/** Use the SDK-owned emulator. Keep probes outside the checkout and bounded. */
export async function prepareAndroidApp(
  avd: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
) {
  if (!avdName.test(avd))
    throw new Error('Invalid Android virtual device name.');
  const home = homedir();
  const platformDefault =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Android', 'sdk')
      : process.platform === 'win32'
        ? join(
            environment.LOCALAPPDATA || join(home, 'AppData', 'Local'),
            'Android',
            'Sdk',
          )
        : join(home, 'Android', 'Sdk');
  const sdk =
    environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT || platformDefault;
  if (!isAbsolute(sdk))
    throw new Error(
      'Configure ANDROID_HOME as an absolute SDK directory on the task machine.',
    );
  const executable = join(
    sdk,
    'emulator',
    process.platform === 'win32' ? 'emulator.exe' : 'emulator',
  );
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(
      'Install the Android SDK Emulator on the task machine and configure ANDROID_HOME.',
    );
  }
  const options = {
    cwd: sdk,
    env: environment,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    encoding: 'utf8' as const,
  };
  const [devices, acceleration] = await Promise.all([
    execute(executable, ['-list-avds'], options),
    execute(executable, ['-accel-check'], options).catch(() => null),
  ]);
  if (!devices.stdout.split(/\r?\n/).includes(avd))
    throw new Error(
      `Android virtual device "${avd}" is unavailable. Check emulator -list-avds on the task machine.`,
    );
  if (!acceleration || !/^accel:\s*0(?:\s|$)/m.test(acceleration.stdout))
    throw new Error(
      'The Android Emulator cannot use a hypervisor. Check emulator -accel-check on the task machine.',
    );
  const data = join(directory, 'avd-data');
  await mkdir(data, { mode: 0o700 });
  // The emulator atomically chooses its own available console/ADB port pair.
  // No control endpoint is opened or forwarded by Elevenex.
  return {
    executable,
    args: androidArguments(avd, data),
    env: { ANDROID_HOME: sdk },
  };
}

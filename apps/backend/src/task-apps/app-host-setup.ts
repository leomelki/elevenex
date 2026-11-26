import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { AppSetupError } from './app-setup-error.js';
import { DarwinAppDisplay, type DarwinAppSession } from './darwin-display.js';
import { WindowsAppDisplay } from './windows-display.js';

export interface AppHostReady {
  readonly darwinSession?: DarwinAppSession;
}

// Use the same system search path as the private Linux display supervisor.
export const LINUX_APP_PROGRAM_PATH = '/usr/bin:/bin:/usr/local/bin';

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true, () => false);
}

export async function prepareAppHost(mode: 'native' | 'stream'): Promise<AppHostReady> {
  if (process.platform === 'darwin' && mode === 'stream')
    return { darwinSession: await DarwinAppDisplay.preflight() };
  if (process.platform === 'win32' && mode === 'stream')
    await WindowsAppDisplay.preflight();
  if (process.platform === 'linux') {
    if (mode === 'native' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      throw new AppSetupError('linux-session', 'Sign in to the graphical desktop or request a streamed launch.');
    const requirements = [
      { name: 'Python 3 at /usr/bin/python3', available: executable('/usr/bin/python3') },
      ...(mode === 'stream' ? ['Xvfb', 'dbus-daemon'].map(name => ({
        name,
        available: Promise.all(LINUX_APP_PROGRAM_PATH.split(':').map(root => executable(`${root}/${name}`)))
          .then(results => results.some(Boolean)),
      })) : []),
    ];
    const missing = (await Promise.all(requirements.map(async ({ name, available }) =>
      await available ? null : name))).filter(Boolean);
    if (missing.length)
      throw new AppSetupError('linux-display-tools', `Missing on the task machine: ${missing.join(', ')}.`);
  }
  return {};
}

import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { BackendManagerOptions } from './manager';
import { backendRelease } from './release';

/** Launcher-only configuration. Packaged apps always use verified releases. */
export function developmentBackend(
  isPackaged: boolean, env: NodeJS.ProcessEnv = process.env,
): Pick<BackendManagerOptions, 'release' | 'install'> | undefined {
  if (isPackaged || env['ELEVENEX_DESKTOP_DEV_BACKEND'] === undefined) return undefined;
  const directory = env['ELEVENEX_DESKTOP_DEV_BACKEND'];
  const executable = env['ELEVENEX_DESKTOP_DEV_NODE'];
  const paths = () => {
    if (!directory || !isAbsolute(directory) || !executable || !isAbsolute(executable)) {
      throw new Error('The desktop development launcher requires absolute backend and Node paths');
    }
    return { directory, executable, entry: join(directory, 'main.cjs') };
  };
  return {
    release: async () => {
      const metadata: unknown = JSON.parse(await readFile(join(paths().directory, 'backend-release.json'), 'utf8'));
      return backendRelease(metadata, process.platform, process.arch);
    },
    install: async (_root, _release, signal) => {
      signal.throwIfAborted();
      const installation = paths();
      for (const file of [installation.entry, installation.executable]) {
        if (!(await stat(file)).isFile()) throw new Error('Local development backend is incomplete; restart pnpm desktop:dev');
      }
      await access(installation.executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      signal.throwIfAborted();
      return installation;
    },
  };
}

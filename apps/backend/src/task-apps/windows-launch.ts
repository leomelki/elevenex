import { access, open } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

interface LaunchCommand {
  executable: string;
  args: readonly string[];
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Standard package managers on Windows often install a cmd shim. Select its
 * known Node entry point and preserve every original argument through CreateProcessW. */
export async function windowsLaunchCommand(
  command: LaunchCommand,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<LaunchCommand> {
  const name = basename(command.executable)
    .toLowerCase()
    .replace(/\.cmd$/, '');
  if (!['pnpm', 'npm', 'npx', 'yarn', 'corepack'].includes(name)) {
    if (/\.(?:cmd|bat)$/i.test(command.executable))
      throw new Error(
        'This batch file needs an explicit shell command on Windows.',
      );
    return command;
  }
  if (/^[a-z]:/i.test(command.executable) && !isAbsolute(command.executable))
    throw new Error('Use an absolute Windows drive path or a path relative to the task.');
  // A path supplied in a launch proposal belongs to the task checkout. A
  // different package manager with the same basename on PATH is a different command.
  const explicitPath = isAbsolute(command.executable) || /[\\/]/.test(command.executable);
  const directories = explicitPath
    ? [dirname(resolve(cwd, command.executable))]
    : (env.PATH ?? env.Path ?? '').split(';').filter(isAbsolute).slice(0, 64);
  const entryNames: Record<string, string[]> = {
    pnpm: [
      'node_modules/pnpm/bin/pnpm.cjs',
      'node_modules/corepack/dist/pnpm.js',
    ],
    npm: [
      'node_modules/npm/bin/npm-cli.js',
      'node_modules/corepack/dist/npm.js',
    ],
    npx: [
      'node_modules/npm/bin/npx-cli.js',
      'node_modules/corepack/dist/npx.js',
    ],
    yarn: [
      'node_modules/yarn/bin/yarn.js',
      'node_modules/corepack/dist/yarn.js',
    ],
    corepack: ['node_modules/corepack/dist/corepack.js'],
  };
  for (const directory of directories) {
    const binary = join(directory, name + '.exe');
    if (
      extname(command.executable).toLowerCase() !== '.cmd' &&
      (await exists(binary))
    )
      return { executable: binary, args: command.args };
    const shim = await open(join(directory, name + '.cmd'), 'r').catch(
      () => undefined,
    );
    if (!shim) continue;
    let description = '';
    try {
      const bytes = Buffer.alloc(8192);
      const { bytesRead } = await shim.read(bytes, 0, bytes.length, 0);
      description = bytes
        .subarray(0, bytesRead)
        .toString('utf8')
        .toLowerCase()
        .replaceAll('\\', '/');
    } finally {
      await shim.close();
    }
    for (const entry of entryNames[name]) {
      const path = join(directory, entry);
      if (!description.includes(entry) || !(await exists(path))) continue;
      const node = join(directory, 'node.exe');
      return {
        executable: (await exists(node)) ? node : 'node.exe',
        args: [path, ...command.args],
      };
    }
    throw new Error(
      'Unsupported ' +
        name +
        ' launcher. Supply its Node entry point and arguments.',
    );
  }
  if (explicitPath)
    throw new Error('The requested Windows package-manager launcher is unavailable at that path.');
  return command;
}

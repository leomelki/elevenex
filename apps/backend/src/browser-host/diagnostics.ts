import { readFile } from 'node:fs/promises';
import { probeHostCommand } from './process.js';

export const APPARMOR_RESTRICTION =
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export async function appArmorRestricted(): Promise<boolean> {
  try {
    return (await readFile(APPARMOR_RESTRICTION, 'utf8')).trim() === '1';
  } catch {
    return false;
  }
}

/** Check the actual loader first: ldd alone falsely reports dependencies that
 * nix-ld or another configured loader can supply. Only expose validated sonames. */
export async function browserLibraries(
  executable: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const version = await probeHostCommand(executable, ['--version'], signal);
  if (version.code === 0) return [];
  const missing =
    /error while loading shared libraries:\s*([A-Za-z0-9_.+-]{1,96}):/.exec(
      version.output,
    )?.[1];
  if (!missing) return [];
  const linked = await probeHostCommand('ldd', [executable], signal);
  const libraries = [
    ...linked.output.matchAll(
      /^\s*([A-Za-z0-9_.+-]{1,96})\s+=> not found\s*$/gm,
    ),
  ].map((match) => match[1]);
  return [...new Set(libraries.length ? libraries : [missing])].slice(0, 32);
}

export async function browserFontsAvailable(
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await probeHostCommand(
    'fc-match',
    ['--format=%{file}', 'sans-serif'],
    signal,
  );
  return result.code === 0 && result.output.trim().length > 0;
}

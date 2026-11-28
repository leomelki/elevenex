import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { appArmorRestricted } from './diagnostics.js';
import { probeHostCommand, runHostStep } from './process.js';

// Keep the small Chromium runtime set separate from Playwright's test/desktop
// dependencies (GTK, Xvfb, etc.). Use distro packages so their security updates
// remain owned by the host package manager, never private copied .so files.
const LIBRARY_PACKAGES: readonly (readonly string[])[] = [
  ['libnss3'],
  ['libnspr4'],
  ['libglib2.0-0t64', 'libglib2.0-0'],
  ['libatk1.0-0t64', 'libatk1.0-0'],
  ['libatk-bridge2.0-0t64', 'libatk-bridge2.0-0'],
  ['libatspi2.0-0t64', 'libatspi2.0-0'],
  ['libdbus-1-3'],
  ['libcups2t64', 'libcups2'],
  ['libx11-6'],
  ['libxcb1'],
  ['libxcomposite1'],
  ['libxdamage1'],
  ['libxext6'],
  ['libxfixes3'],
  ['libxrandr2'],
  ['libxkbcommon0'],
  ['libgbm1'],
  ['libasound2t64', 'libasound2'],
  ['libexpat1'],
  ['libcairo2'],
  ['libpango-1.0-0'],
  ['fontconfig'],
  ['fonts-liberation'],
];

export async function missingBrowserPackages(
  signal: AbortSignal,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const alternatives of LIBRARY_PACKAGES) {
    signal.throwIfAborted();
    let installed = false;
    for (const name of alternatives) {
      const status = await probeHostCommand(
        'dpkg-query',
        ['-W', '-f=${db:Status-Status}', name],
        signal,
      );
      if (status.code === 0 && status.output.trim() === 'installed') {
        installed = true;
        break;
      }
    }
    if (installed) continue;
    let candidate: string | undefined;
    for (const name of alternatives) {
      const policy = await probeHostCommand(
        'apt-cache',
        ['policy', name],
        signal,
      );
      const offered = /Candidate:\s*(\S+)/.exec(policy.output)?.[1];
      if (offered && offered !== '(none)') {
        candidate = name;
        break;
      }
    }
    if (!candidate)
      throw new Error(
        `No browser dependency package is available for ${alternatives.join(' / ')}. Configure the host package repositories or install the libraries with its package manager.`,
      );
    missing.push(candidate);
  }
  return missing;
}

const PROFILE_HEADER = '# Managed by Elevenex browser host setup.\n';

export function browserAppArmorProfile(executable: string): {
  name: string;
  content: string;
} {
  // AppArmor's quoted attachments still expand policy metacharacters. Refuse
  // unusual paths instead of accidentally granting a wildcard or injected rule.
  if (
    !executable.startsWith('/') ||
    Array.from(executable).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        '"\\*?[]{}^'.includes(character),
    )
  )
    throw new Error(
      'The browser path cannot be represented safely in an AppArmor attachment. Use an application data path without policy metacharacters.',
    );
  const name =
    'elevenex-browser-' +
    createHash('sha256').update(executable).digest('hex').slice(0, 16);
  return {
    name,
    content: `${PROFILE_HEADER}abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n  include if exists <local/${name}>\n}\n`,
  };
}

/** Exact executable attachment, atomic publication and rollback. Never overwrite
 * administrator-owned policy, follow a policy symlink or change global sysctls. */
export async function installBrowserAppArmorProfile(
  executable: string,
  signal: AbortSignal,
  directory = '/etc/apparmor.d',
): Promise<void> {
  const profile = browserAppArmorProfile(await realpath(executable));
  const destination = join(directory, profile.name);
  let previous: string | undefined;
  try {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Browser AppArmor policy is not a regular file.');
    previous = await readFile(destination, 'utf8');
    if (!previous.startsWith(PROFILE_HEADER))
      throw new Error(
        'Refusing to replace an administrator-owned AppArmor policy.',
      );
  } catch (error: unknown) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    )
      throw error;
  }
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, profile.content, { flag: 'wx', mode: 0o644 });
    // Compile before publishing. -Q skips kernel load; -T skips reading caches.
    await runHostStep('apparmor_parser', ['-Q', '-T', temporary], signal);
    await rename(temporary, destination);
    try {
      await runHostStep('apparmor_parser', ['-r', destination], signal);
    } catch (error: unknown) {
      if (previous === undefined) {
        // The parser may have loaded the policy before its receipt was
        // interrupted. Reconcile kernel state before removing the new file.
        await runHostStep(
          'apparmor_parser',
          ['-R', destination],
          AbortSignal.timeout(10000),
        ).catch(() => undefined);
        await rm(destination, { force: true });
      } else {
        await writeFile(temporary, previous, { flag: 'wx', mode: 0o644 });
        await rename(temporary, destination);
        // Restore the previous loaded policy even when the caller interrupted.
        await runHostStep(
          'apparmor_parser',
          ['-r', destination],
          AbortSignal.timeout(10000),
        );
      }
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function provisionLinuxBrowserHost(
  executable: string,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('System provisioning requires an administrator on Linux.');
  const apt = await probeHostCommand('apt-get', ['--version'], signal);
  if (apt.code !== 0)
    throw new Error(
      'Automatic library provisioning supports apt-based distributions. Install Chromium libraries, fontconfig and system fonts with this host’s package manager, then run browser setup --check.',
    );
  // Explicit administrative command, not a browser/viewer connection. Refresh
  // once so package alternatives are selected from current repository metadata.
  await runHostStep('apt-get', ['update'], signal);
  const packages = await missingBrowserPackages(signal);
  if (packages.length)
    await runHostStep(
      'apt-get',
      ['install', '-y', '--no-install-recommends', ...packages],
      signal,
    );
  if (await appArmorRestricted())
    await installBrowserAppArmorProfile(executable, signal);
}

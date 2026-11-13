import {
  appArmorRestricted,
  browserLibraries,
} from '../browser-host/diagnostics.js';
import { browserSetupCommand } from '../browser-host/paths.js';

const startupMessages = {
  dependencies: 'Chromium is missing required host libraries.',
  fonts: 'Chromium needs fontconfig and system fonts to render text.',
  apparmor:
    'AppArmor blocked Chromium’s sandbox. Host setup can install a policy for this browser.',
  root: 'Chromium cannot run securely as root. Run the backend as a non-root user; host setup cannot fix this restriction.',
  sandbox:
    'The host blocked Chromium’s sandbox. Check OS namespaces and container/seccomp policy. No sandbox bypass is used.',
  incompatible:
    'Chromium is incompatible with this host OS or CPU. Use a supported OS and architecture, then Reload.',
  permissions:
    'Chromium cannot access its executable or application data. Check host permissions and noexec mounts, then Reload.',
  profile:
    'The task browser profile is already in use. Close the other backend using this data directory, then Reload.',
  download:
    'Chromium could not be downloaded. Check the browser host connection, proxy, certificates and disk space, then Reload.',
  unavailable:
    'The host could not start Chromium. Browser setup can diagnose its libraries and sandbox.',
} as const;

/** Only fixed, actionable diagnostics cross the viewer boundary. Playwright errors
 * include argv, profile paths and potentially private proxy/browser output. */
export class RuntimeBrowserStartError extends Error {
  readonly setupCommand?: string;
  constructor(
    readonly reason: keyof typeof startupMessages,
    libraries: readonly string[] = [],
  ) {
    const setupCommand = [
      'dependencies',
      'fonts',
      'apparmor',
      'unavailable',
    ].includes(reason)
      ? browserSetupCommand()
      : undefined;
    const names = libraries
      .filter((name) => /^[A-Za-z0-9_.+-]{1,96}$/.test(name))
      .slice(0, 3)
      .join(', ')
      .slice(0, 100);
    const detail =
      startupMessages[reason] + (names ? ` Missing: ${names}.` : '');
    const recovery = setupCommand ? ` Run: ${setupCommand}` : '';
    // Older desktops accept at most 400 characters. Never truncate a command
    // into something unsafe or unusable; the backend log retains the full one.
    super(
      detail +
        (detail.length + recovery.length <= 400
          ? recovery
          : ' See the backend log for the exact browser setup command.'),
    );
    this.setupCommand = setupCommand;
    this.name = 'RuntimeBrowserStartError';
  }
}

export function browserStartError(error: unknown): RuntimeBrowserStartError {
  if (error instanceof RuntimeBrowserStartError) return error;
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : '';
  if (
    /error while loading shared libraries|host system is missing dependencies|missing libraries:|Library not loaded:/i.test(
      message,
    )
  )
    return new RuntimeBrowserStartError('dependencies');
  if (
    /GLIBC(?:XX)?_[\d.]+.*not found|Exec format error|bad CPU type|wrong ELF class|not supported on this host/i.test(
      message,
    )
  )
    return new RuntimeBrowserStartError('incompatible');
  if (/Running as root without --no-sandbox/.test(message))
    return new RuntimeBrowserStartError('root');
  if (
    /No usable sandbox|Chromium sandboxing failed|Running as root without --no-sandbox|Failed to move to new namespace|Failed to unshare|SUID sandbox|sandbox.*(?:permission|not permitted)|apparmor/i.test(
      message,
    )
  )
    return new RuntimeBrowserStartError('sandbox');
  if (
    /ProcessSingleton|SingletonLock|profile.*(?:in use|already used)/i.test(
      message,
    )
  )
    return new RuntimeBrowserStartError('profile');
  if (/EACCES|EPERM|permission denied|read-only file system/i.test(message))
    return new RuntimeBrowserStartError('permissions');
  return new RuntimeBrowserStartError('unavailable');
}

/** A launch error can be rewritten by Playwright. Diagnose the actual executable,
 * and distinguish AppArmor from other kernel/container sandbox restrictions. */
export async function diagnoseBrowserStartFailure(
  error: unknown,
  executable: string,
  signal: AbortSignal,
): Promise<RuntimeBrowserStartError> {
  signal.throwIfAborted();
  if (process.platform === 'linux' && process.getuid?.() === 0)
    return new RuntimeBrowserStartError('root');
  const failure = browserStartError(error);
  if (process.platform !== 'linux') return failure;
  if (failure.reason === 'sandbox')
    return (await appArmorRestricted())
      ? new RuntimeBrowserStartError('apparmor')
      : failure;
  if (failure.reason === 'dependencies' || failure.reason === 'unavailable') {
    const libraries = await browserLibraries(executable, signal);
    signal.throwIfAborted();
    if (libraries.length)
      return new RuntimeBrowserStartError('dependencies', libraries);
  }
  return failure;
}

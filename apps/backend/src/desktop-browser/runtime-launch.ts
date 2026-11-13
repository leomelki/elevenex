import { chromium, type BrowserContext } from 'playwright-core';
import { access } from 'node:fs/promises';
import { managedBrowserExecutable } from '../browser-host/paths.js';
import {
  browserStartError,
  diagnoseBrowserStartFailure,
  RuntimeBrowserStartError,
} from './runtime-start-error.js';

type LaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

/** Prefer app-owned Chromium, but allow an already provisioned Playwright cache
 * (including PLAYWRIGHT_BROWSERS_PATH) and the existing system Chrome fallback.
 * Installing Chromium cannot repair missing OS libraries, sandbox or permissions. */
export async function launchRuntimeBrowser(
  cache: string,
  profile: string,
  options: LaunchOptions,
  install: () => Promise<void>,
  signal: AbortSignal,
): Promise<BrowserContext> {
  const configured = chromium.executablePath();
  if (process.platform === 'linux' && process.getuid?.() === 0)
    throw new RuntimeBrowserStartError('root');
  let managed: string;
  try {
    managed = managedBrowserExecutable(cache, configured);
  } catch {
    throw new RuntimeBrowserStartError('incompatible');
  }
  const failures: unknown[] = [];
  let firstExecutable: string | undefined;
  for (const executablePath of new Set([managed, configured])) {
    signal.throwIfAborted();
    try {
      await access(executablePath);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        continue;
      throw browserStartError(error);
    }
    firstExecutable ??= executablePath;
    try {
      return await chromium.launchPersistentContext(profile, {
        ...options,
        executablePath,
      });
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  signal.throwIfAborted();
  try {
    return await chromium.launchPersistentContext(profile, {
      ...options,
      channel: 'chrome',
    });
  } catch (error: unknown) {
    failures.push(error);
  }
  signal.throwIfAborted();
  if (firstExecutable)
    throw await diagnoseBrowserStartFailure(
      failures[0],
      firstExecutable,
      signal,
    );
  // No distribution exists. The pool coalesces installs across concurrent tasks.
  // Dependency/package-manager elevation is reserved for explicit host setup.
  try {
    await install();
  } catch (error: unknown) {
    signal.throwIfAborted();
    if (error instanceof RuntimeBrowserStartError) throw error;
    throw new RuntimeBrowserStartError('download');
  }
  signal.throwIfAborted();
  try {
    return await chromium.launchPersistentContext(profile, {
      ...options,
      executablePath: managed,
    });
  } catch (error: unknown) {
    throw await diagnoseBrowserStartFailure(error, managed, signal);
  }
}

/** Shared by task startup and the disposable host verification. */
export function browserLaunchOptions(extension: string): LaunchOptions {
  return {
    headless: true,
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: 30000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  };
}

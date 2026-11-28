import { chromium, type BrowserContext } from 'patchright-core';
import { access } from 'node:fs/promises';
import { managedBrowserExecutable } from '../browser-host/paths.js';
import {
  browserStartError,
  diagnoseBrowserStartFailure,
  RuntimeBrowserStartError,
} from './runtime-start-error.js';
import {
  chromeMajorVersion,
  type RuntimeUserAgents,
  userAgentArgs,
} from './runtime-user-agent.js';

type LaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;
type LaunchTarget = { executablePath: string } | { channel: 'chrome' };

/** Start one target with the User-Agent of its real version. A mismatch can only
 * come from an installed Chrome; it is corrected before any site is opened. */
async function launchTarget(
  profile: string,
  options: LaunchOptions,
  target: LaunchTarget,
  userAgents: RuntimeUserAgents,
  signal: AbortSignal,
): Promise<BrowserContext> {
  const key =
    'executablePath' in target
      ? target.executablePath
      : 'channel:' + target.channel;
  const launch = (major: number | undefined) =>
    chromium.launchPersistentContext(profile, {
      ...options,
      ...target,
      args: [...(options.args ?? []), ...userAgentArgs(major)],
    });
  const expected = await userAgents.expected(key);
  const context = await launch(expected);
  const actual = chromeMajorVersion(context.browser()?.version());
  if (actual === undefined || actual === expected) return context;
  userAgents.remember(key, actual);
  await context.close().catch(() => undefined);
  signal.throwIfAborted();
  return launch(actual);
}

/** Prefer app-owned Chromium, but allow an already provisioned Playwright cache
 * (including PLAYWRIGHT_BROWSERS_PATH) and the existing system Chrome fallback.
 * Installing Chromium cannot repair missing OS libraries, sandbox or permissions. */
export async function launchRuntimeBrowser(
  cache: string,
  profile: string,
  options: LaunchOptions,
  install: () => Promise<void>,
  signal: AbortSignal,
  userAgents: RuntimeUserAgents,
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
      return await launchTarget(
        profile,
        options,
        { executablePath },
        userAgents,
        signal,
      );
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  signal.throwIfAborted();
  try {
    return await launchTarget(
      profile,
      options,
      { channel: 'chrome' },
      userAgents,
      signal,
    );
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
    return await launchTarget(
      profile,
      options,
      { executablePath: managed },
      userAgents,
      signal,
    );
  } catch (error: unknown) {
    throw await diagnoseBrowserStartFailure(error, managed, signal);
  }
}

/**
 * Patchright keeps most of Playwright's test-oriented disabled features. Chromium
 * honors only the last `--disable-features` switch, so this list replaces the
 * driver's. It keeps what Playwright's request interception and page-close
 * handling rely on, `PaintHolding` for the screencast, and browser UI or
 * background services that have no headless surface. Third-party storage
 * partitioning, HTTPS-Upgrades and the Media Router (Presentation API) stay at
 * Chrome's defaults. Reconcile this list whenever the driver pin changes.
 */
const disabledChromiumFeatures = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  // Keeps the screencast from presenting the previous document after a commit.
  'PaintHolding',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'LensOverlay',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
];

/** Shared by task startup and the disposable host verification. */
export function browserLaunchOptions(extension: string): LaunchOptions {
  return {
    headless: true,
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: 30000,
    // Sites can measure hidden scrollbars. People see and drag real scrollbars
    // in the stream, and layout matches the host's ordinary Chrome.
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: [
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // Patchright also adds this; it is the task browser's own requirement.
      // Headless and the private CDP pipe otherwise set navigator.webdriver.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=' + disabledChromiumFeatures.join(','),
      // Patchright re-enables both. A back-forward cache restore fires no load
      // event, so Back/Forward navigation waits would time out. Headless has no
      // blocked-popup UI through which a person could allow a legitimate window.
      '--disable-back-forward-cache',
      '--disable-popup-blocking',
    ],
  };
}

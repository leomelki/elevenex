import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { getElevenexDataRoot } from '../config/app-data-paths.js';
import { browserLaunchOptions } from '../desktop-browser/runtime-launch.js';
import {
  diagnoseBrowserStartFailure,
  RuntimeBrowserStartError,
} from '../desktop-browser/runtime-start-error.js';
import { prepareWebAuthnExtension } from '../desktop-browser/runtime-webauthn-extension.js';
import { browserFontsAvailable } from './diagnostics.js';
import { provisionLinuxBrowserHost } from './linux-setup.js';
import {
  browserSetupCommand,
  managedBrowserExecutable,
  playwrightInstaller,
} from './paths.js';
import { runHostStep } from './process.js';

interface SetupOptions {
  readonly dataRoot: string;
  readonly check: boolean;
  readonly system: boolean;
  readonly help: boolean;
}
export function parseBrowserSetupArgs(args: readonly string[]): SetupOptions {
  let dataRoot: string | undefined;
  let check = false,
    system = false,
    help = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Repeated browser setup option: ${arg}`);
    seen.add(arg);
    if (arg === '--check') check = true;
    else if (arg === '--system') system = true;
    else if (arg === '--help') help = true;
    else if (arg === '--data-root') {
      dataRoot = args[++index];
      if (
        !dataRoot ||
        !isAbsolute(dataRoot) ||
        dataRoot.length > 4096 ||
        Array.from(dataRoot).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error(
          '--data-root requires an absolute directory without control characters.',
        );
    } else throw new Error(`Unknown browser setup option: ${arg}`);
  }
  if (system && !help && dataRoot === undefined)
    throw new Error(
      '--system requires an explicit --data-root matching the backend; sudo may reset its environment.',
    );
  if (check && system)
    throw new Error('--check and --system cannot be combined.');
  return { dataRoot: dataRoot ?? getElevenexDataRoot(), check, system, help };
}

async function verifyBrowser(
  executable: string,
  signal: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-browser-check-'));
  let context: BrowserContext | undefined;
  const abort = () => {
    void context?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const extension = await prepareWebAuthnExtension(directory);
    signal.throwIfAborted();
    try {
      context = await chromium.launchPersistentContext(
        join(directory, 'profile'),
        { ...browserLaunchOptions(extension), executablePath: executable },
      );
    } catch (error: unknown) {
      throw await diagnoseBrowserStartFailure(error, executable, signal);
    }
    signal.throwIfAborted();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent('<!doctype html><p>Elevenex browser host check</p>', {
      timeout: 5000,
    });
    await page.screenshot({ timeout: 5000 });
    return context.browser()?.version() ?? 'unknown';
  } finally {
    signal.removeEventListener('abort', abort);
    await context?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** This entry ships beside main.cjs and never imports/starts Nest, agents, the
 * database or listeners. System setup never downloads or runs a browser as root. */
export async function runBrowserSetup(
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const options = parseBrowserSetupArgs(args);
  if (options.help) {
    console.log(
      'Usage: browser-setup [--data-root /absolute/backend/data] [--check | --system]\nDefault: install the managed browser as the backend user and verify sandboxed rendering.\n--check: verify without installing anything.\n--system: explicit Linux administrator provisioning of libraries, fonts and a scoped AppArmor policy; never launches Chromium.\nRun the backend and verification as a non-root user.',
    );
    return;
  }
  process.env.ELEVENEX_DATA_ROOT = options.dataRoot;
  const cache = join(options.dataRoot, 'browser-runtime');
  const executable = managedBrowserExecutable(cache);
  if (options.system) {
    await provisionLinuxBrowserHost(executable, signal);
    console.log(
      'System provisioning completed. Verify sandboxed rendering as the backend user:\n' +
        browserSetupCommand(false, options.dataRoot) +
        ' --check',
    );
    return;
  }
  if (process.platform === 'linux' && process.getuid?.() === 0)
    throw new RuntimeBrowserStartError('root');
  try {
    await access(executable);
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
    if (options.check)
      throw new Error(
        'Managed Chromium is not installed. Run browser setup without --check as the backend user:\n' +
          browserSetupCommand(false, options.dataRoot),
      );
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await runHostStep(
      process.execPath,
      [playwrightInstaller(), 'install', '--no-shell', 'chromium'],
      signal,
      { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache },
    );
  }
  try {
    const version = await verifyBrowser(executable, signal);
    if (process.platform === 'linux' && !(await browserFontsAvailable(signal)))
      throw new RuntimeBrowserStartError('fonts');
    console.log(
      `Sandboxed Chromium ${version} launched and rendered successfully. Browser host is ready.`,
    );
  } catch (error: unknown) {
    if (
      error instanceof RuntimeBrowserStartError &&
      ['dependencies', 'fonts', 'apparmor'].includes(error.reason)
    ) {
      console.error(
        error.message +
          '\nSystem repair (administrator):\n' +
          browserSetupCommand(true, options.dataRoot),
      );
      throw new Error(
        'Browser host is not ready. Apply the indicated repair, then run --check as the backend user.',
      );
    }
    if (error instanceof RuntimeBrowserStartError && error.setupCommand)
      console.error(
        'Browser host diagnosis:\n' + error.setupCommand + ' --check',
      );
    throw error;
  }
}

if (require.main === module) {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  void runBrowserSetup(process.argv.slice(2), lifetime.signal)
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : 'Browser setup failed.',
      );
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    });
}

import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import { BACKEND_PORT, FRONTEND_PORT, TMP_DIR } from './environment';

const repoRoot = path.resolve(__dirname, '..', '..');
const electronAppDir = path.join(repoRoot, 'apps', 'electron');

/**
 * Chromium profile, window layout and settings for the test run.
 *
 * Isolated on purpose: without it the tests would open windows into — and
 * rewrite the saved layout of — the developer's real Elevenex installation.
 */
export const ELECTRON_USER_DATA_DIR = path.join(TMP_DIR, 'electron-user-data');

function resolveElectronBinary(): string {
  // `electron` is a devDependency of apps/electron, not of this package.
  const requireFromElectronApp = createRequire(path.join(electronAppDir, 'package.json'));
  return requireFromElectronApp('electron') as unknown as string;
}

export function resetElectronUserData(): void {
  rmSync(ELECTRON_USER_DATA_DIR, { recursive: true, force: true });
  mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true });
}

/**
 * Launches the desktop shell against the dev servers Playwright already boots,
 * so no runtime download or embedded backend spawn is involved.
 */
export async function launchElectronApp(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: resolveElectronBinary(),
    args: [electronAppDir],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_FRONTEND_URL: `http://127.0.0.1:${FRONTEND_PORT}`,
      ELECTRON_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      ELEVENEX_USER_DATA_DIR: ELECTRON_USER_DATA_DIR,
      // Keep the harvested-login-shell startup path from picking up whatever
      // the developer's rc files export.
      ELEVENEX_RESOLVING_ENV: '1',
    },
  });
}

/** The renderer's own window id, which namespaces its per-window state. */
export function readWindowId(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as {
    __ELEVENEX_RUNTIME__?: { windowId?: string };
  }).__ELEVENEX_RUNTIME__?.windowId ?? '');
}

export function openAnotherWindow(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as {
    __ELEVENEX_ELECTRON__: { windows: { openNew(): Promise<string> } };
  }).__ELEVENEX_ELECTRON__.windows.openNew());
}

export function listWindows(page: Page): Promise<{ windowId: string; label: string }[]> {
  return page.evaluate(() => (window as unknown as {
    __ELEVENEX_ELECTRON__: { windows: { list(): Promise<{ windowId: string; label: string }[]> } };
  }).__ELEVENEX_ELECTRON__.windows.list());
}

/** Waits until the app reports exactly `count` open windows. */
export async function waitForWindowCount(
  app: ElectronApplication,
  count: number,
  timeoutMs = 30_000,
): Promise<Page[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = app.windows().filter((page) => !page.isClosed());
    if (windows.length === count) {
      return windows;
    }
    if (Date.now() > deadline) {
      throw new Error(`Expected ${count} windows, saw ${windows.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

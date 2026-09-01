import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  launchElectronApp,
  listWindows,
  openAnotherWindow,
  readWindowId,
  resetElectronUserData,
  waitForWindowCount,
} from '../fixtures/electron-app';

/**
 * Multi-window mechanics in the real desktop shell.
 *
 * These run against a single local backend: the interesting cross-environment
 * case needs an SSH host, which CI has no way to provide. What is covered here
 * is everything that is environment-independent — window identity, isolation,
 * independent lifetimes and layout restore — with the cross-environment
 * scoping covered by the unit suites (scoped-storage, onboarding-state,
 * connection-registry).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

test('opens independent windows and restores them on relaunch', async () => {
  resetElectronUserData();

  app = await launchElectronApp();
  const [first] = await waitForWindowCount(app, 1);
  await first.waitForLoadState('domcontentloaded');

  const firstWindowId = await readWindowId(first);
  expect(firstWindowId).toMatch(/^w-/);

  await test.step('a second window is a separate window with its own id', async () => {
    await openAnotherWindow(first);
    const windows = await waitForWindowCount(app!, 2);

    const ids = await Promise.all(windows.map((page) => {
      return page.waitForLoadState('domcontentloaded').then(() => readWindowId(page));
    }));

    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(firstWindowId);
  });

  await test.step('both windows are visible to each other', async () => {
    const windows = app!.windows();
    const listed = await listWindows(windows[0]);
    expect(listed).toHaveLength(2);
  });

  await test.step('per-window state does not leak between windows', async () => {
    // localStorage is shared by every window (one Chromium profile), so this is
    // exactly the collision the window scoping exists to prevent.
    const [a, b] = app!.windows();
    const readScopedKeys = (page: typeof a) =>
      page.evaluate(() =>
        Object.keys(window.localStorage).filter((key) => key.includes('#win:')));

    await a.evaluate(() => window.localStorage.setItem('probe@local#win:' + (window as unknown as {
      __ELEVENEX_RUNTIME__: { windowId: string };
    }).__ELEVENEX_RUNTIME__.windowId, 'a'));
    await b.evaluate(() => window.localStorage.setItem('probe@local#win:' + (window as unknown as {
      __ELEVENEX_RUNTIME__: { windowId: string };
    }).__ELEVENEX_RUNTIME__.windowId, 'b'));

    const keys = await readScopedKeys(a);
    expect(keys.filter((key) => key.startsWith('probe@local'))).toHaveLength(2);
  });

  await test.step('closing one window leaves the other running', async () => {
    const windows = app!.windows();
    await windows[1].close();

    const remaining = await waitForWindowCount(app!, 1);
    expect(remaining).toHaveLength(1);
    expect(await readWindowId(remaining[0])).toBe(firstWindowId);
  });

  await test.step('the saved layout comes back on the next launch', async () => {
    // Reopen a second window, then quit with both open.
    await openAnotherWindow(app!.windows()[0]);
    await waitForWindowCount(app!, 2);

    await app!.close();
    app = await launchElectronApp();

    const restored = await waitForWindowCount(app, 2);
    expect(restored).toHaveLength(2);
  });
});

test('a window can be closed without taking the app down', async () => {
  resetElectronUserData();

  app = await launchElectronApp();
  const [first] = await waitForWindowCount(app, 1);
  await first.waitForLoadState('domcontentloaded');

  await openAnotherWindow(first);
  const windows = await waitForWindowCount(app, 2);
  await windows[1].close();

  await waitForWindowCount(app, 1);
  // Still responsive: the surviving window can still talk to the main process.
  expect(await listWindows(app.windows()[0])).toHaveLength(1);
});

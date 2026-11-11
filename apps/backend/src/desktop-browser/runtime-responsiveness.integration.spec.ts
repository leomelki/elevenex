import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';

jest.setTimeout(90000);

describe('browser responsiveness and explicit recovery', () => {
  let root: string,
    previousRoot: string | undefined,
    server: Server,
    url: string;
  let pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask,
    context: BrowserContext,
    page: Page,
    tabId: string;
  let started: (() => void) | undefined;
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const within = async <T>(operation: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Browser responsiveness deadline exceeded')),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-browser-responsive-'));
    previousRoot = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><title>Input fixture</title><input id="field">',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture unavailable');
    url = `http://127.0.0.1:${address.port}`;
    pool = new RuntimeBrowserPool();
    const acquire = pool.acquire.bind(pool);
    const launch = jest
      .spyOn(pool, 'acquire')
      .mockImplementation(async (...args) => {
        context = await acquire(...args);
        return context;
      });
    task = new RuntimeBrowserTask(1, pool, '7'.repeat(64));
    try {
      tabId = (await task.create('you', null, url)).id;
    } finally {
      launch.mockRestore();
    }
    const opened = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url));
    if (!opened) throw new Error('Fixture page unavailable');
    page = opened;
    await page.exposeBinding('__responsivenessBusy', () => started?.());
    await task.layout(800, 600, true, true);
  });

  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (previousRoot === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('does not reapply unchanged system media on detached layout heartbeats', async () => {
    const emulate = jest.spyOn(page, 'emulateMedia');
    try {
      await task.layoutTab(tabId, 800, 600, true, true, 1, 'light');
      const applied = emulate.mock.calls.length;
      for (let n = 0; n < 4; n++)
        await task.layoutTab(tabId, 800, 600, true, true, 1, 'light');
      expect(emulate.mock.calls.length).toBe(applied);
      await task.layoutTab(tabId, 800, 600, true, true, 1, 'dark');
      expect(emulate).toHaveBeenLastCalledWith({ colorScheme: 'dark' });
    } finally {
      emulate.mockRestore();
      await task.layoutTab(tabId, 800, 600, false, false, 1, 'light', false);
      await task.layout(800, 600, true, true);
    }
  });

  it('selects a new tab while the previous page still holds an input receipt', async () => {
    let began!: () => void;
    const beganPromise = new Promise<void>((resolve) => {
      began = resolve;
    });
    started = began;
    const finished = page.evaluate(() => {
      const notify: unknown = Reflect.get(window, '__responsivenessBusy');
      if (typeof notify === 'function') Reflect.apply(notify, window, []);
      const end = performance.now() + 2000;
      while (performance.now() < end) {
        /* Block input acknowledgments. */
      }
    });
    await beganPromise;
    const input = task
      .input(tabId, task.page(tabId).generation, {
        kind: 'key',
        type: 'down',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        modifiers: 0,
      })
      .catch(() => undefined);
    await delay(50);
    try {
      const selected = await within(task.command({ kind: 'new-tab' }), 1000);
      expect(selected.active).not.toBe(tabId);
      expect(page.isClosed()).toBe(false);
    } finally {
      await finished;
      await input;
      await task.command({ kind: 'select', tabId });
      await task.layout(800, 600, true, true);
    }
  });

  it('coalesces explicit recovery, replaces the old engine and never replays queued text into the new document', async () => {
    const old = page;
    let began!: () => void;
    const beganPromise = new Promise<void>((resolve) => {
      began = resolve;
    });
    started = began;
    const finished = old
      .evaluate(() => {
        const notify: unknown = Reflect.get(window, '__responsivenessBusy');
        if (typeof notify === 'function') Reflect.apply(notify, window, []);
        while (true) {
          /* Only closing this target can end this fixture. */
        }
      })
      .catch(() => undefined);
    await beganPromise;
    const writing = task
      .input(tabId, task.page(tabId).generation, {
        kind: 'text',
        text: 'never replay',
      })
      .catch(() => undefined);
    await delay(50);
    try {
      await within(
        Promise.all([
          task.command({ kind: 'recover', tabId }),
          task.command({ kind: 'recover', tabId }),
        ]),
        10000,
      );
      const replacement = context
        .pages()
        .filter((candidate) => candidate.url().startsWith(url));
      expect(replacement).toHaveLength(1);
      page = replacement[0];
      expect(old.isClosed()).toBe(true);
      expect(task.state().active).toBe(tabId);
      expect(task.page(tabId).ready).toBe(true);
      expect(await page.locator('#field').inputValue()).toBe('');
      expect(task.state().canRecover).toBe(true);
    } finally {
      if (!old.isClosed()) {
        const cdp = await context.newCDPSession(old);
        await cdp.send('Runtime.terminateExecution');
        await cdp.detach();
      }
      await finished;
      await writing;
    }
  });
});

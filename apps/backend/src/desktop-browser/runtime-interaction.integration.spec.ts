import type { BrowserContext, Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { RuntimeBrowserInput } from './runtime-input.js';

jest.setTimeout(90000);
describe('remote browser interaction and display ownership', () => {
  let directory: string,
    previous: string | undefined,
    server: Server,
    url: string;
  let pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask,
    page: Page,
    context: BrowserContext;
  let tabId: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elevenex-browser-interaction-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = directory;
    server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><input id="field"><script>window.documentIdentity=crypto.randomUUID()</script>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture listener unavailable');
    url = `http://127.0.0.1:${address.port}`;
    pool = new RuntimeBrowserPool();
    const acquire = pool.acquire.bind(pool);
    const launch = jest
      .spyOn(pool, 'acquire')
      .mockImplementation(async (...args) => {
        context = await acquire(...args);
        return context;
      });
    task = new RuntimeBrowserTask(1, pool, 'e'.repeat(64));
    const tab = await task.create('you', null, url);
    tabId = tab.id;
    launch.mockRestore();
    const opened = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url));
    if (!opened) throw new Error('Task page unavailable');
    page = opened;
    await task.layout(800, 600, true, true);
  });
  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it('reloads fragment locations and produces frames for the current document epoch', async () => {
    await page.evaluate(() => history.replaceState(null, '', '#anchor'));
    const identity = await page.evaluate('window.documentIdentity');
    await task.command({ kind: 'reload', tabId });
    expect(await page.evaluate('window.documentIdentity')).not.toBe(identity);
    const tab = task.page(tabId),
      signal = new AbortController().signal;
    const first = await tab.nextFrame(0, signal, 5000, true);
    expect(first?.displayEpoch).toBe(tab.displayEpoch);
    await task.command({ kind: 'navigate', tabId, url: url + '/second' });
    const next = await tab.nextFrame(0, signal, 5000, true);
    expect(next).not.toBeNull();
    expect(next?.displayEpoch).toBe(tab.displayEpoch);
    expect(next!.displayEpoch).toBeGreaterThan(first!.displayEpoch!);
    expect(next!.sequence).toBeGreaterThan(first!.sequence);
  });

  it('serializes pipelined whole batches without broadcasting unchanged state', async () => {
    await page.locator('#field').focus();
    const revision = task.state().revision,
      generation = task.page(tabId).generation;
    const text = (value: string) => ({ kind: 'text' as const, text: value });
    await Promise.all([
      task.input(tabId, generation, {
        kind: 'batch',
        events: [text('a'), text('b')],
      }),
      task.input(tabId, generation, {
        kind: 'batch',
        events: [text('c'), text('d')],
      }),
    ]);
    expect(await page.locator('#field').inputValue()).toBe('abcd');
    expect(task.state().revision).toBe(revision);
  });

  it('rejects queued input after hiding and showing the same document', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = jest.spyOn(RuntimeBrowserInput.prototype, 'dispatch');
    const original = dispatch.getMockImplementation();
    if (!original) throw new Error('Input fixture delegate unavailable');
    dispatch.mockImplementationOnce(async function (
      this: RuntimeBrowserInput,
      input,
      current,
    ) {
      await held;
      return original.call(this, input, current);
    });
    const generation = task.page(tabId).generation;
    const first = task.input(tabId, generation, {
      kind: 'text',
      text: 'stale',
    });
    const second = task.input(tabId, generation, {
      kind: 'text',
      text: 'queued',
    });
    const results = Promise.allSettled([first, second]);
    while (!dispatch.mock.calls.length)
      await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await task.layout(800, 600, false);
      await task.layout(800, 600, true, true);
      release();
      expect((await results).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(await page.locator('#field').inputValue()).toBe('abcd');
    } finally {
      release();
      dispatch.mockRestore();
    }
  });

  it('attributes a background popup to its opener without changing another tab', async () => {
    const other = await task.create('you', null, '');
    const opening = context.waitForEvent('page');
    await page.evaluate(() => {
      window.open('/popup');
    });
    const popup = await opening;
    if (!popup.isClosed()) await popup.waitForEvent('close');
    expect(task.page(tabId).driver).toBe('needs');
    expect(other.driver).toBe('you');
    expect(task.state().attention).toMatchObject({
      kind: 'popup',
      tabId,
      outside: true,
    });
    const orphanOpening = context.waitForEvent('page');
    await page.evaluate(() => {
      window.open('/popup', '_blank', 'noopener');
    });
    const orphan = await orphanOpening;
    task.sweep();
    if (!orphan.isClosed()) await orphan.waitForEvent('close');
    expect(other.driver).toBe('you');
    expect(task.state().attention?.outside).toBe(false);
  });
});

it('acknowledges layout while a task-owned engine is still starting', async () => {
  const pool = new RuntimeBrowserPool();
  let reject!: (error: Error) => void;
  const opening = new Promise<BrowserContext>((_resolve, no) => {
    reject = no;
  });
  const acquire = jest.spyOn(pool, 'acquire').mockReturnValue(opening);
  const task = new RuntimeBrowserTask(1, pool, 'f'.repeat(64));
  task.restore({
    active: 0,
    tabs: [
      {
        url: 'https://example.com',
        width: 'full',
        by: 'you',
        agentSessionId: null,
      },
    ],
  });
  try {
    await task.layout(800, 600, true, true);
    while (!acquire.mock.calls.length)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(task.state().tabs[0].loading).toBe(true);
  } finally {
    reject(new Error('Stopped fixture startup'));
    await task.destroy();
    await pool.onModuleDestroy();
    acquire.mockRestore();
  }
});

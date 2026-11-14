import type { BrowserContext, Page } from 'playwright-core';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { RuntimeBrowserInput } from './runtime-input.js';

jest.setTimeout(90000);
describe('remote browser document and in-page navigation', () => {
  let directory: string,
    previous: string | undefined,
    server: Server,
    url: string;
  let pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask,
    context: BrowserContext,
    page: Page,
    tabId: string;
  let panelRequested: () => void = () => undefined;
  const pending = new Set<ServerResponse>();
  const waitForState = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  };
  const pointer = (type: 'move' | 'down' | 'up', x: number, y: number) => ({
    kind: 'pointer' as const,
    type,
    x,
    y,
    button: type === 'move' ? ('none' as const) : ('left' as const),
    buttons: type === 'down' ? 1 : 0,
    clicks: type === 'move' ? 0 : 1,
    modifiers: 0,
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elevenex-browser-navigation-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = directory;
    server = createServer((request, response) => {
      if (request.url === '/panel-data') {
        pending.add(response);
        response.once('close', () => pending.delete(response));
        panelRequested();
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Panel navigation</title>
        <style>#open{position:absolute;left:20px;top:20px;width:200px;height:100px;cursor:pointer}
        #panel{position:absolute;left:300px;top:20px}#field,#close{display:block;width:200px;height:60px}#close{cursor:crosshair}</style>
        <button id="open" onpointerdown="history.pushState(null,'','?panel=open');document.querySelector('#panel').hidden=false;fetch('/panel-data').then(()=>document.querySelector('#status').textContent='Loaded')">Open panel</button>
        <aside id="panel" hidden><p id="status">Loading data…</p><input id="field"><button id="close" onclick="this.dataset.clicked='yes'">Close panel</button></aside>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
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
    task = new RuntimeBrowserTask(1, pool, '9'.repeat(64));
    try {
      tabId = (await task.create('you', null, url)).id;
    } finally {
      launch.mockRestore();
    }
    const opened = context
      .pages()
      .find((candidate) => candidate.url().startsWith(url));
    if (!opened) throw new Error('Task page unavailable');
    page = opened;
  });
  beforeEach(async () => {
    await task.command({ kind: 'navigate', tabId, url });
    await task.layout(800, 600, true, true);
    await waitForState(
      () => task.page(tabId).snapshot().title === 'Panel navigation',
    );
  });
  afterEach(() => {
    panelRequested = () => undefined;
    for (const response of pending) response.end('ready');
    pending.clear();
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

  it('keeps clicks, cursor updates and typing active while a URL-backed panel fetches data', async () => {
    const tab = task.page(tabId),
      generation = tab.generation,
      displayEpoch = tab.displayEpoch;
    const requested = new Promise<void>((resolve) => {
      panelRequested = resolve;
    });
    await task.input(tabId, generation, {
      kind: 'batch',
      events: [pointer('down', 100, 60), pointer('up', 100, 60)],
    });
    await requested;
    expect(tab.snapshot()).toMatchObject({
      generation,
      displayEpoch,
      url: url + '/?panel=open',
      loading: false,
      ready: true,
    });
    expect(await page.locator('#status').textContent()).toBe('Loading data…');
    const close = await page.locator('#close').boundingBox();
    if (!close) throw new Error('Panel control unavailable');
    await task.input(
      tabId,
      generation,
      pointer('move', close.x + 10, close.y + 10),
    );
    await waitForState(() => tab.snapshot().cursor === 'crosshair');
    await task.input(tabId, generation, {
      kind: 'batch',
      events: [
        pointer('down', close.x + 10, close.y + 10),
        pointer('up', close.x + 10, close.y + 10),
      ],
    });
    expect(await page.locator('#close').getAttribute('data-clicked')).toBe(
      'yes',
    );
    const field = await page.locator('#field').boundingBox();
    if (!field) throw new Error('Panel input unavailable');
    await task.input(tabId, generation, {
      kind: 'batch',
      events: [
        pointer('down', field.x + 10, field.y + 10),
        pointer('up', field.x + 10, field.y + 10),
        { kind: 'text', text: 'before loading finishes' },
      ],
    });
    expect(await page.locator('#field').inputValue()).toBe(
      'before loading finishes',
    );
    expect(await page.locator('#status').textContent()).toBe('Loading data…');
    expect(pending.size).toBe(1);
  });

  it('retains human input and the display epoch across history updates, fragments and back navigation', async () => {
    const tab = task.page(tabId),
      generation = tab.generation,
      displayEpoch = tab.displayEpoch;
    await page.evaluate(() => {
      history.pushState(null, '', '?panel=one');
      history.replaceState(null, '', '?panel=two');
      location.hash = 'details';
    });
    await page.waitForURL(url + '/?panel=two#details');
    await waitForState(() => tab.url === url + '/?panel=two#details');
    expect(tab.snapshot()).toMatchObject({
      generation,
      displayEpoch,
      url: url + '/?panel=two#details',
      title: 'Panel navigation',
    });
    await page.goBack();
    await page.waitForURL(url + '/?panel=two');
    await waitForState(() => tab.url === url + '/?panel=two');
    expect(tab.snapshot()).toMatchObject({
      generation,
      displayEpoch,
      url: url + '/?panel=two',
    });
    await task.input(tabId, generation, pointer('move', 100, 60));
    await waitForState(() => tab.snapshot().cursor === 'pointer');
  });

  it('delivers panel gestures and subsequent typing without waiting for cursor inspection', async () => {
    const tab = task.page(tabId),
      generation = tab.generation;
    // A slow page can delay style/hit-test evaluation independently of native
    // input. Hold that read to prove it cannot hold mouse-up or the next batch.
    let finish!: (cursor: string) => void;
    const held = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const evaluate = jest
      .spyOn(page, 'evaluate')
      .mockImplementationOnce(() => held);
    const first = task.input(tabId, generation, {
      kind: 'batch',
      events: [pointer('down', 100, 60), pointer('up', 100, 60)],
    });
    const next = task.input(tabId, generation, {
      kind: 'batch',
      events: [
        pointer('down', 320, 90),
        pointer('up', 320, 90),
        { kind: 'text', text: 'responsive' },
      ],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = Promise.all([first, next]).then(() => true);
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      });
      expect(await Promise.race([finished, timedOut])).toBe(true);
      expect(await page.locator('#field').inputValue()).toBe('responsive');
      await waitForState(() => evaluate.mock.calls.length > 0);
      // This cursor result belongs to a retired document and must be ignored.
      await task.command({
        kind: 'navigate',
        tabId,
        url: url + '/replacement',
      });
      finish('crosshair');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(tab.snapshot().cursor).toBe('default');
    } finally {
      clearTimeout(timer);
      finish('crosshair');
      await Promise.allSettled([first, next]);
      evaluate.mockRestore();
    }
  });

  it('still invalidates agent authority when an in-page route changes', async () => {
    const tab = task.page(tabId);
    tab.handoff(2);
    const generation = tab.generation,
      displayEpoch = tab.displayEpoch;
    try {
      await page.evaluate(() => history.pushState(null, '', '?panel=agent'));
      await page.waitForURL(url + '/?panel=agent');
      await waitForState(() => tab.url === url + '/?panel=agent');
      expect(tab.generation).toBeGreaterThan(generation);
      expect(tab.displayEpoch).toBe(displayEpoch);
      expect(() => tab.assertAgent(generation, 2)).toThrow(
        'Browser control changed',
      );
    } finally {
      tab.takeover();
    }
  });

  it('rejects in-flight and queued human input after a real document replacement', async () => {
    const tab = task.page(tabId),
      generation = tab.generation,
      displayEpoch = tab.displayEpoch;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const dispatch = jest.spyOn(RuntimeBrowserInput.prototype, 'dispatch');
    const original = dispatch.getMockImplementation();
    if (!original) throw new Error('Input fixture delegate unavailable');
    dispatch.mockImplementationOnce(async function (
      this: RuntimeBrowserInput,
      input,
      current,
    ) {
      entered();
      await held;
      return original.call(this, input, current);
    });
    const first = task.input(tabId, generation, {
      kind: 'text',
      text: 'stale',
    });
    const second = task.input(tabId, generation, {
      kind: 'text',
      text: 'queued',
    });
    const results = Promise.allSettled([first, second]);
    try {
      await started;
      await task.command({
        kind: 'navigate',
        tabId,
        url: url + '/replacement',
      });
      expect(tab.generation).toBeGreaterThan(generation);
      expect(tab.displayEpoch).toBeGreaterThan(displayEpoch);
      release();
      expect((await results).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      await expect(
        task.input(tabId, generation, pointer('down', 100, 60)),
      ).rejects.toThrow('Browser control changed');
      expect(await page.locator('#field').inputValue()).toBe('');
    } finally {
      release();
      await results;
      dispatch.mockRestore();
    }
  });
});
